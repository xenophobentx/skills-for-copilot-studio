/**
 * Tests that manage-agent recognizes the LanguageServerHost fault from
 * microsoft/skills-for-copilot-studio#178 and turns it into a hint.
 *
 * Run: node tests/lsp-fault-hint.test.js
 */

const fs = require("fs");
const path = require("path");

const src = fs.readFileSync(path.join(__dirname, "..", "scripts", "src", "manage-agent.js"), "utf8");

function extract(name, kind = "function") {
  const start = src.search(new RegExp(`^${kind} ${name}[ (]`, "m"));
  if (start === -1) throw new Error(`${kind} ${name} not found in manage-agent.js`);
  return src.slice(start, src.indexOf("\n}\n", start) + 3);
}

const log = () => {};
const mod = new Function(
  "log", "randomUUID",
  `${extract("lspFaultHint")}\n${extract("LspClient", "class")}\nreturn { lspFaultHint, LspClient };`
)(log, () => "x");
const { lspFaultHint, LspClient } = mod;

let passed = 0;
let failed = 0;
function check(cond, label) {
  if (cond) passed++;
  else {
    failed++;
    console.error(`FAIL: ${label}`);
  }
}

const crash =
  "[LspLogger] [null]\nSystem.InvalidOperationException: Can't read file outside of client workspace\r\n   at Microsoft.PowerPlatformLS.Impl.Core.IO.ClientWorkspaceFileProvider.GetFileProvider(DirectoryPath directoryPath)";

check(/#178/.test(lspFaultHint(crash) || ""), "the crash message gives a hint that names the issue");
check(/Update the extension/.test(lspFaultHint(crash) || ""), "the hint says what to do");
check(lspFaultHint("[LspLogger] Document file:///x/a.mcs.yml, len=142, tracked in current workspace.") === null, "a normal log line gives no hint");
check(lspFaultHint(undefined) === null, "a missing message gives no hint");
check(lspFaultHint(42) === null, "a non-string message gives no hint");

const client = new LspClient({ binaryPath: "x", lspOutDir: "x" }, "x");
check(client.faultHint === null, "a new client has no fault hint");
client._noteLogMessage({ type: 3, message: "tracked in current workspace." });
check(client.faultHint === null, "a normal log message leaves the hint empty");
client._noteLogMessage({ type: 1, message: crash });
check(client.faultHint !== null, "the crash message sets the hint");
const first = client.faultHint;
client._noteLogMessage({ type: 3, message: "Exiting server" });
check(client.faultHint === first, "later messages do not clear the hint");
client._noteLogMessage(undefined);
check(client.faultHint === first, "a missing params object is ignored");

console.log(`${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
