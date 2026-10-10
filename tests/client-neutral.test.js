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

// The sandbox paragraph differs by skill: it names the commands that sign in or use the network.
const SANDBOX = {
  "chat-directline":
    "**Sandbox.** `chat-with-agent.bundle.js` signs in, calls the network and writes to `~/.copilot-studio-cli`. Run the command and do not assume it is blocked: a sandbox can allow the network and the folders it needs. If the command fails with a concrete sandbox error (network unreachable, `EPERM`, permission denied, read-only file system), ask for only the access that is missing (the network, write access to the folder in the error, or on macOS the keychain) and run it again. If you cannot ask (Codex with `approval_policy = \"never\"`), say which access is missing and stop.",
  "chat-sdk":
    "**Sandbox.** `chat-with-agent.bundle.js` signs in, calls the network and writes to `~/.copilot-studio-cli`. Run the command and do not assume it is blocked: a sandbox can allow the network and the folders it needs. If the command fails with a concrete sandbox error (network unreachable, `EPERM`, permission denied, read-only file system), ask for only the access that is missing (the network, write access to the folder in the error, or on macOS the keychain) and run it again. If you cannot ask (Codex with `approval_policy = \"never\"`), say which access is missing and stop.",
  "clone-agent":
    "**Sandbox.** The `manage-agent.bundle.js` commands below sign in, call the network and write to `~/.copilot-studio-cli`. Run the command and do not assume it is blocked: a sandbox can allow the network and the folders it needs. If the command fails with a concrete sandbox error (network unreachable, `EPERM`, permission denied, read-only file system), ask for only the access that is missing (the network, write access to the folder in the error, or on macOS the keychain) and run it again. If you cannot ask (Codex with `approval_policy = \"never\"`), say which access is missing and stop.",
  "detect-mode":
    "**Sandbox.** `chat-with-agent.bundle.js --detect-only` signs in, queries Dataverse and writes to `~/.copilot-studio-cli`. Run the command and do not assume it is blocked: a sandbox can allow the network and the folders it needs. If the command fails with a concrete sandbox error (network unreachable, `EPERM`, permission denied, read-only file system), ask for only the access that is missing (the network, write access to the folder in the error, or on macOS the keychain) and run it again. If you cannot ask (Codex with `approval_policy = \"never\"`), say which access is missing and stop.",
  "directline-chat":
    "**Sandbox.** `directline-chat.bundle.js` calls the network. It does not sign in. Run the command and do not assume it is blocked: a sandbox can allow the network and the folders it needs. If the command fails with a concrete sandbox error (network unreachable, `EPERM`, permission denied, read-only file system), ask for only the access that is missing (the network, write access to the folder in the error, or on macOS the keychain) and run it again. If you cannot ask (Codex with `approval_policy = \"never\"`), say which access is missing and stop.",
  "manage-agent":
    "**Sandbox.** The `manage-agent.bundle.js` commands below sign in, call the network and write to `~/.copilot-studio-cli`. Run the command and do not assume it is blocked: a sandbox can allow the network and the folders it needs. If the command fails with a concrete sandbox error (network unreachable, `EPERM`, permission denied, read-only file system), ask for only the access that is missing (the network, write access to the folder in the error, or on macOS the keychain) and run it again. If you cannot ask (Codex with `approval_policy = \"never\"`), say which access is missing and stop.",
  "new-topic":
    "**Sandbox.** Only Step B, `manage-agent.bundle.js validate`, signs in, calls the network and writes to `~/.copilot-studio-cli`. Schema lookup, Step A and writing the topic are local. Run Step B and do not assume it is blocked: a sandbox can allow the network and the folders it needs. If Step B fails with a concrete sandbox error (network unreachable, `EPERM`, permission denied, read-only file system), ask for only the access that is missing (the network, write access to the folder in the error, or on macOS the keychain) and run it again. If you cannot ask (Codex with `approval_policy = \"never\"`) or Step B still cannot run, skip Step B, still write and schema-validate the topic, and tell the user that the LSP validation did not run.",
  "run-eval":
    "**Sandbox.** The `eval-api.bundle.js` commands and `manage-agent.bundle.js push` and `pull` sign in, call the network and write to `~/.copilot-studio-cli`. Run the command and do not assume it is blocked: a sandbox can allow the network and the folders it needs. If the command fails with a concrete sandbox error (network unreachable, `EPERM`, permission denied, read-only file system), ask for only the access that is missing (the network, write access to the folder in the error, or on macOS the keychain) and run it again. If you cannot ask (Codex with `approval_policy = \"never\"`), say which access is missing and stop.",
  "run-tests-kit":
    "**Sandbox.** The `npm install` in Phase 2 and `run-tests.js` call the network, and `run-tests.js` signs in. Run the command and do not assume it is blocked: a sandbox can allow the network and the folders it needs. If the command fails with a concrete sandbox error (network unreachable, `EPERM`, permission denied, read-only file system), ask for only the access that is missing (the network, write access to the folder in the error, or on macOS the keychain) and run it again. If you cannot ask (Codex with `approval_policy = \"never\"`), say which access is missing and stop.",
  "test-auth":
    "**Sandbox.** `eval-api.bundle.js auth` signs in, calls the network and writes to `~/.copilot-studio-cli`. Run the command and do not assume it is blocked: a sandbox can allow the network and the folders it needs. If the command fails with a concrete sandbox error (network unreachable, `EPERM`, permission denied, read-only file system), ask for only the access that is missing (the network, write access to the folder in the error, or on macOS the keychain) and run it again. If you cannot ask (Codex with `approval_policy = \"never\"`), say which access is missing and stop.",
  "validate":
    "**Sandbox.** `manage-agent.bundle.js validate` signs in, calls the network and writes to `~/.copilot-studio-cli`. `schema-lookup.bundle.js` is local. Run the command and do not assume it is blocked: a sandbox can allow the network and the folders it needs. If the command fails with a concrete sandbox error (network unreachable, `EPERM`, permission denied, read-only file system), ask for only the access that is missing (the network, write access to the folder in the error, or on macOS the keychain) and run it again. If you cannot ask (Codex with `approval_policy = \"never\"`), say which access is missing and stop.",
};
const SANDBOXED = Object.keys(SANDBOX);

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
  const paragraph = SANDBOX[name];
  check(`${name}: sandbox paragraph ${paragraph ? "present once" : "absent"}`,
    paragraph ? text.split(paragraph).length - 1 === 1 : !/\*\*Sandbox\.\*\*/.test(text));
  check(`${name}: exactly one sandbox paragraph`, (text.match(/\*\*Sandbox\.\*\*/g) || []).length === (paragraph ? 1 : 0));
  check(`${name}: runs network commands only if it is in SANDBOXED`, !needsNetwork || SANDBOXED.includes(name));
  check(`${name}: the sandbox paragraph comes before the locate section`, !paragraph || text.indexOf(paragraph) < text.indexOf("## Locate the plugin files"));
}

// Long commands and device-code sign-in: a foreground call blocks until the command ends,
// so the code line would reach the user too late. One paragraph, names each client's way.
const LONG_RUN =
  "A foreground call returns its output only when the command ends, so start the command so that it streams or yields, and keep its handle. " +
  "Claude Code: `run_in_background: true`, then keep the task ID. GitHub Copilot CLI: bash `mode: \"async\"`. " +
  "Codex: `exec_command` returns after a short wait with a `session_id` while the process still runs, and `write_stdin` with that `session_id`, empty `chars` and a `yield_time_ms` of 30000 polls it until the result has an `exit_code` (checked with Codex 0.162.1). " +
  "Read the output after a few seconds. When it has a `{\"status\":\"device_code\",...}` line, show the user the `verificationUri` and `userCode` in your message right away, before you poll again. Then poll until the command exits.";
for (const f of ["skills/manage-agent/SKILL.md", "skills/clone-agent/SKILL.md", "skills/test-auth/SKILL.md", "agents/copilot-studio-manage.md"]) {
  const text = fs.readFileSync(path.join(ROOT, f), "utf8").replace(/\r\n/g, "\n");
  check(`${f}: long-run / device-code paragraph, once`, text.split(LONG_RUN).length === 2);
  check(`${f}: no Claude-only background wording left`, !/start it in the background \(Claude Code/.test(text));
}
{
  const kit = fs.readFileSync(path.join(ROOT, "skills/run-tests-kit/SKILL.md"), "utf8");
  check("run-tests-kit: names run_in_background, async and the Codex session poll", /run_in_background: true/.test(kit) && /mode: "async"/.test(kit) && /exec_command/.test(kit) && /write_stdin/.test(kit));
  check("run-tests-kit: no unconditional run_in_background", !/Use `run_in_background: true` for this command/.test(kit));
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
