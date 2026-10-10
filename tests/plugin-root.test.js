/**
 * Skills name plugin files as <pluginRoot>/..., never as ${CLAUDE_SKILL_DIR}/../...:
 * only Claude Code fills that variable in. Every skill that uses a plugin file
 * carries the same "Locate the plugin files" section (one place that mentions the
 * variable, so Claude Code keeps working). Skills that run a bundle with native
 * modules also say how to install them without a hook.
 *
 * Run: node tests/plugin-root.test.js
 */

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const SKILLS = path.join(ROOT, "skills");

function expectedBlock(name, native) {
  let b =
    "## Locate the plugin files\n\n" +
    "`<pluginRoot>` below is the plugin folder, the one that holds `skills/`, `scripts/` and `templates/`. Work it out once and use absolute paths from then on.\n\n" +
    `1. This file is \`<pluginRoot>/skills/${name}/SKILL.md\`. In Claude Code \`<pluginRoot>\` is \`\${CLAUDE_SKILL_DIR}/../..\`. If that shows up as literal text, your client does not fill it in: take the folder two levels above the folder of this file.\n` +
    "2. Otherwise read `pluginRoot` from `~/.copilot-studio-cli/sfcs-plugin-paths.json`. The setup hook writes it, so it can name another installed copy.\n\n" +
    "Check that the file you need exists under `<pluginRoot>` before you use it. In commands, put the whole path in double quotes, as the examples do: the folder name can contain spaces.";
  if (native) {
    b +=
      " If a script fails with `Cannot find module` or says the native dependencies are missing, run " +
      "`node \"<pluginRoot>/hooks/setup.js\" --ensure` once and try again. It installs them without a hook and can take a minute.";
  }
  return b;
}

let passed = 0;
let failed = 0;
function check(name, ok) {
  if (ok) passed++;
  else {
    failed++;
    console.log(`FAIL  ${name}`);
  }
}

let withBlock = 0;
for (const name of fs.readdirSync(SKILLS)) {
  const file = path.join(SKILLS, name, "SKILL.md");
  if (!fs.existsSync(file)) continue;
  const text = fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n");
  const native = /(manage-agent|chat-with-agent|eval-api)\.bundle\.js/.test(text);
  const block = expectedBlock(name, native);
  const hasBlock = text.includes("## Locate the plugin files");
  const usesRoot = /<pluginRoot>\/(scripts|templates|patterns|tests|skills)\//.test(text.replace(block, ""));

  check(`${name}: ${"$"}{CLAUDE_SKILL_DIR} appears only in the locate section`, text.replace(block, "").indexOf("CLAUDE_SKILL_DIR") === -1);
  check(`${name}: uses plugin files, so it has the locate section`, !usesRoot || hasBlock);
  if (hasBlock) {
    withBlock++;
    check(`${name}: the locate section is the shared text, once`, text.split(block).length === 2 && text.split("## Locate the plugin files").length === 2);
    check(`${name}: the locate section comes before the first use`, (() => {
      const at = text.indexOf(block);
      const first = text.replace(block, "").search(/<pluginRoot>\/(scripts|templates|patterns|tests|skills)\//);
      return first === -1 || at < first;
    })());
  }
}
check("some skills have the locate section", withBlock >= 20);

for (const f of fs.readdirSync(path.join(ROOT, "agents"))) {
  const text = fs.readFileSync(path.join(ROOT, "agents", f), "utf8");
  check(`agents/${f}: no CLAUDE_SKILL_DIR`, !text.includes("CLAUDE_SKILL_DIR"));
}

console.log(`${passed + failed} tests: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
