/**
 * Tests that LspClient.stop() sends the LSP "shutdown" request and "exit"
 * notification without params. The spec defines none, and the LanguageServerHost
 * logs "Handler shutdown (default) does not accept parameters" (and refuses the
 * shutdown) when it receives some, even null.
 *
 * Run: node tests/lsp-shutdown.test.js
 */

// LspClient lives in the manage-agent source, which runs main() on load, so
// pull the class out of the source text instead of requiring it.
const fs = require("fs");
const path = require("path");

const src = fs.readFileSync(path.join(__dirname, "..", "scripts", "src", "manage-agent.js"), "utf8");

function extractClass(name) {
  const start = src.search(new RegExp(`^class ${name} \\{`, "m"));
  if (start === -1) throw new Error(`class ${name} not found in manage-agent.js`);
  const end = src.indexOf("\n}\n", start);
  return src.slice(start, end + 3);
}

const log = () => {};
const LspClient = eval(`(${extractClass("LspClient")})`);

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;

function assertEqual(actual, expected, label) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    passed++;
  } else {
    failed++;
    console.error(`FAIL: ${label}\n  expected: ${e}\n  actual:   ${a}`);
  }
}

// A connection that records exactly which arguments each call received
function fakeConnection({ shutdownError } = {}) {
  const calls = [];
  return {
    calls,
    sendRequest: async (...a) => {
      calls.push({ kind: "request", args: a });
      if (shutdownError) throw new Error(shutdownError);
      return null;
    },
    sendNotification: (...a) => calls.push({ kind: "notification", args: a }),
    dispose: () => calls.push({ kind: "dispose", args: [] }),
  };
}

async function stopWith(conn) {
  const client = new LspClient({ binaryPath: "x", lspOutDir: "x" }, "x");
  client.running = true;
  client._connection = conn;
  await client.stop();
  return client;
}

(async () => {
  // -------------------------------------------------------------------------
  // shutdown and exit carry no params
  // -------------------------------------------------------------------------

  {
    const conn = fakeConnection();
    const client = await stopWith(conn);
    assertEqual(conn.calls[0], { kind: "request", args: ["shutdown"] }, "shutdown request has no params argument");
    assertEqual(conn.calls[1], { kind: "notification", args: ["exit"] }, "exit notification has no params argument");
    assertEqual(client.running, false, "client is stopped after a clean shutdown");
  }

  // -------------------------------------------------------------------------
  // A failing shutdown is still swallowed and the client still cleans up
  // -------------------------------------------------------------------------

  {
    const conn = fakeConnection({ shutdownError: "boom" });
    const client = await stopWith(conn);
    assertEqual(conn.calls.map((c) => c.kind), ["request", "dispose"], "rejected shutdown skips exit but still disposes");
    assertEqual(client.running, false, "client is stopped after a rejected shutdown");
  }

  console.log(`${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})();
