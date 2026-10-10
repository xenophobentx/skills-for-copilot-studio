/**
 * Text that has to work in clients other than Claude Code (Codex):
 *  - a skill that uses $ARGUMENTS says what to do when the client does not fill it in
 *  - a skill that signs in or calls the network says what to do in a sandbox
 *  - the routing prompt says how to start a sub-agent when the client has no agent
 *    type for it, and how to ask the user
 *
 * Run: node tests/client-neutral.test.js
 */

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const SENTENCE = "`$ARGUMENTS` is the text the user gave with this skill. If your client does not fill it in, use the user's request instead.";

const SANDBOX =
  "**Sandbox.** The commands below sign in, call the network and write to `~/.copilot-studio-cli`. " +
  "If your client runs commands in a sandbox (Codex with the default `workspace-write`), run them outside it, " +
  "with the user's permission. If there is a sandbox and the client cannot ask (Codex with `approval_policy = \"never\"`), " +
  "say which commands need network access and stop. With full access (`--yolo`), run them directly.";
const SANDBOXED = [
  "chat-directline", "chat-sdk", "clone-agent", "detect-mode", "directline-chat", "manage-agent",
  "new-topic", "run-eval", "run-tests-kit", "test-auth", "validate",
];

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
  // Skills that run a bundle which signs in or uses the network carry the sandbox paragraph.
  const needsNetwork = /(manage-agent|chat-with-agent|eval-api|directline-chat)\.bundle\.js|run-tests\.js/.test(body) && name !== "doctor";
  check(`${name}: sandbox paragraph ${SANDBOXED.includes(name) ? "present once" : "absent"}`,
    text.split(SANDBOX).length - 1 === (SANDBOXED.includes(name) ? 1 : 0));
  check(`${name}: runs network commands only if it is in SANDBOXED`, !needsNetwork || SANDBOXED.includes(name));
  check(`${name}: the sandbox paragraph comes before the locate section`, !SANDBOXED.includes(name) || text.indexOf(SANDBOX) < text.indexOf("## Locate the plugin files"));
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
