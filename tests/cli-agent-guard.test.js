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
const doctor = require("../scripts/src/doctor.js");
const mod = new Function(
  "fs", "path", "doctor",
  `${extract("isCliAgentWorkspace")}\nreturn { isCliAgentWorkspace };`
)(fs, path, doctor);

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
  assertEqual(/allow-cli-agent/.test((r.json && r.json.error) || ""), false, `${cmd} does not offer the override flag in its message`);
  assertEqual(/reported to cut the tail/.test((r.json && r.json.error) || ""), true, `${cmd} says the loss was reported, not that it happens`);
}

// The refusal comes first, before the checks for tenant and environment.
for (const cmd of ["pull", "push"]) {
  const res = spawnSync(process.execPath, [bundle, cmd, "--workspace", makeWorkspace(CLI_TEMPLATE)], {
    encoding: "utf8",
    timeout: 20000,
    env: { PATH: path.dirname(process.execPath), HOME: home, USERPROFILE: home, SystemRoot: process.env.SystemRoot },
  });
  let json = null;
  try {
    json = JSON.parse(res.stdout);
  } catch {}
  assertEqual(/CLI agent workspace/.test((json && json.error) || ""), true, `${cmd} refuses before it asks for --tenant-id`);
}

// A long, classic settings.mcs.yml with the words in a comment or a value is not refused.
assertEqual(
  mod.isCliAgentWorkspace(makeWorkspace("displayName: Cli\nconfiguration:\n  instructions: talk about the cliagent template\n# template: cliagent\ntemplate: default-2.1.0\n")),
  false,
  "words in a value or after a hash do not count"
);

// With the override the guard steps aside. Run in-process with a stub for die(), so
// nothing signs in.
{
  const guard = new Function(
    "fs", "path", "doctor", "die", "findAgentDir",
    `${extract("isCliAgentWorkspace")}\n${extract("requireClassicWorkspace")}\nreturn requireClassicWorkspace;`
  );
  const messages = [];
  const require_ = guard(fs, path, doctor, (m) => messages.push(m), (w) => w);
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
