import importlib.util
import os
import stat
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock
from urllib.parse import parse_qs, urlparse


MODULE_PATH = (
    Path(__file__).resolve().parents[1]
    / "webhook"
    / "claude_forwarder_webhook.py"
)
SPEC = importlib.util.spec_from_file_location("claude_forwarder_webhook", MODULE_PATH)
forwarder = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(forwarder)


class DesktopForwardingTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.workspace = os.path.join(self.temp_dir.name, "workspace")
        self.packets = os.path.join(self.temp_dir.name, "packets")
        os.mkdir(self.workspace)
        self.old_packets_dir = forwarder.PACKETS_DIR
        self.old_workspace = forwarder.WORKSPACE_DIR
        self.old_ttl = forwarder.PACKET_TTL_DAYS
        forwarder.PACKETS_DIR = self.packets
        forwarder.WORKSPACE_DIR = self.workspace
        forwarder.PACKET_TTL_DAYS = 30
        forwarder.active_jobs.clear()
        forwarder.queued_jobs.clear()
        forwarder.queue_order.clear()
        forwarder.finished_jobs.clear()

    def tearDown(self):
        forwarder.PACKETS_DIR = self.old_packets_dir
        forwarder.WORKSPACE_DIR = self.old_workspace
        forwarder.PACKET_TTL_DAYS = self.old_ttl
        self.temp_dir.cleanup()

    def payload(self):
        return {
            "source": "web",
            "url": "https://example.com/meeting",
            "subject": "Weekly sync",
            "instruction": "Identify next actions.",
            "extraction_method": "dom",
            "thread": [{"from": "Dans", "timestamp": "09:00", "body": "Ship it."}],
        }

    def test_codex_link_opens_new_session_with_workspace_and_packet_prompt(self):
        packet = "/tmp/a packet.md"
        link = forwarder.build_desktop_deep_link("codex", packet, self.workspace)
        parsed = urlparse(link)
        query = parse_qs(parsed.query)
        self.assertEqual(parsed.scheme, "codex")
        self.assertEqual(parsed.netloc, "new")
        self.assertEqual(query["path"], [self.workspace])
        self.assertIn(packet, query["prompt"][0])

    def test_claude_link_opens_new_code_session_with_workspace_and_packet_prompt(self):
        packet = "/tmp/a packet.md"
        link = forwarder.build_desktop_deep_link("claude", packet, self.workspace)
        parsed = urlparse(link)
        query = parse_qs(parsed.query)
        self.assertEqual(parsed.scheme, "claude")
        self.assertEqual(parsed.netloc, "code")
        self.assertEqual(parsed.path, "/new")
        self.assertEqual(query["folder"], [self.workspace])
        self.assertIn(packet, query["q"][0])

    def test_packet_is_private_and_preserves_full_context(self):
        prompt = forwarder.build_prompt(self.payload(), interactive=True)
        packet = forwarder.write_task_packet(self.payload(), prompt, "abc12345")
        self.assertEqual(stat.S_IMODE(os.stat(self.packets).st_mode), 0o700)
        self.assertEqual(stat.S_IMODE(os.stat(packet).st_mode), 0o600)
        content = Path(packet).read_text()
        self.assertIn("Identify next actions.", content)
        self.assertIn("Ship it.", content)
        self.assertIn("Work with Dans interactively", content)
        self.assertNotIn("You run headless", content)

    def test_desktop_forward_endpoint_opens_selected_app(self):
        client = forwarder.app.test_client()
        with mock.patch.object(forwarder, "open_desktop_session") as opener:
            response = client.post(
                "/forward",
                json={**self.payload(), "destination": "codex"},
            )
        self.assertEqual(response.status_code, 201)
        data = response.get_json()
        self.assertTrue(data["ok"])
        self.assertEqual(data["destination"], "codex")
        self.assertEqual(data["status"], "opened")
        self.assertTrue(os.path.isfile(data["packet_path"]))
        opener.assert_called_once_with("codex", data["packet_path"])

    def test_invalid_destination_is_rejected_without_launching(self):
        client = forwarder.app.test_client()
        with mock.patch.object(forwarder, "open_desktop_session") as opener:
            response = client.post(
                "/forward",
                json={**self.payload(), "destination": "unknown"},
            )
        self.assertEqual(response.status_code, 400)
        opener.assert_not_called()

    def test_web_pages_do_not_receive_cors_permission_for_local_forwarder(self):
        client = forwarder.app.test_client()
        response = client.options(
            "/forward",
            headers={
                "Origin": "https://malicious.example",
                "Access-Control-Request-Method": "POST",
            },
        )
        self.assertNotIn("Access-Control-Allow-Origin", response.headers)

    def test_long_context_stays_in_packet_not_deep_link(self):
        payload = self.payload()
        payload["thread"][0]["body"] = "x" * 100_000
        prompt = forwarder.build_prompt(payload, interactive=True)
        packet = forwarder.write_task_packet(payload, prompt, "longtask")
        link = forwarder.build_desktop_deep_link("claude", packet, self.workspace)
        self.assertLess(len(link), 2_000)
        self.assertGreater(os.path.getsize(packet), 100_000)

    def test_old_packets_are_pruned_but_unrelated_files_are_preserved(self):
        os.mkdir(self.packets, mode=0o700)
        old_packet = os.path.join(self.packets, "old.md")
        unrelated = os.path.join(self.packets, "keep.txt")
        Path(old_packet).write_text("old")
        Path(unrelated).write_text("keep")
        old_time = time.time() - (31 * 86400)
        os.utime(old_packet, (old_time, old_time))
        os.utime(unrelated, (old_time, old_time))

        forwarder.write_task_packet(self.payload(), "new", "fresh123")

        self.assertFalse(os.path.exists(old_packet))
        self.assertTrue(os.path.exists(unrelated))

    def test_legacy_request_defaults_to_background_queue(self):
        client = forwarder.app.test_client()
        fake_process = mock.Mock()
        with mock.patch.object(forwarder, "launch_in_tmux", return_value=fake_process) as launch:
            response = client.post("/forward", json={**self.payload(), "_test": True})
        self.assertEqual(response.status_code, 202)
        self.assertEqual(response.get_json()["status"], "running")
        launch.assert_called_once()


if __name__ == "__main__":
    unittest.main()
