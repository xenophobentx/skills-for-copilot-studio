/**
 * Tests for the fail-closed validation decision logic in manage-agent:
 * a validation run is only "ok" when every opened file reported diagnostics.
 *
 * Run: node tests/validate-completeness.test.js
 */

// The helpers live in the manage-agent source, which runs main() on load, so
// pull the individual functions out of the source text instead of requiring it.
const fs = require("fs");
const os = require("os");
const path = require("path");

const src = fs.readFileSync(path.join(__dirname, "..", "scripts", "src", "manage-agent.js"), "utf8");

function extract(name) {
  const start = src.search(new RegExp(`^(?:async )?function ${name}\\(`, "m"));
  if (start === -1) throw new Error(`function ${name} not found in manage-agent.js`);
  const end = src.indexOf("\n}\n", start);
  return src.slice(start, end + 3);
}

const SEVERITY_NAMES = { 1: "error", 2: "warning", 3: "information", 4: "hint" };
const log = () => {};
eval(
  [
    "toFileUri",
    "diagnosticsKey",
    "findFilesWithoutDiagnostics",
    "openFilesForDiagnostics",
    "waitForDiagnostics",
    "formatValidationOutput",
    "pushBlockedError",
  ]
    .map(extract)
    .join("\n")
);

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

const agentDir = path.resolve(os.tmpdir(), "my agent");
const files = ["agent.mcs.yml", "topics/A b.topic.mcs.yml"].map((f) => path.join(agentDir, f));
const uriOf = (f) => toFileUri(f);
const err = { severity: 1, message: "boom", code: "X" };

// ---------------------------------------------------------------------------
// findFilesWithoutDiagnostics
// ---------------------------------------------------------------------------

assertEqual(findFilesWithoutDiagnostics(files, new Map()), files, "no diagnostics at all -> all files missing");

assertEqual(
  findFilesWithoutDiagnostics(files, new Map([[uriOf(files[0]), []]])),
  [files[1]],
  "empty array counts as reported; other file still missing"
);

assertEqual(
  findFilesWithoutDiagnostics(files, new Map(files.map((f) => [uriOf(f), []]))),
  [],
  "all files reported (empty arrays) -> nothing missing"
);

// Server may percent-encode differently than toFileUri (e.g. %20 vs literal space)
assertEqual(
  findFilesWithoutDiagnostics(files, new Map(files.map((f) => [uriOf(f).replace(/%20/g, " "), []]))),
  [],
  "URI encoding differences do not cause false misses"
);

// ---------------------------------------------------------------------------
// formatValidationOutput
// ---------------------------------------------------------------------------

const clean = formatValidationOutput(new Map(files.map((f) => [uriOf(f), []])), agentDir);
assertEqual(clean.status, "ok", "complete + clean -> ok");
assertEqual(clean.valid, true, "complete + clean -> valid");
assertEqual("incomplete" in clean, false, "complete output has no incomplete fields");

const incomplete = { reason: "timeout", message: "m", missingFiles: ["agent.mcs.yml"] };
const inc = formatValidationOutput(new Map(), agentDir, incomplete);
assertEqual(inc.status, "incomplete", "no errors but incomplete -> incomplete");
assertEqual(inc.valid, false, "incomplete is never valid");
assertEqual(
  [inc.incomplete, inc.reason, inc.message, inc.missingFiles],
  [true, "timeout", "m", ["agent.mcs.yml"]],
  "incomplete output carries reason, message and missing files"
);

const withErr = formatValidationOutput(new Map([[uriOf(files[0]), [err]]]), agentDir, incomplete);
assertEqual(withErr.status, "error", "errors take precedence over incomplete in status");
assertEqual([withErr.valid, withErr.incomplete], [false, true], "errors + incomplete -> invalid and flagged incomplete");

const onlyErr = formatValidationOutput(new Map([[uriOf(files[0]), [err]]]), agentDir);
assertEqual([onlyErr.status, onlyErr.valid, "incomplete" in onlyErr], ["error", false, false], "errors, complete -> unchanged contract");

// ---------------------------------------------------------------------------
// Unreadable files are reported separately and are not waited for
// ---------------------------------------------------------------------------

const readable = fs.mkdtempSync(path.join(os.tmpdir(), "validate-completeness-"));
const readableFile = path.join(readable, "agent.mcs.yml");
const missingFile = path.join(readable, "gone.mcs.yml");
fs.writeFileSync(readableFile, "kind: GptComponentMetadata\n");
const sent = [];
const unreadable = openFilesForDiagnostics({ sendNotification: (m, p) => sent.push([m, p]) }, [readableFile, missingFile]);
fs.rmSync(readable, { recursive: true, force: true });
assertEqual(unreadable.map((u) => u.filePath), [missingFile], "unreadable file is returned");
assertEqual(typeof unreadable[0].error, "string", "unreadable file carries the read error");
assertEqual(
  sent.filter(([m]) => m === "textDocument/didOpen").map(([, p]) => p.textDocument.uri),
  [toFileUri(readableFile)],
  "only the readable file is opened"
);

const unreadableIncomplete = { reason: "unreadable", message: "m", missingFiles: [], unreadableFiles: [{ file: "a.mcs.yml", error: "EACCES" }] };
const unr = formatValidationOutput(new Map(), agentDir, unreadableIncomplete);
assertEqual([unr.status, unr.valid, unr.reason], ["incomplete", false, "unreadable"], "unreadable-only run is incomplete");
assertEqual(unr.unreadableFiles, unreadableIncomplete.unreadableFiles, "output lists unreadable files");
assertEqual(inc.unreadableFiles, [], "unreadableFiles defaults to an empty list");

// ---------------------------------------------------------------------------
// Push error text
// ---------------------------------------------------------------------------

const errorsOnly = { summary: { errors: 2 } };
const incompleteOnly = { summary: { errors: 0 }, incomplete: true, message: "Validation incomplete: X." };
const both = { summary: { errors: 2 }, incomplete: true, message: "Validation incomplete: X." };
assertEqual(
  pushBlockedError(errorsOnly),
  "Push blocked: 2 validation error(s). Fix errors before pushing, or use --force to bypass.",
  "push text: errors only is unchanged"
);
assertEqual(pushBlockedError(incompleteOnly).includes("Validation incomplete: X."), true, "push text: incomplete only mentions it");
assertEqual(
  [pushBlockedError(both).includes("2 validation error(s)"), pushBlockedError(both).includes("Validation incomplete: X.")],
  [true, true],
  "push text: errors and incomplete mention both"
);

// ---------------------------------------------------------------------------
// Windows and POSIX URI keys, run against path.win32 / a fake os on any platform
// ---------------------------------------------------------------------------

function load(platform) {
  const path = require("path")[platform === "win32" ? "win32" : "posix"];
  const os = { platform: () => platform };
  eval(["toFileUri", "diagnosticsKey", "findFilesWithoutDiagnostics"].map(extract).join("\n"));
  return { toFileUri, diagnosticsKey, findFilesWithoutDiagnostics };
}

const win = load("win32");
const winFile = "C:\\Users\\Me\\my agent\\topics\\A b.topic.mcs.yml";
const winUri = win.toFileUri(winFile);
assertEqual(winUri, "file:///C:/Users/Me/my%20agent/topics/A%20b.topic.mcs.yml", "win32 toFileUri keeps the drive letter");

const winVariants = {
  "file:///C:/": winUri,
  "lowercase drive": winUri.replace("file:///C:", "file:///c:"),
  "percent-encoded colon (VS Code)": winUri.replace("file:///C:", "file:///c%3A"),
  "uppercase drive, percent-encoded colon": winUri.replace("file:///C:", "file:///C%3A"),
  "lowercase path": winUri.toLowerCase(),
  "literal spaces": winUri.replace(/%20/g, " "),
  "backslashes": "file:///" + winUri.slice("file:///".length).replace(/\//g, "\\"),
};
for (const [label, uri] of Object.entries(winVariants)) {
  assertEqual(win.diagnosticsKey(uri), win.diagnosticsKey(winUri), `win32 key: ${label}`);
  assertEqual(win.findFilesWithoutDiagnostics([winFile], new Map([[uri, []]])), [], `win32 file counts as reported: ${label}`);
}
assertEqual(win.findFilesWithoutDiagnostics([winFile], new Map([[winUri.replace("C:", "D:"), []]])), [winFile], "win32: other drive does not match");
assertEqual(
  win.findFilesWithoutDiagnostics([winFile], new Map([[win.toFileUri("C:\\Users\\Me\\my agent\\topics\\B.topic.mcs.yml"), []]])),
  [winFile],
  "win32: other file does not match"
);

const posix = load("linux");
assertEqual(posix.diagnosticsKey("file:///Users/A/b%20c"), "/Users/A/b c", "posix key is decoded");
assertEqual(posix.diagnosticsKey("file:///Users/A") === posix.diagnosticsKey("file:///users/a"), false, "posix keys are case-sensitive");

// ---------------------------------------------------------------------------
// waitForDiagnostics, then results
// ---------------------------------------------------------------------------

function fakeClient() {
  return { _diagnostics: new Map(), running: true, _onDiagnosticsCallback: null, _onExitCallback: null };
}

(async () => {
  // Nothing to wait for (every file was unreadable): resolves right away, not after the timeout
  let t = Date.now();
  let res = await waitForDiagnostics(fakeClient(), [], 20, 2000);
  assertEqual([res.reason, Date.now() - t < 1000], [null, true], "no expected files -> no wait");

  // Expected file never reports: hard timeout
  t = Date.now();
  res = await waitForDiagnostics(fakeClient(), files, 20, 100);
  assertEqual(res.reason, "timeout", "expected file never reports -> timeout");

  // Expected file reports: settles without hitting the timeout
  const client = fakeClient();
  const p = waitForDiagnostics(client, [files[0]], 20, 2000);
  client._diagnostics.set(uriOf(files[0]), []);
  client._onDiagnosticsCallback();
  assertEqual((await p).reason, null, "all expected files reported -> settles");

  console.log(`${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})();
