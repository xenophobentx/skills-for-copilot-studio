/**
 * Text that has to work in clients other than Claude Code (Codex):
 *  - a skill that uses $ARGUMENTS says what to do when the client does not fill it in
 *  - the routing prompt says how to start a sub-agent when the client has no agent
 *    type for it, and how to ask the user
 *
 * Run: node tests/client-neutral.test.js
 */

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const SENTENCE = "`$ARGUMENTS` is the text the user gave with this skill. If your client does not fill it in, use the user's request instead.";

let passed = 0;
let failed = 0;
function check(name, ok) {
  if (ok) passed++;
  else {
    failed++;
    console.log(`FAIL  ${name}`);
  }
}

for (const name of fs.readdirSync(path.join(ROOT, "skills"))) {
  const file = path.join(ROOT, "skills", name, "SKILL.md");
  if (!fs.existsSync(file)) continue;
  const text = fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n");
  const body = text.replace(/^---[\s\S]*?\n---/, "");
  const uses = /\$ARGUMENTS/.test(body.replace(SENTENCE, ""));
  const count = text.split(SENTENCE).length - 1;
  check(`${name}: $ARGUMENTS has the fallback sentence`, !uses || count === 1);
  // positions after the sentence are shifted by its length once it is cut out, so compare against the cut text
  const firstUse = body.replace(SENTENCE, "").search(/\$ARGUMENTS/);
  check(`${name}: the fallback sentence comes before the first use`, count === 0 || firstUse >= body.indexOf(SENTENCE));
  check(`${name}: no fallback sentence without $ARGUMENTS`, uses || count === 0);
}

const prompt = fs.readFileSync(path.join(ROOT, "hooks", "system-prompt.md"), "utf8");
check("prompt: sub-agent fallback names agents/<file>.md", prompt.includes("<pluginRoot>/agents/<file>.md"));
for (const a of fs.readdirSync(path.join(ROOT, "agents"))) check(`prompt: lists ${a}`, prompt.includes("`" + a + "`"));
check("prompt: sub-agent gets the skills of its frontmatter", prompt.includes("`skills:` list"));
check("prompt: sub-agent gets the absolute pluginRoot", prompt.includes("absolute `<pluginRoot>`"));
check("prompt: asking the user without a question tool", prompt.includes("ask in plain text and stop"));
check("prompt: the workspace check works without a Grep tool", prompt.includes("(or `grep` in a shell)"));

console.log(`${passed + failed} tests: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
