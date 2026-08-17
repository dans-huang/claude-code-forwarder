const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

let runtimeListener;
let requestedUrl;
let requestedOptions;

const context = {
  console,
  setTimeout,
  clearTimeout,
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
  },
  fetch: async (url, options) => {
    requestedUrl = url;
    requestedOptions = options;
    return { json: async () => ({ ok: true, status: "opened" }) };
  },
};

const source = fs.readFileSync(
  path.join(__dirname, "..", "extension", "background.js"),
  "utf8",
);
vm.runInNewContext(source, context, { filename: "background.js" });

assert.equal(typeof runtimeListener, "function");
assert.equal(runtimeListener({ type: "ignored" }, {}, () => {}), false);

async function main() {
  const reply = await new Promise((resolve, reject) => {
    const staysOpen = runtimeListener(
      {
        type: "forward-request",
        payload: { source: "web", url: "https://example.com", destination: "codex" },
      },
      {},
      resolve,
    );
    if (!staysOpen) reject(new Error("Message channel did not stay open"));
  });

  assert.equal(requestedUrl, "http://localhost:5581/forward");
  assert.equal(requestedOptions.method, "POST");
  assert.equal(JSON.parse(requestedOptions.body).destination, "codex");
  assert.equal(reply.transportOk, true);
  assert.equal(reply.data.ok, true);
  assert.equal(reply.data.status, "opened");

  console.log("extension service-worker relay: ok");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
