/**
 * Tests that manage-agent pull and push refuse a CLI agent workspace
 * (template cliagent-*, authoringModel CliCopilot), upstream issue #180.
 * The refusal comes before any sign-in or network call.
 *
 * Run: node tests/cli-agent-guard.test.js
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const bundle = path.join(__dirname, "..", "scripts", "manage-agent.bundle.js");
const src = fs.readFileSync(path.join(__dirname, "..", "scripts", "src", "manage-agent.js"), "utf8");

function extract(name) {
  const start = src.search(new RegExp(`^function ${name}\\(`, "m"));
  if (start === -1) throw new Error(`function ${name} not found in manage-agent.js`);
  return src.slice(start, src.indexOf("\n}\n", start) + 3);
}
const mod = new Function(
  "fs", "path",
  `${src.match(/^const CLI_AGENT_RE = .*;$/m)[0]}\n${extract("isCliAgentWorkspace")}\nreturn { isCliAgentWorkspace };`
)(fs, path);

const root = fs.mkdtempSync(path.join(os.tmpdir(), "cli-guard-test-"));
const home = path.join(root, "home");
fs.mkdirSync(home);
let counter = 0;
let passed = 0;
let failed = 0;
function assertEqual(actual, expected, label) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) passed++;
  else {
    failed++;
    console.error(`FAIL: ${label}\n  expected: ${e}\n  actual:   ${a}`);
  }
}

function makeWorkspace(settings) {
  const ws = path.join(root, `ws-${++counter}`);
  fs.mkdirSync(path.join(ws, ".mcs"), { recursive: true });
  fs.writeFileSync(path.join(ws, ".mcs", "conn.json"), "{}");
  fs.writeFileSync(path.join(ws, ".mcs", "botdefinition.json"), "{}");
  if (settings !== null) fs.writeFileSync(path.join(ws, "settings.mcs.yml"), settings);
  return ws;
}

const CLI_TEMPLATE = "displayName: x\ntemplate: cliagent-1.0.0\nlanguage: 1033\n";
const CLI_MODEL = "configuration:\n  authoringModel: CliCopilot\n";
const CLASSIC = "displayName: x\ntemplate: default-2.1.0\nlanguage: 1033\n";

assertEqual(mod.isCliAgentWorkspace(makeWorkspace(CLI_TEMPLATE)), true, "template cliagent is a CLI agent");
assertEqual(mod.isCliAgentWorkspace(makeWorkspace(CLI_MODEL)), true, "authoringModel CliCopilot is a CLI agent");
assertEqual(mod.isCliAgentWorkspace(makeWorkspace(CLASSIC)), false, "a classic agent is not");
assertEqual(mod.isCliAgentWorkspace(makeWorkspace(null)), false, "no settings.mcs.yml is not a CLI agent");

function run(cmd, ws, extra = []) {
  const res = spawnSync(
    process.execPath,
    [bundle, cmd, "--workspace", ws, "--tenant-id", "t", "--environment-id", "e", "--environment-url", "https://x.invalid", "--agent-mgmt-url", "https://y.invalid", ...extra],
    {
      encoding: "utf8",
      timeout: 20000,
      env: { PATH: path.dirname(process.execPath), HOME: home, USERPROFILE: home, SystemRoot: process.env.SystemRoot },
    }
  );
  let json = null;
  try {
    json = JSON.parse(res.stdout);
  } catch {}
  return { status: res.status, json };
}

for (const cmd of ["pull", "push"]) {
  const r = run(cmd, makeWorkspace(CLI_TEMPLATE));
  assertEqual(r.status, 1, `${cmd} on a CLI agent exits 1`);
  assertEqual(r.json && r.json.status, "error", `${cmd} on a CLI agent prints status error`);
  assertEqual(/CLI agent workspace/.test((r.json && r.json.error) || "") && /copilot-studio-plugin/.test((r.json && r.json.error) || ""), true, `${cmd} names the CLI agent and the other plugin`);
}

// With the override the guard steps aside. Run in-process with a stub for die(), so
// nothing signs in.
{
  const guard = new Function(
    "fs", "path", "die", "findAgentDir",
    `${src.match(/^const CLI_AGENT_RE = .*;$/m)[0]}\n${extract("isCliAgentWorkspace")}\n${extract("requireClassicWorkspace")}\nreturn requireClassicWorkspace;`
  );
  const messages = [];
  const require_ = guard(fs, path, (m) => messages.push(m), (w) => w);
  const cli = makeWorkspace(CLI_TEMPLATE);
  require_({ workspace: cli, allowCliAgent: true }, "Pull");
  assertEqual(messages.length, 0, "--allow-cli-agent skips the refusal");
  require_({ workspace: cli, allowCliAgent: false }, "Pull");
  assertEqual(messages.length, 1, "without the flag the refusal runs");
  require_({ workspace: makeWorkspace(CLASSIC), allowCliAgent: false }, "Pull");
  assertEqual(messages.length, 1, "a classic workspace is not refused");
}

fs.rmSync(root, { recursive: true, force: true });
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
