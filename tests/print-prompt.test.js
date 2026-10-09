/**
 * Tests for hooks/print-prompt.js. The SessionStart hook injects the full
 * Copilot Studio system prompt only in Copilot Studio projects (.mcs/ or
 * *.mcs.yml) and a short pointer everywhere else.
 *
 * Run: node tests/print-prompt.test.js
 */

const cp = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const HOOK = path.join(__dirname, "..", "hooks", "print-prompt.js");
const FULL = fs.readFileSync(path.join(__dirname, "..", "hooks", "system-prompt.md"), "utf8");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "print-prompt-test-"));

function dir(name, files) {
  const d = path.join(root, name);
  fs.mkdirSync(d, { recursive: true });
  for (const f of files) {
    const p = path.join(d, f);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    if (f.endsWith("/")) continue;
    fs.writeFileSync(p, "x");
  }
  return d;
}

function run(cwd, env) {
  const e = { ...process.env };
  delete e.COPILOT_CLI;
  return cp.execFileSync(process.execPath, [HOOK], { cwd, env: { ...e, ...env }, encoding: "utf8" });
}

let passed = 0;
let failed = 0;
function check(name, ok) {
  if (ok) passed++;
  else {
    failed++;
    console.error(`FAIL ${name}`);
  }
}

const full = [
  ["agent.mcs.yml in cwd", ["agent.mcs.yml"]],
  ["CLI agent workspace (settings.mcs.yml, no agent.mcs.yml)", ["settings.mcs.yml"]],
  [".mcs folder in cwd", [".mcs/conn.json"]],
  ["agent.mcs.yml in a subdirectory", ["agents/my-agent/agent.mcs.yml"]],
  [".mcs folder in a subdirectory", ["agents/my-agent/.mcs/conn.json"]],
];
const pointer = [
  ["empty folder", []],
  ["unrelated project", ["package.json", "src/index.js"]],
  ["marker only in node_modules", ["node_modules/x/agent.mcs.yml"]],
];

try {
  full.forEach(([name, files], i) => {
    const out = run(dir("full" + i, files));
    check(`${name}: full prompt`, out === FULL);
  });
  pointer.forEach(([name, files], i) => {
    const out = run(dir("pointer" + i, files));
    check(`${name}: short pointer, not the full prompt`, out.length > 0 && out.length < 1500 && out !== FULL);
    check(`${name}: pointer names the prompt file`, out.includes(path.join("hooks", "system-prompt.md")));
  });
  // Copilot CLI gets JSON with additionalContext for both cases.
  const cli1 = JSON.parse(run(dir("cli1", ["agent.mcs.yml"]), { COPILOT_CLI: "1" }));
  check("Copilot CLI, CS project: JSON with full prompt", cli1.additionalContext === FULL);
  const cli2 = JSON.parse(run(dir("cli2", []), { COPILOT_CLI: "1" }));
  check("Copilot CLI, other folder: JSON with pointer", typeof cli2.additionalContext === "string" && cli2.additionalContext !== FULL);
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
