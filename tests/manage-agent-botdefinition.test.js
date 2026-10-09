/**
 * Tests for the .mcs/botdefinition.json precheck in manage-agent
 * (getMissingBotDefinitionError).
 *
 * Run: node tests/manage-agent-botdefinition.test.js
 */

// The functions are extracted from the manage-agent source so the test does
// not run the CLI's main(), which calls process.exit().
const fs = require("fs");
const os = require("os");
const path = require("path");

const srcPath = path.join(__dirname, "..", "scripts", "src", "manage-agent.js");
const src = fs.readFileSync(srcPath, "utf8");

function extractFunction(name) {
  const start = src.indexOf(`function ${name}(`);
  if (start === -1) throw new Error(`function ${name} not found in manage-agent.js`);
  const end = src.indexOf("\n}\n", start);
  return src.slice(start, end + 2);
}

const log = () => {};
const { getMissingBotDefinitionError } = new Function(
  "fs",
  "path",
  "log",
  `${extractFunction("findAgentDir")}
${extractFunction("getMissingBotDefinitionError")}
return { getMissingBotDefinitionError };`
)(fs, path, log);

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

function assertTrue(value, label) {
  assertEqual(Boolean(value), true, label);
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), "botdef-test-"));

// Creates an agent folder. Options control which .mcs files exist.
function makeAgent(dir, { conn = true, botdef = true } = {}) {
  fs.mkdirSync(path.join(dir, ".mcs"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".mcs", ".gitignore"), "*\n");
  fs.writeFileSync(path.join(dir, "agent.mcs.yml"), "kind: GptComponentMetadata\n");
  if (conn) fs.writeFileSync(path.join(dir, ".mcs", "conn.json"), "{}");
  if (botdef) fs.writeFileSync(path.join(dir, ".mcs", "botdefinition.json"), "{}");
  return dir;
}

try {
  // -------------------------------------------------------------------------
  // Workspace is the agent folder
  // -------------------------------------------------------------------------

  assertEqual(
    getMissingBotDefinitionError(makeAgent(path.join(root, "intact"))),
    null,
    "intact workspace passes"
  );

  const missing = makeAgent(path.join(root, "missing"), { botdef: false });
  const message = getMissingBotDefinitionError(missing);
  assertTrue(typeof message === "string", "missing botdefinition.json returns a message");
  assertTrue(message.includes(".mcs/botdefinition.json"), "message names the missing file");
  assertTrue(message.includes(path.resolve(missing)), "message names the agent folder");
  assertTrue(message.includes(".mcs/.gitignore"), "message explains the git ignore");
  assertTrue(message.includes("clone the agent again"), "message names the fix");

  assertEqual(
    getMissingBotDefinitionError(makeAgent(path.join(root, "no-conn"), { conn: false })),
    null,
    "conn.json alone is not required"
  );

  // Copied or checked-out workspace where .mcs/ is gone entirely
  const noMcs = path.join(root, "no-mcs");
  fs.mkdirSync(path.join(noMcs, "topics"), { recursive: true });
  fs.writeFileSync(path.join(noMcs, "agent.mcs.yml"), "kind: GptComponentMetadata\n");
  assertTrue(getMissingBotDefinitionError(noMcs), "workspace without .mcs/ returns a message");

  // Empty folder
  const empty = path.join(root, "empty");
  fs.mkdirSync(empty);
  assertTrue(getMissingBotDefinitionError(empty), "empty folder returns a message");

  // -------------------------------------------------------------------------
  // Workspace is a parent folder holding the agent in a subfolder
  // -------------------------------------------------------------------------

  const parentOk = path.join(root, "parent-ok");
  makeAgent(path.join(parentOk, "My Agent"));
  assertEqual(getMissingBotDefinitionError(parentOk), null, "agent in subfolder passes");

  const parentBad = path.join(root, "parent-bad");
  const sub = makeAgent(path.join(parentBad, "My Agent"), { botdef: false });
  const subMessage = getMissingBotDefinitionError(parentBad);
  assertTrue(typeof subMessage === "string", "agent in subfolder without botdefinition.json returns a message");
  assertTrue(subMessage.includes(path.resolve(sub)), "message names the subfolder");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
