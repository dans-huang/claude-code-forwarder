#!/usr/bin/env python3
"""
Claude Code Forwarder — menu bar status app.

A tiny macOS menu bar item that polls the forwarder webhook and shows
whether forwarded Claude Code jobs are running in the background.
No interaction with the sessions themselves — just visibility + a
terminate button.

Menu bar states:
  ✳        idle, nothing running
  ✳ 2      2 jobs running
  ✳ 2 ⚠1   2 running, 1 recent error
  ✳ ⚠1     idle, 1 recent error
  ✳ ⌁      webhook unreachable

Usage:
  pip install -r requirements.txt
  python claude_forwarder_menubar.py
"""

import json
import os
import subprocess
import time
import urllib.request

import rumps

PORT = int(os.environ.get("PORT", 5581))
BASE_URL = f"http://127.0.0.1:{PORT}"
POLL_SECONDS = 3


def fetch_status():
    try:
        with urllib.request.urlopen(f"{BASE_URL}/status", timeout=2) as r:
            return json.loads(r.read())
    except Exception:
        return None


def post(path):
    try:
        req = urllib.request.Request(f"{BASE_URL}{path}", method="POST")
        with urllib.request.urlopen(req, timeout=5) as r:
            return json.loads(r.read())
    except Exception:
        return None


def fmt_duration(seconds):
    seconds = int(seconds)
    if seconds < 60:
        return f"{seconds}s"
    if seconds < 3600:
        return f"{seconds // 60}m {seconds % 60:02d}s"
    return f"{seconds // 3600}h {(seconds % 3600) // 60:02d}m"


def fmt_clock(ts):
    return time.strftime("%H:%M", time.localtime(ts))


def job_label(job):
    subject = (job.get("subject") or "").replace("\n", " ").strip()
    if len(subject) > 44:
        subject = subject[:44] + "…"
    return subject or job.get("session_name", job.get("job_id", "?"))


class ForwarderMenuBar(rumps.App):
    def __init__(self):
        super().__init__(
            "ClaudeForwarder", title="✳", quit_button=None
        )
        self._last_render = None
        self.timer = rumps.Timer(self.refresh, POLL_SECONDS)
        self.timer.start()
        self.refresh(None)

    def refresh(self, _):
        status = fetch_status()
        # Skip pointless menu rebuilds when nothing changed; while jobs run,
        # refresh once a minute anyway so elapsed times stay current
        fingerprint = json.dumps(status, sort_keys=True) if status else "offline"
        if status and status.get("running"):
            fingerprint += f"|{int(time.time() // 60)}"
        if fingerprint == self._last_render:
            return
        self._last_render = fingerprint

        if status is None:
            self.title = "✳ ⌁"
            self.menu.clear()
            self.menu = [
                rumps.MenuItem("Webhook offline (localhost:%d)" % PORT),
                rumps.MenuItem("Open webhook log", callback=self.open_webhook_log),
                None,
                rumps.MenuItem("Quit", callback=rumps.quit_application),
            ]
            return

        running = status.get("running", [])
        finished = status.get("finished", [])
        errors = [j for j in finished if j["status"] == "error"]

        title = "✳"
        if running:
            title += f" {len(running)}"
        if errors:
            title += f" ⚠{len(errors)}"
        self.title = title

        items = []
        now = time.time()

        if not running and not finished:
            items.append(rumps.MenuItem("No forwarded jobs"))

        if running:
            items.append(rumps.MenuItem(f"Running ({len(running)})"))
            for job in running:
                elapsed = fmt_duration(now - (job.get("started_at") or now))
                mi = rumps.MenuItem(f"▶ {job_label(job)} — {elapsed}")
                mi.add(rumps.MenuItem(
                    "Terminate",
                    callback=self._terminate_cb(job["job_id"], job_label(job)),
                ))
                mi.add(rumps.MenuItem(
                    "View log",
                    callback=self._viewlog_cb(job.get("log_path")),
                ))
                items.append(mi)

        if finished:
            if running:
                items.append(None)
            items.append(rumps.MenuItem("Finished"))
            for job in finished[:10]:
                mark = {"done": "✓", "error": "✕", "terminated": "◼"}.get(
                    job["status"], "•"
                )
                ended = fmt_clock(job.get("ended_at", now))
                line = f"{mark} {job_label(job)} — {job['status']} {ended}"
                if job["status"] == "error" and job.get("exit_code") is not None:
                    line += f" (exit {job['exit_code']})"
                mi = rumps.MenuItem(line)
                mi.add(rumps.MenuItem(
                    "View log",
                    callback=self._viewlog_cb(job.get("log_path")),
                ))
                items.append(mi)
            items.append(rumps.MenuItem("Clear finished", callback=self.clear_finished))

        items.append(None)
        items.append(rumps.MenuItem("Open webhook log", callback=self.open_webhook_log))
        items.append(rumps.MenuItem("Quit", callback=rumps.quit_application))

        self.menu.clear()
        self.menu = items

    def _terminate_cb(self, job_id, label):
        def cb(_):
            post(f"/terminate/{job_id}")
            self._last_render = None  # force re-render on next tick
            self.refresh(None)
        return cb

    def _viewlog_cb(self, log_path):
        def cb(_):
            if log_path and os.path.exists(log_path):
                subprocess.run(["open", "-a", "Console", log_path])
            else:
                rumps.notification(
                    "Claude Forwarder", "", "No log file for this job yet."
                )
        return cb

    def clear_finished(self, _):
        post("/clear-finished")
        self._last_render = None
        self.refresh(None)

    def open_webhook_log(self, _):
        log = "/tmp/claude-forwarder-webhook.log"
        if os.path.exists(log):
            subprocess.run(["open", "-a", "Console", log])


if __name__ == "__main__":
    ForwarderMenuBar().run()
