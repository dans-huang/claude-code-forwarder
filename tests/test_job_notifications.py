import importlib.util
import threading
import time
import unittest
from pathlib import Path
from unittest import mock


MODULE_PATH = (
    Path(__file__).resolve().parents[1]
    / "webhook"
    / "claude_forwarder_webhook.py"
)
SPEC = importlib.util.spec_from_file_location("claude_forwarder_webhook", MODULE_PATH)
forwarder = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(forwarder)


class JobFinishNotificationTests(unittest.TestCase):
    """Background jobs replaced the menu bar poller with a finish notification."""

    def setUp(self):
        self.old_notify = forwarder.NOTIFY_ON_FINISH
        forwarder.NOTIFY_ON_FINISH = True
        forwarder.active_jobs.clear()
        forwarder.queued_jobs.clear()
        forwarder.queue_order.clear()
        forwarder.finished_jobs.clear()

    def tearDown(self):
        forwarder.NOTIFY_ON_FINISH = self.old_notify

    def job(self, **extra):
        return {
            "source": "slack",
            "subject": "Weekly sync",
            "session_name": "fwd-slack-abc12345",
            "status": "done",
            **extra,
        }

    def test_notification_is_posted_without_a_shell_or_interpolation(self):
        with mock.patch.object(forwarder.subprocess, "Popen") as popen:
            forwarder.notify_job_finished(self.job())
        popen.assert_called_once()
        args, kwargs = popen.call_args
        argv = args[0]
        self.assertIsInstance(argv, list)
        self.assertEqual(argv[0], "osascript")
        # No shell, and the job text is argv, never spliced into the script.
        self.assertNotIn("shell", kwargs)
        self.assertFalse(kwargs.get("shell", False))
        script = " ".join(argv[1:-3])
        self.assertNotIn("Weekly sync", script)
        # title, then subject as subtitle, then session name as body
        self.assertEqual(argv[-3], "Forwarded job done")
        self.assertEqual(argv[-2], "Weekly sync")
        self.assertEqual(argv[-1], "fwd-slack-abc12345")

    def test_hostile_subject_text_stays_an_argument(self):
        nasty = '"; rm -rf ~; display dialog "pwned'
        with mock.patch.object(forwarder.subprocess, "Popen") as popen:
            forwarder.notify_job_finished(self.job(subject=nasty))
        argv = popen.call_args[0][0]
        self.assertIn(nasty, argv)
        self.assertNotIn("rm -rf", " ".join(argv[1:5]))

    def test_status_selects_the_title(self):
        for status, title in (
            ("done", "Forwarded job done"),
            ("error", "Forwarded job failed"),
            ("terminated", "Forwarded job terminated"),
        ):
            with mock.patch.object(forwarder.subprocess, "Popen") as popen:
                forwarder.notify_job_finished(self.job(status=status))
            self.assertEqual(popen.call_args[0][0][-3], title)

    def test_long_subject_is_truncated(self):
        with mock.patch.object(forwarder.subprocess, "Popen") as popen:
            forwarder.notify_job_finished(self.job(subject="x" * 400))
        self.assertLessEqual(len(popen.call_args[0][0][-2]), 90)

    def test_notifications_can_be_disabled(self):
        forwarder.NOTIFY_ON_FINISH = False
        with mock.patch.object(forwarder.subprocess, "Popen") as popen:
            forwarder.notify_job_finished(self.job())
        popen.assert_not_called()

    def test_notification_failure_never_breaks_bookkeeping(self):
        with mock.patch.object(
            forwarder.subprocess, "Popen", side_effect=OSError("no osascript")
        ):
            forwarder.notify_job_finished(self.job())  # must not raise

    def test_finished_job_triggers_exactly_one_notification(self):
        forwarder.active_jobs["abc12345"] = self.job(status="running")
        with mock.patch.object(forwarder, "tmux_session_alive", return_value=False), \
             mock.patch.object(forwarder, "notify_job_finished") as notify:
            forwarder.refresh_jobs()
            forwarder.refresh_jobs()  # second sweep must not re-notify
        notify.assert_called_once()
        self.assertEqual(notify.call_args[0][0]["status"], "error")  # no .exit file
        self.assertIn("abc12345", forwarder.finished_jobs)


class JobSweeperTests(unittest.TestCase):
    """The webhook must advance jobs on its own now that nothing polls it.

    Before 1.7.0 the menu bar app's /status poll was what drove
    refresh_jobs(). Without a sweeper a finished job goes unnoticed and a
    queued job never starts until some unrelated request arrives.
    """

    def setUp(self):
        forwarder.active_jobs.clear()
        forwarder.queued_jobs.clear()
        forwarder.queue_order.clear()
        forwarder.finished_jobs.clear()

    def test_sweeper_finishes_jobs_without_any_incoming_request(self):
        forwarder.active_jobs["abc12345"] = {
            "source": "web",
            "subject": "Unattended job",
            "session_name": "fwd-web-abc12345",
            "status": "running",
        }
        stop = threading.Event()
        with mock.patch.object(forwarder, "tmux_session_alive", return_value=False), \
             mock.patch.object(forwarder, "notify_job_finished") as notify:
            thread = threading.Thread(
                target=forwarder.sweep_jobs_forever,
                kwargs={"interval": 0.01, "stop_event": stop},
                daemon=True,
            )
            thread.start()
            deadline = time.time() + 2
            while time.time() < deadline and "abc12345" not in forwarder.finished_jobs:
                time.sleep(0.01)
            stop.set()
            thread.join(timeout=2)
        self.assertIn("abc12345", forwarder.finished_jobs)
        notify.assert_called_once()

    def test_sweeper_launches_a_queued_job_when_a_slot_frees(self):
        forwarder.active_jobs["running1"] = {
            "source": "web",
            "session_name": "fwd-web-running1",
            "status": "running",
        }
        forwarder.queued_jobs["queued1"] = {
            "source": "web",
            "session_name": "fwd-web-queued1",
            "status": "queued",
            "prompt": "do the thing",
        }
        forwarder.queue_order.append("queued1")
        stop = threading.Event()
        # Only the already-running job has exited; the promoted one stays up,
        # otherwise the next sweep tick would immediately finish it again.
        def alive(session_name):
            return session_name != "fwd-web-running1"

        with mock.patch.object(forwarder, "tmux_session_alive", side_effect=alive), \
             mock.patch.object(forwarder, "notify_job_finished"), \
             mock.patch.object(forwarder, "launch_in_tmux") as launch:
            thread = threading.Thread(
                target=forwarder.sweep_jobs_forever,
                kwargs={"interval": 0.01, "stop_event": stop},
                daemon=True,
            )
            thread.start()
            deadline = time.time() + 2
            while time.time() < deadline and "queued1" not in forwarder.active_jobs:
                time.sleep(0.01)
            stop.set()
            thread.join(timeout=2)
        launch.assert_called_once()
        self.assertIn("queued1", forwarder.active_jobs)
        self.assertNotIn("queued1", forwarder.queued_jobs)

    def test_sweeper_survives_a_failing_sweep(self):
        forwarder.active_jobs["boom"] = {
            "source": "web",
            "session_name": "fwd-web-boom",
            "status": "running",
        }
        stop = threading.Event()
        calls = []

        def exploding_refresh():
            calls.append(1)
            raise RuntimeError("tmux exploded")

        with mock.patch.object(forwarder, "refresh_jobs", exploding_refresh):
            thread = threading.Thread(
                target=forwarder.sweep_jobs_forever,
                kwargs={"interval": 0.01, "stop_event": stop},
                daemon=True,
            )
            thread.start()
            deadline = time.time() + 2
            while time.time() < deadline and len(calls) < 3:
                time.sleep(0.01)
            stop.set()
            thread.join(timeout=2)
        self.assertGreaterEqual(len(calls), 3, "thread died on the first failure")

    def test_idle_sweeper_does_no_work(self):
        stop = threading.Event()
        with mock.patch.object(forwarder, "refresh_jobs") as refresh:
            thread = threading.Thread(
                target=forwarder.sweep_jobs_forever,
                kwargs={"interval": 0.01, "stop_event": stop},
                daemon=True,
            )
            thread.start()
            time.sleep(0.2)
            stop.set()
            thread.join(timeout=2)
        refresh.assert_not_called()


if __name__ == "__main__":
    unittest.main()
