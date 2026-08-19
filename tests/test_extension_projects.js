// Service-worker project selector logic: list loading, auto resolution,
// memory persistence, payload correctness, and backend-unavailable fallback.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const GENERAL = { name: "General workspace", path: "/Users/dans/claude" };
const REPO_A = { name: "repo-a", path: "/Users/dans/claude/projects/repo-a" };
const REPO_B = { name: "repo-b", path: "/Users/dans/claude/projects/repo-b" };

let runtimeListener;
let storage = {};
let fetchLog = [];
let fetchHandler;

const context = {
  console,
  setTimeout,
  clearTimeout,
  URL,
  chrome: {
    runtime: {
      onMessage: {
        addListener(listener) {
          runtimeListener = listener;
        },
      },
    },
    commands: { onCommand: { addListener() {} } },
    tabs: { query: async () => [] },
    scripting: { executeScript: async () => [] },
    storage: {
      local: {
        get: async (key) => ({ [key]: storage[key] }),
        set: async (items) => Object.assign(storage, items),
      },
    },
  },
  fetch: (url, options) => {
    fetchLog.push({ url, options });
    return fetchHandler(url, options);
  },
};

const source = fs.readFileSync(
  path.join(__dirname, "..", "extension", "background.js"),
  "utf8",
);
vm.runInNewContext(source, context, { filename: "background.js" });

function healthyBackend(overrides = {}) {
  return async (url, options) => {
    if (url.endsWith("/projects")) {
      return {
        json: async () => ({
          ok: true,
          general: GENERAL,
          projects: [REPO_A, REPO_B],
        }),
      };
    }
    if (url.endsWith("/projects/validate")) {
      const requested = JSON.parse(options.body).path;
      if (overrides.validateOk === false) {
        return { json: async () => ({ ok: false, error: "outside roots" }) };
      }
      return {
        json: async () => ({
          ok: true,
          path: requested,
          name: requested.split("/").pop(),
        }),
      };
    }
    if (url.endsWith("/status")) {
      if (overrides.statusOk === false) throw new Error("ECONNREFUSED");
      return {
        json: async () => ({
          ok: true,
          active_jobs: overrides.running ?? 0,
          queued_jobs: overrides.queued ?? 0,
          error_jobs: overrides.errors ?? 0,
        }),
      };
    }
    if (url.endsWith("/forward")) {
      const body = JSON.parse(options.body);
      return {
        json: async () => ({
          ok: true,
          status: "opened",
          workspace: body.workspace || GENERAL.path,
        }),
      };
    }
    throw new Error(`unexpected fetch: ${url}`);
  };
}

// vm-context objects live in a different realm; JSON round-trip before deepEqual
function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

function sendMessage(message) {
  return new Promise((resolve, reject) => {
    const staysOpen = runtimeListener(message, {}, resolve);
    if (!staysOpen) reject(new Error("Message channel did not stay open"));
  });
}

async function main() {
  // ── pure memory logic ──────────────────────────────────────────
  const empty = context.normalizeProjectMemory(undefined);
  assert.deepEqual(plain(empty), { last: null, recents: [], byDomain: {} });

  let memory = context.applyProjectSelection(empty, {
    path: REPO_A.path,
    domain: "app.slack.com",
    explicit: true,
    generalPath: GENERAL.path,
  });
  assert.equal(memory.last, REPO_A.path);
  assert.deepEqual(plain(memory.recents), [REPO_A.path]);
  assert.equal(memory.byDomain["app.slack.com"], REPO_A.path);

  // auto (non-explicit) forwards update recents but never the site mapping
  memory = context.applyProjectSelection(memory, {
    path: REPO_B.path,
    domain: "mail.google.com",
    explicit: false,
    generalPath: GENERAL.path,
  });
  assert.equal(memory.byDomain["mail.google.com"], undefined);
  assert.deepEqual(plain(memory.recents), [REPO_B.path, REPO_A.path]);

  // explicitly picking the general workspace clears the site mapping
  memory = context.applyProjectSelection(memory, {
    path: GENERAL.path,
    domain: "app.slack.com",
    explicit: true,
    generalPath: GENERAL.path,
  });
  assert.equal(memory.byDomain["app.slack.com"], undefined);
  assert.ok(!memory.recents.includes(GENERAL.path), "general never in recents");

  // recents are deduped and capped
  let capped = context.normalizeProjectMemory(undefined);
  for (let i = 0; i < 10; i++) {
    capped = context.applyProjectSelection(capped, {
      path: `/Users/dans/claude/projects/p${i % 8}`,
      explicit: false,
      generalPath: GENERAL.path,
    });
  }
  assert.ok(capped.recents.length <= 6, "recents capped");
  assert.equal(new Set(capped.recents).size, capped.recents.length, "deduped");

  // ── project context (list loading + auto resolution) ──────────
  fetchHandler = healthyBackend();
  storage = {};
  let ctx = await context.buildProjectContext("https://app.slack.com/client/T1/C1");
  assert.equal(ctx.available, true);
  assert.equal(ctx.domain, "app.slack.com");
  assert.equal(ctx.general.path, GENERAL.path);
  assert.equal(ctx.projects.length, 2);
  assert.deepEqual(plain(ctx.auto), {
    path: GENERAL.path,
    name: GENERAL.name,
    source: "default",
  });

  // a remembered site mapping to a known project resolves as Auto · repo-a
  storage = {
    projectMemory: {
      last: REPO_A.path,
      recents: [REPO_A.path, GENERAL.path],
      byDomain: { "app.slack.com": REPO_A.path },
    },
  };
  ctx = await context.buildProjectContext("https://app.slack.com/client/T1/C1");
  assert.deepEqual(plain(ctx.auto), {
    path: REPO_A.path,
    name: REPO_A.name,
    source: "site",
  });
  assert.deepEqual(
    plain(ctx).recents.map((project) => project.path),
    [REPO_A.path],
    "general workspace filtered out of recents",
  );

  // a stale mapping (unknown + fails validation) falls back to General
  storage = {
    projectMemory: { byDomain: { "app.slack.com": "/gone/repo" } },
  };
  fetchHandler = healthyBackend({ validateOk: false });
  ctx = await context.buildProjectContext("https://app.slack.com/client/T1/C1");
  assert.equal(ctx.auto.path, GENERAL.path);
  assert.equal(ctx.auto.source, "default");

  // a remembered custom folder that still validates is trusted
  fetchHandler = healthyBackend();
  storage = {
    projectMemory: { byDomain: { "app.slack.com": "/Users/dans/other/repo" } },
  };
  ctx = await context.buildProjectContext("https://app.slack.com/client/T1/C1");
  assert.equal(ctx.auto.path, "/Users/dans/other/repo");
  assert.equal(ctx.auto.source, "site");

  // ── backend unavailable ────────────────────────────────────────
  fetchHandler = async () => {
    throw new Error("ECONNREFUSED");
  };
  ctx = await context.buildProjectContext("https://mail.google.com/mail/u/0");
  assert.deepEqual(plain(ctx), { available: false, domain: "mail.google.com" });

  const failedRelay = await sendMessage({
    type: "forward-request",
    payload: { source: "web", url: "https://example.com", destination: "codex" },
  });
  assert.equal(failedRelay.transportOk, false);

  // ── forward-request: payload correctness + persistence ────────
  fetchHandler = healthyBackend();
  fetchLog = [];
  storage = {};
  const relay = await sendMessage({
    type: "forward-request",
    payload: {
      source: "web",
      url: "https://example.com",
      destination: "claude",
      workspace: REPO_B.path,
    },
    project: {
      domain: "example.com",
      path: REPO_B.path,
      explicit: true,
      generalPath: GENERAL.path,
    },
  });
  assert.equal(relay.transportOk, true);
  assert.equal(relay.data.ok, true);
  const forwardCall = fetchLog.find((call) => call.url.endsWith("/forward"));
  assert.equal(forwardCall.options.method, "POST");
  const sentPayload = JSON.parse(forwardCall.options.body);
  assert.equal(sentPayload.workspace, REPO_B.path, "workspace sent to webhook");
  assert.equal(sentPayload.destination, "claude");
  assert.equal(
    storage.projectMemory.byDomain["example.com"],
    REPO_B.path,
    "explicit choice remembered for the site",
  );
  assert.deepEqual(plain(storage.projectMemory.recents), [REPO_B.path]);
  assert.equal(storage.projectMemory.last, REPO_B.path);

  // a failed forward must not overwrite memory
  fetchHandler = async (url, options) => {
    if (url.endsWith("/forward")) {
      return { json: async () => ({ ok: false, error: "workspace rejected" }) };
    }
    return healthyBackend()(url, options);
  };
  const before = JSON.stringify(storage.projectMemory);
  const rejected = await sendMessage({
    type: "forward-request",
    payload: { source: "web", url: "https://x.example", destination: "codex" },
    project: {
      domain: "x.example",
      path: "/bad/path",
      explicit: true,
      generalPath: GENERAL.path,
    },
  });
  assert.equal(rejected.data.ok, false);
  assert.equal(JSON.stringify(storage.projectMemory), before);

  // ── validate-workspace + clear-project-mapping messages ───────
  fetchHandler = healthyBackend();
  const validated = await sendMessage({
    type: "validate-workspace",
    path: REPO_A.path,
  });
  assert.equal(validated.ok, true);
  assert.equal(validated.path, REPO_A.path);

  const cleared = await sendMessage({
    type: "clear-project-mapping",
    domain: "example.com",
  });
  assert.equal(cleared.ok, true);
  assert.equal(storage.projectMemory.byDomain["example.com"], undefined);

  // unknown messages are ignored synchronously (channel not held open)
  assert.equal(runtimeListener({ type: "ignored" }, {}, () => {}), false);

  // ── background job status (replaces the ✳ menu bar poller) ────
  fetchHandler = healthyBackend({ running: 2, queued: 1, errors: 3 });
  const jobs = await context.fetchBackgroundJobs();
  assert.deepEqual(plain(jobs), { running: 2, queued: 1, errors: 3 });

  fetchHandler = healthyBackend();
  assert.deepEqual(
    plain(await context.fetchBackgroundJobs()),
    { running: 0, queued: 0, errors: 0 },
    "idle backend reports zeroes, not null",
  );

  // webhook down must not throw — the popup simply omits the line
  fetchHandler = healthyBackend({ statusOk: false });
  assert.equal(await context.fetchBackgroundJobs(), null);

  console.log("extension project selector: ok");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
