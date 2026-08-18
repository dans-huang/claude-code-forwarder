import importlib.util
import os
import tempfile
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


class ProjectSelectionTests(unittest.TestCase):
    """Workspace validation, project discovery, and the /projects API."""

    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        # realpath: macOS tempdirs live under /var → /private/var symlink
        self.base = os.path.realpath(self.temp_dir.name)
        self.workspace = os.path.join(self.base, "claude")   # general workspace
        self.projects_root = os.path.join(self.workspace, "projects")
        self.repo_a = os.path.join(self.projects_root, "repo-a")
        self.repo_b = os.path.join(self.projects_root, "repo-b")
        self.outside = os.path.join(self.base, "outside")
        self.packets = os.path.join(self.base, "packets")
        for path in (self.workspace, self.projects_root, self.repo_a,
                     self.repo_b, self.outside):
            os.makedirs(path)
        os.mkdir(os.path.join(self.repo_a, ".git"))
        Path(self.repo_b, "CLAUDE.md").write_text("# repo-b")
        Path(self.outside, "secrets.txt").write_text("not a workspace root")

        self.old = {
            name: getattr(forwarder, name)
            for name in ("PACKETS_DIR", "WORKSPACE_DIR", "PROJECT_ROOTS",
                         "EXTRA_PROJECTS", "PACKET_TTL_DAYS")
        }
        forwarder.PACKETS_DIR = self.packets
        forwarder.WORKSPACE_DIR = self.workspace
        forwarder.PROJECT_ROOTS = [self.workspace]
        forwarder.EXTRA_PROJECTS = []
        forwarder.PACKET_TTL_DAYS = 30
        forwarder.active_jobs.clear()
        forwarder.queued_jobs.clear()
        forwarder.queue_order.clear()
        forwarder.finished_jobs.clear()

    def tearDown(self):
        for name, value in self.old.items():
            setattr(forwarder, name, value)
        self.temp_dir.cleanup()

    def payload(self, **extra):
        return {
            "source": "web",
            "url": "https://example.com/task",
            "subject": "Task",
            "instruction": "Do the thing.",
            "extraction_method": "dom",
            "thread": [{"from": "Dans", "timestamp": "09:00", "body": "Go."}],
            **extra,
        }

    # ── discovery ────────────────────────────────────────────────

    def test_discovery_finds_marked_projects_two_levels_deep(self):
        names = [p["name"] for p in forwarder.discover_projects()]
        self.assertEqual(names, ["repo-a", "repo-b"])

    def test_discovery_skips_hidden_vendor_and_unmarked_dirs(self):
        os.makedirs(os.path.join(self.projects_root, ".hidden", ".git"))
        os.makedirs(os.path.join(self.projects_root, "_archive", ".git"))
        os.makedirs(os.path.join(self.projects_root, "node_modules", ".git"))
        os.makedirs(os.path.join(self.projects_root, "plain-dir"))
        names = [p["name"] for p in forwarder.discover_projects()]
        self.assertEqual(names, ["repo-a", "repo-b"])

    def test_discovery_does_not_follow_symlinked_directories(self):
        os.symlink(self.outside, os.path.join(self.projects_root, "sneaky"))
        names = [p["name"] for p in forwarder.discover_projects()]
        self.assertNotIn("sneaky", names)
        self.assertNotIn("outside", names)

    def test_discovery_includes_configured_extra_projects(self):
        extra = os.path.join(self.base, "extra-repo")
        os.makedirs(extra)
        forwarder.EXTRA_PROJECTS = [extra]
        paths = [p["path"] for p in forwarder.discover_projects()]
        self.assertIn(extra, paths)

    def test_projects_endpoint_lists_general_and_projects_without_cors(self):
        client = forwarder.app.test_client()
        response = client.get(
            "/projects", headers={"Origin": "https://malicious.example"}
        )
        self.assertEqual(response.status_code, 200)
        data = response.get_json()
        self.assertEqual(data["general"]["path"], self.workspace)
        self.assertEqual(
            [p["path"] for p in data["projects"]], [self.repo_a, self.repo_b]
        )
        self.assertNotIn("Access-Control-Allow-Origin", response.headers)

    # ── validation ───────────────────────────────────────────────

    def test_missing_workspace_falls_back_to_general_workspace(self):
        self.assertEqual(forwarder.resolve_workspace(None), self.workspace)
        self.assertEqual(forwarder.resolve_workspace(""), self.workspace)
        self.assertEqual(forwarder.resolve_workspace("  "), self.workspace)

    def test_nonexistent_directory_is_rejected(self):
        with self.assertRaises(forwarder.WorkspaceValidationError):
            forwarder.resolve_workspace(os.path.join(self.base, "nope"))

    def test_workspace_outside_allowed_roots_is_rejected(self):
        with self.assertRaises(forwarder.WorkspaceValidationError):
            forwarder.resolve_workspace(self.outside)

    def test_traversal_cannot_escape_the_roots(self):
        sneaky = os.path.join(self.repo_a, "..", "..", "..", "outside")
        with self.assertRaises(forwarder.WorkspaceValidationError):
            forwarder.resolve_workspace(sneaky)

    def test_symlink_inside_root_cannot_escape_to_outside_target(self):
        link = os.path.join(self.projects_root, "escape")
        os.symlink(self.outside, link)
        with self.assertRaises(forwarder.WorkspaceValidationError):
            forwarder.resolve_workspace(link)

    def test_non_string_workspace_is_rejected(self):
        with self.assertRaises(forwarder.WorkspaceValidationError):
            forwarder.resolve_workspace(["/tmp"])

    def test_extra_project_outside_roots_is_allowed_exactly(self):
        extra = os.path.join(self.base, "approved")
        os.makedirs(os.path.join(extra, "sub"))
        forwarder.EXTRA_PROJECTS = [extra]
        self.assertEqual(forwarder.resolve_workspace(extra), extra)
        # exact approval does not extend to subdirectories
        with self.assertRaises(forwarder.WorkspaceValidationError):
            forwarder.resolve_workspace(os.path.join(extra, "sub"))

    def test_validate_endpoint_accepts_and_rejects(self):
        client = forwarder.app.test_client()
        ok = client.post("/projects/validate", json={"path": self.repo_a})
        self.assertEqual(ok.status_code, 200)
        self.assertEqual(ok.get_json()["path"], self.repo_a)
        self.assertEqual(ok.get_json()["name"], "repo-a")
        bad = client.post("/projects/validate", json={"path": self.outside})
        self.assertEqual(bad.status_code, 400)
        self.assertFalse(bad.get_json()["ok"])

    # ── forwarding with a workspace ──────────────────────────────

    def test_both_deep_links_carry_the_selected_workspace(self):
        packet = "/tmp/a packet.md"
        codex = forwarder.build_desktop_deep_link("codex", packet, self.repo_a)
        claude = forwarder.build_desktop_deep_link("claude", packet, self.repo_b)
        self.assertEqual(
            parse_qs(urlparse(codex).query)["path"], [self.repo_a]
        )
        self.assertEqual(
            parse_qs(urlparse(claude).query)["folder"], [self.repo_b]
        )

    def test_forward_opens_selected_project_and_reports_it(self):
        client = forwarder.app.test_client()
        with mock.patch.object(forwarder, "open_desktop_session") as opener:
            response = client.post(
                "/forward",
                json=self.payload(destination="codex", workspace=self.repo_a),
            )
        self.assertEqual(response.status_code, 201)
        data = response.get_json()
        self.assertEqual(data["workspace"], self.repo_a)
        opener.assert_called_once_with("codex", data["packet_path"], self.repo_a)
        packet_text = Path(data["packet_path"]).read_text()
        self.assertIn(f"- Workspace: `{self.repo_a}`", packet_text)

    def test_forward_with_invalid_workspace_is_rejected_before_opening(self):
        client = forwarder.app.test_client()
        for bad in (self.outside, os.path.join(self.base, "nope")):
            with mock.patch.object(forwarder, "open_desktop_session") as opener:
                response = client.post(
                    "/forward",
                    json=self.payload(destination="claude", workspace=bad),
                )
            self.assertEqual(response.status_code, 400)
            self.assertFalse(response.get_json()["ok"])
            opener.assert_not_called()

    def test_legacy_payload_without_workspace_uses_general_workspace(self):
        client = forwarder.app.test_client()
        with mock.patch.object(forwarder, "open_desktop_session") as opener:
            response = client.post(
                "/forward", json=self.payload(destination="claude")
            )
        self.assertEqual(response.status_code, 201)
        data = response.get_json()
        self.assertEqual(data["workspace"], self.workspace)
        opener.assert_called_once_with(
            "claude", data["packet_path"], self.workspace
        )

    def test_legacy_background_payload_still_queues(self):
        client = forwarder.app.test_client()
        fake_process = mock.Mock()
        with mock.patch.object(
            forwarder, "launch_in_tmux", return_value=fake_process
        ) as launch:
            response = client.post("/forward", json={**self.payload(), "_test": True})
        self.assertEqual(response.status_code, 202)
        self.assertEqual(response.get_json()["status"], "running")
        launch.assert_called_once()


if __name__ == "__main__":
    unittest.main()
