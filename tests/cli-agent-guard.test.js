/**
 * Every skill that changes agent files carries the same short CLI-agent guard.
 * Without a trusted hook the routing prompt is not there, so the skills must
 * stop on a CLI agent workspace on their own.
 *
 * A skill that can write (allowed-tools has Edit or Write) must carry the guard
 * or be listed in EXEMPT with a reason. The skills that write through scripts
 * (clone, pull, push) are listed in GUARDED by hand.
 *
 * Run: node tests/cli-agent-guard.test.js
 */

const fs = require("fs");
const path = require("path");

const SKILLS = path.join(__dirname, "..", "skills");

const GUARD =
  "**Before you change anything.** Search the agent's own `settings.mcs.yml` for `template: cliagent*` or " +
  "`authoringModel: CliCopilot` (details under \"Workspace Type\" in skill `int-project-context`). A match means a " +
  "CLI agent: stop, change nothing, and point the user to https://github.com/microsoft/copilot-studio-plugin. " +
  "Do this even for a one-line change.";

const GUARDED = [
  "add-adaptive-card", "add-generative-answers", "add-global-variable", "add-knowledge", "add-node",
  "add-other-agents", "analyze-evals", "clone-agent", "edit-action", "edit-agent", "edit-triggers",
  "manage-agent", "new-topic", "run-eval",
];
const EXEMPT = {
  "create-eval": "writes plugin eval scenarios, not agent files",
  "create-eval-set": "writes a test set CSV, not agent files",
  "run-tests-kit": "writes the Kit test settings, not agent files",
};

let passed = 0;
let failed = 0;
function check(name, ok) {
  if (ok) passed++;
  else {
    failed++;
    console.log(`FAIL  ${name}`);
  }
}

for (const name of fs.readdirSync(SKILLS)) {
  const file = path.join(SKILLS, name, "SKILL.md");
  if (!fs.existsSync(file)) continue;
  const text = fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n");
  const tools = (text.match(/^allowed-tools:(.*)$/m) || [, ""])[1];
  const writes = /\b(Edit|Write)\b/.test(tools);
  const count = text.split(GUARD).length - 1;
  if (GUARDED.includes(name)) {
    check(`${name} has the CLI-agent guard exactly once`, count === 1);
  } else {
    check(`${name} does not carry the guard (not file-changing)`, count === 0);
    check(`${name} can write, so it is in GUARDED or EXEMPT`, !writes || name in EXEMPT);
  }
}
for (const name of GUARDED) check(`${name} exists`, fs.existsSync(path.join(SKILLS, name, "SKILL.md")));

console.log(`${passed + failed} tests: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
