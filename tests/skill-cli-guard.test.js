/**
 * Every skill that changes agent files carries the same short CLI-agent guard.
 * Without a trusted hook the routing prompt is not there, so the skills must
 * stop on a CLI agent workspace on their own.
 *
 * A skill that can write (allowed-tools has Edit or Write) must carry the guard
 * or be listed in EXEMPT with a reason. The skills that write through scripts
 * (clone, pull, push) are listed in GUARDED by hand.
 *
 * Run: node tests/skill-cli-guard.test.js
 */

const fs = require("fs");
const path = require("path");

const SKILLS = path.join(__dirname, "..", "skills");

const GUARD =
  "**Before you change anything.** If the agent is already on disk, search its own `settings.mcs.yml` for `template: cliagent*` or " +
  "`authoringModel: CliCopilot` (details under \"Workspace Type\" in skill `int-project-context`). A match means a " +
  "CLI agent: stop, change nothing, and point the user to https://github.com/microsoft/copilot-studio-plugin. " +
  "Do this even for a one-line change. A fresh clone has no file to search yet, see the Cloning rule in `clone-agent`.";

// A cloud agent has no local settings.mcs.yml before the download: clone into an empty folder
// and check the new folder right after.
const CLONE =
  "**Cloning.** There is no local `settings.mcs.yml` to check before a download. Clone into an empty folder, never into a folder " +
  "that already holds an agent (check that agent as above). Right after the download, search the new folder's `settings.mcs.yml` " +
  "for the same two markers. On a match it is a CLI agent: do not edit, pull, push or publish it, tell the user the path of the " +
  "downloaded folder and that it is a CLI agent workspace, point to https://github.com/microsoft/copilot-studio-plugin, and leave " +
  "the folder for the user to keep or delete.";
const CLONING = ["clone-agent", "manage-agent"];

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
  const cloneCount = text.split(CLONE).length - 1;
  check(`${name} ${CLONING.includes(name) ? "has" : "does not have"} the Cloning rule`, cloneCount === (CLONING.includes(name) ? 1 : 0));
  if (CLONING.includes(name)) check(`${name}: the Cloning rule follows the guard`, text.indexOf(GUARD) + GUARD.length + 2 === text.indexOf(CLONE));
  if (GUARDED.includes(name)) {
    check(`${name} has the CLI-agent guard exactly once`, count === 1);
  } else {
    check(`${name} does not carry the guard (not file-changing)`, count === 0);
    check(`${name} can write, so it is in GUARDED or EXEMPT`, !writes || name in EXEMPT);
  }
}
for (const name of GUARDED) check(`${name} exists`, fs.existsSync(path.join(SKILLS, name, "SKILL.md")));

const prompt = fs.readFileSync(path.join(__dirname, "..", "hooks", "system-prompt.md"), "utf8");
check("routing prompt: the first-tool-call search is for an agent that is on disk", prompt.includes("for an agent that is on disk (even one line), your first tool call"));
check("routing prompt: a clone is checked right after the download", prompt.includes("clone it into an empty folder and run that search on the new folder's `settings.mcs.yml` right after the download"));
check("routing prompt: no first-call search before a clone", !/published or cloned for an agent/.test(prompt));

console.log(`${passed + failed} tests: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
