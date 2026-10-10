/**
 * The plugin folder can have spaces in its path (a checkout under "copilot oldschool",
 * C:\Users\Jane Doe\...). The skills write the commands as node "<pluginRoot>/scripts/x.bundle.js"
 * and the model replaces <pluginRoot> with the absolute path. This test
 *  - fails on an unquoted node <pluginRoot>/... in any skill or agent, and
 *  - takes real commands from the skills, substitutes a root with spaces and runs them in
 *    the platform shell (sh on POSIX, cmd on Windows), like the model's shell tool does.
 *
 * Run: node tests/plugin-root-spaces.test.js
 */

const cp = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const ROOT = path.join(__dirname, "..");
let passed = 0;
let failed = 0;
function check(name, ok, detail) {
  if (ok) passed++;
  else {
    failed++;
    console.log(`FAIL  ${name}${detail ? "\n      " + detail : ""}`);
  }
}

const files = [];
for (const d of fs.readdirSync(path.join(ROOT, "skills"))) {
  const f = path.join(ROOT, "skills", d, "SKILL.md");
  if (fs.existsSync(f)) files.push(f);
}
for (const a of fs.readdirSync(path.join(ROOT, "agents"))) files.push(path.join(ROOT, "agents", a));
files.push(path.join(ROOT, "hooks", "system-prompt.md"));
files.push(path.join(ROOT, "README.md"));

// 1. quoting
const commands = [];
const offenders = [];
for (const f of files) {
  const rel = path.relative(ROOT, f);
  const lines = fs.readFileSync(f, "utf8").replace(/\r\n/g, "\n").split("\n");
  lines.forEach((line, i) => {
    if (/\bnode\s+<(pluginRoot|plugin folder)>/.test(line) || /(--prefix|\bcp)\s+<pluginRoot>/.test(line)) offenders.push(`${rel}:${i + 1} ${line.trim()}`);
    const m = /\bnode\s+"<pluginRoot>\/scripts\/([a-z-]+\.bundle\.js)"(.*)$/.exec(line);
    if (m) commands.push({ rel, script: m[1], rest: m[2].replace(/\s+#.*$/, "").replace(/\\$/, "").trim() });
  });
}
check("no command uses an unquoted <pluginRoot> path", offenders.length === 0, offenders.slice(0, 5).join("\n      "));
check("some skill commands were found", commands.length > 20);
check("every command ends the quote after the file name", commands.every((c) => /^[a-z-]+\.bundle\.js$/.test(c.script)));

// 2. run real commands from a root with spaces
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "plugin root test-"));
const root = path.join(tmp, "my plugin", "copilot studio");
fs.mkdirSync(path.join(root, "scripts"), { recursive: true });
for (const s of ["schema-lookup.bundle.js", "connector-lookup.bundle.js"]) {
  fs.copyFileSync(path.join(ROOT, "scripts", s), path.join(root, "scripts", s));
}

fs.cpSync(path.join(ROOT, "reference"), path.join(root, "reference"), { recursive: true });

function run(cmd) {
  // exec uses sh -c on POSIX and cmd.exe /d /s /c on Windows
  return cp.spawnSync(cmd, { shell: true, encoding: "utf8", cwd: tmp, timeout: 60000 });
}

const pick = (script, startsWith) => commands.find((c) => c.script === script && c.rest.startsWith(startsWith));
const samples = [pick("schema-lookup.bundle.js", "kinds"), pick("connector-lookup.bundle.js", "list"), pick("schema-lookup.bundle.js", "summary")];
check("sample commands were found in the skills", samples.every(Boolean));
for (const c of samples.filter(Boolean)) {
  // a placeholder like <kind> in the example becomes a real word
  const rest = c.rest.replace(/<[^>]+>/g, "Question").replace(/\s+/g, " ");
  const cmd = `node "${root}${path.sep}scripts${path.sep}${c.script}" ${rest}`;
  const r = run(cmd);
  check(`runs from a path with spaces: ${c.script} ${rest} (${c.rel})`, r.status === 0 && r.stdout.length > 20, `status=${r.status} ${String(r.stderr).slice(0, 200)}`);
}
// the unquoted form really breaks, so the test is meaningful
const bad = run(`node ${root}${path.sep}scripts${path.sep}schema-lookup.bundle.js kinds`);
check("the unquoted form fails with spaces in the path", bad.status !== 0);

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`${passed + failed} tests: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
