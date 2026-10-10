/**
 * Tests for how the scripts find the native dependencies folder. The banner in
 * scripts/package.json (inlined into the bundles) picks the folder, and
 * hooks/setup.js records it. Other plugins use CLAUDE_PLUGIN_DATA and
 * ~/.copilot-studio-cli/plugin-paths.json too, so this plugin must prefer its own
 * names and accept the shared ones only when the folder holds its own install.
 *
 * Also covers `hooks/setup.js --ensure` (setup without a hook), with a fake npm.
 *
 * Run: node tests/plugin-data.test.js
 */

const cp = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const SCRIPTS = path.join(__dirname, "..", "scripts");
const SETUP = path.join(__dirname, "..", "hooks", "setup.js");
const REPO = path.resolve(__dirname, "..");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-data-test-"));

let passed = 0;
let failed = 0;
function check(name, ok, detail) {
  if (ok) {
    passed++;
    console.log(`  PASS  ${name}`);
  } else {
    failed++;
    console.log(`  FAIL  ${name}${detail ? "\n        " + detail : ""}`);
  }
}

// The banner is the same in all three bundles that use it.
const pkg = JSON.parse(fs.readFileSync(path.join(SCRIPTS, "package.json"), "utf8"));
const banners = ["chat-with-agent", "manage-agent", "eval-api"].map((n) => {
  const m = pkg.scripts["build:" + n].match(/--banner:js="(.*)"$/);
  return m && m[1];
});
check("banner found in all three build scripts", banners.every(Boolean));
check("the three banners are identical", new Set(banners).size === 1);
check("bundles start with the banner", ["chat-with-agent", "manage-agent", "eval-api"].every((n) =>
  fs.readFileSync(path.join(SCRIPTS, n + ".bundle.js"), "utf8").startsWith(banners[0])));
const banner = banners[0];

function dir(name, files) {
  const d = path.join(root, name);
  fs.mkdirSync(d, { recursive: true });
  for (const f of files || []) fs.writeFileSync(path.join(d, f), "{}");
  return d;
}

// Runs the banner in a child process with a fake home and a clean environment;
// prints the first NODE_PATH entry the banner added.
// The banner finds its plugin root from __dirname, which is "." under -e, so the child runs
// in <plugin root>/scripts. A sfcs-plugin-paths.json entry is { pluginData, pluginRoot }, or a
// plain folder name, which means "written by this copy" (the root the banner runs in).
const bannerRoot = dir("banner-root", []);
const bannerCwd = dir(path.join("banner-root", "scripts"), []);
const otherRoot = dir("other-copy-root", []);
function pathsBody(f, v, rootOfThisCopy) {
  if (f !== "sfcs-plugin-paths.json") return { pluginData: v };
  if (typeof v === "object" && v !== null && !Array.isArray(v) && "pluginData" in v) return v;
  return { pluginData: v, pluginRoot: rootOfThisCopy };
}
function resolve(env, home, pathsFiles) {
  const cfg = path.join(home, ".copilot-studio-cli");
  fs.rmSync(cfg, { recursive: true, force: true });
  fs.mkdirSync(cfg, { recursive: true });
  for (const [f, data] of Object.entries(pathsFiles || {})) {
    fs.writeFileSync(path.join(cfg, f), JSON.stringify(pathsBody(f, data, bannerRoot)));
  }
  const clean = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, HOME: home, USERPROFILE: home, ...env };
  const r = cp.spawnSync(process.execPath, ["-e", banner + ";console.log(process.env.NODE_PATH||'')"], { env: clean, encoding: "utf8", cwd: bannerCwd });
  if (r.status !== 0) return "ERROR " + r.stderr;
  return r.stdout.trim().split(path.delimiter)[0];
}
const nm = (d) => path.join(d, "node_modules");

const home = dir("home");
const own = dir("own", ["native-deps.json"]);
const own2 = dir("own2", ["native-deps.json"]);
const foreign = dir("foreign", ["package.json"]);
const foreign2 = dir("foreign2", []);

check("nothing set: no change", resolve({}, home) === "");
check("SFCS_PLUGIN_DATA wins over everything", resolve(
  { SFCS_PLUGIN_DATA: own, CLAUDE_PLUGIN_DATA: own2 }, home,
  { "sfcs-plugin-paths.json": own2, "plugin-paths.json": own2 }) === nm(own));
check("sfcs-plugin-paths.json is used without env", resolve({}, home, { "sfcs-plugin-paths.json": own }) === nm(own));
check("sfcs-plugin-paths.json wins over a foreign CLAUDE_PLUGIN_DATA", resolve(
  { CLAUDE_PLUGIN_DATA: foreign }, home, { "sfcs-plugin-paths.json": own }) === nm(own));
check("CLAUDE_PLUGIN_DATA with our install is used", resolve({ CLAUDE_PLUGIN_DATA: own }, home) === nm(own));
check("CLAUDE_PLUGIN_DATA of another plugin is ignored", resolve({ CLAUDE_PLUGIN_DATA: foreign }, home) === "");
check("foreign CLAUDE_PLUGIN_DATA falls through to the legacy file", resolve(
  { CLAUDE_PLUGIN_DATA: foreign }, home, { "plugin-paths.json": own }) === nm(own));
check("legacy plugin-paths.json with our install is used", resolve({}, home, { "plugin-paths.json": own }) === nm(own));
check("legacy plugin-paths.json of another plugin is ignored", resolve({}, home, { "plugin-paths.json": foreign }) === "");
check("legacy plugin-paths.json to a missing folder is ignored", resolve({}, home, { "plugin-paths.json": path.join(root, "gone") }) === "");
check("stale sfcs-plugin-paths.json (folder gone) falls through to CLAUDE_PLUGIN_DATA", resolve(
  { CLAUDE_PLUGIN_DATA: own }, home, { "sfcs-plugin-paths.json": path.join(root, "gone") }) === nm(own));
check("pluginData that is not a string does not crash", resolve({}, home, { "sfcs-plugin-paths.json": 123, "plugin-paths.json": { a: 1 } }) === "");
check("pluginData that is not a string falls through", resolve(
  { CLAUDE_PLUGIN_DATA: own }, home, { "sfcs-plugin-paths.json": ["x"] }) === nm(own));
check("broken sfcs-plugin-paths.json falls through", (() => {
  resolve({}, home);
  fs.writeFileSync(path.join(home, ".copilot-studio-cli", "sfcs-plugin-paths.json"), "{nope");
  const clean = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, HOME: home, USERPROFILE: home, CLAUDE_PLUGIN_DATA: own };
  const r = cp.spawnSync(process.execPath, ["-e", banner + ";console.log(process.env.NODE_PATH||'')"], { env: clean, encoding: "utf8" });
  return r.stdout.trim().split(path.delimiter)[0] === nm(own);
})());
check("sfcs-plugin-paths.json of another copy is ignored", resolve(
  {}, home, { "sfcs-plugin-paths.json": { pluginData: own, pluginRoot: otherRoot } }) === "");
check("sfcs-plugin-paths.json of another copy falls through to CLAUDE_PLUGIN_DATA with our marker", resolve(
  { CLAUDE_PLUGIN_DATA: own2 }, home, { "sfcs-plugin-paths.json": { pluginData: own, pluginRoot: otherRoot } }) === nm(own2));
check("sfcs-plugin-paths.json without pluginRoot is ignored", resolve({}, home, { "sfcs-plugin-paths.json": { pluginData: own } }) === "");
check("sfcs-plugin-paths.json with a pluginRoot that does not exist is ignored", resolve(
  {}, home, { "sfcs-plugin-paths.json": { pluginData: own, pluginRoot: path.join(root, "gone") } }) === "");
check("sfcs-plugin-paths.json with a pluginRoot that is not a string is ignored", resolve(
  {}, home, { "sfcs-plugin-paths.json": { pluginData: own, pluginRoot: 5 } }) === "");
check("pluginRoot reached through a symlink still counts as this copy", (() => {
  const link = path.join(root, "root-link");
  try { fs.symlinkSync(bannerRoot, link, "junction"); } catch { return true; }
  return resolve({}, home, { "sfcs-plugin-paths.json": { pluginData: own, pluginRoot: link } }) === nm(own);
})());
check("an existing NODE_PATH is kept after ours", (() => {
  const clean = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, HOME: home, USERPROFILE: home, SFCS_PLUGIN_DATA: own, NODE_PATH: foreign2 };
  const r = cp.spawnSync(process.execPath, ["-e", banner + ";console.log(process.env.NODE_PATH)"], { env: clean, encoding: "utf8" });
  return r.stdout.trim() === [nm(own), foreign2].join(path.delimiter);
})());

// hooks/setup.js: with an install that is already complete it only records the
// paths, so no npm run is needed here.
function setup(env, h) {
  const clean = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, HOME: h, USERPROFILE: h, ...env };
  return cp.spawnSync(process.execPath, [SETUP], { env: clean, encoding: "utf8" });
}
const sHome = dir("setup-home");
const sData = dir("setup-data");
fs.copyFileSync(path.join(SCRIPTS, "native-deps.json"), path.join(sData, "native-deps.json"));
fs.mkdirSync(path.join(sData, "node_modules"));
const envFile = path.join(root, "env-file");
fs.writeFileSync(envFile, "export KEEP=1\n");
const legacy = '{"pluginData":"/other/plugin"}';
fs.mkdirSync(path.join(sHome, ".copilot-studio-cli"));
fs.writeFileSync(path.join(sHome, ".copilot-studio-cli", "plugin-paths.json"), legacy);

const res = setup({ CLAUDE_PLUGIN_DATA: sData, CLAUDE_ENV_FILE: envFile }, sHome);
check("setup.js exits 0", res.status === 0, res.stderr);
const written = JSON.parse(fs.readFileSync(path.join(sHome, ".copilot-studio-cli", "sfcs-plugin-paths.json"), "utf8"));
check("setup.js writes sfcs-plugin-paths.json", written.pluginData === sData);
check("setup.js leaves the shared plugin-paths.json alone",
  fs.readFileSync(path.join(sHome, ".copilot-studio-cli", "plugin-paths.json"), "utf8") === legacy);
const env = fs.readFileSync(envFile, "utf8");
check("setup.js exports SFCS_PLUGIN_DATA and keeps earlier lines", env === `export KEEP=1\nexport SFCS_PLUGIN_DATA="${sData.replace(/[\\"$`]/g, "\\$&")}"\n`, env);
check("setup.js does not export CLAUDE_ variables", !/CLAUDE_/.test(env));

const sHome2 = dir("setup-home2");
const res2 = setup({ COPILOT_PLUGIN_DATA: sData }, sHome2);
check("setup.js works with COPILOT_PLUGIN_DATA and no env file", res2.status === 0 &&
  JSON.parse(fs.readFileSync(path.join(sHome2, ".copilot-studio-cli", "sfcs-plugin-paths.json"), "utf8")).pluginData === sData, res2.stderr);

const sHome3 = dir("setup-home3");
const res3 = setup({}, sHome3);
check("setup.js without a data folder does nothing", res3.status === 0 && !fs.existsSync(path.join(sHome3, ".copilot-studio-cli")));

// ---- the stable folder (~/.copilot-studio-cli/sfcs-data) and `setup.js --ensure`
// It comes after SFCS_PLUGIN_DATA and sfcs-plugin-paths.json (what a hook sets up) and before
// the shared names, which another plugin can fill. It exists only after --ensure ran.
const stableOf = (h) => path.join(h, ".copilot-studio-cli", "sfcs-data");

// fake npm: creates the three native modules, so --ensure can run offline
const fake = dir("fake-bin");
fs.writeFileSync(path.join(fake, "npm-fake.js"), `
const fs = require("fs"), path = require("path");
for (const n of ["keytar", "@azure/msal-node-extensions", "vscode-jsonrpc"]) {
  const d = path.join("node_modules", n);
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, "index.js"), "module.exports = {};");
}
// setup.js looks for keytar's binary and runs npm again when it is missing
fs.mkdirSync(path.join("node_modules", "keytar", "build", "Release"), { recursive: true });
fs.writeFileSync(path.join("node_modules", "keytar", "build", "Release", "keytar.node"), "");
if (process.env.FAKE_NPM_LOG) fs.appendFileSync(process.env.FAKE_NPM_LOG, "run\\n");
`);
fs.writeFileSync(path.join(fake, "npm"), `#!/bin/sh\nexec node "${path.join(fake, "npm-fake.js")}" "$@"\n`, { mode: 0o755 });
fs.writeFileSync(path.join(fake, "npm.cmd"), `@node "${path.join(fake, "npm-fake.js")}" %*\r\n`);

function ensure(env, h) {
  const clean = { PATH: fake + path.delimiter + process.env.PATH, SystemRoot: process.env.SystemRoot, HOME: h, USERPROFILE: h, SFCS_ENSURE_TIMEOUT_MS: "60000", ...env };
  return cp.spawnSync(process.execPath, [SETUP, "--ensure"], { env: clean, encoding: "utf8" });
}
function complete(d) {
  fs.mkdirSync(path.join(d, "node_modules"), { recursive: true });
  fs.copyFileSync(path.join(SCRIPTS, "native-deps.json"), path.join(d, "native-deps.json"));
}

const eHome = dir("ensure-home");
const eLog = path.join(root, "npm-runs.log");
const r1 = ensure({ FAKE_NPM_LOG: eLog }, eHome);
check("--ensure with nothing known installs into the stable folder", r1.status === 0 &&
  fs.existsSync(path.join(stableOf(eHome), "node_modules", "keytar")) &&
  fs.readFileSync(path.join(stableOf(eHome), "native-deps.json"), "utf8") === fs.readFileSync(path.join(SCRIPTS, "native-deps.json"), "utf8"), r1.stderr + r1.stdout);
check("--ensure says where the modules are", r1.stdout.includes(stableOf(eHome)), r1.stdout);
check("--ensure writes no paths file", !fs.existsSync(path.join(eHome, ".copilot-studio-cli", "sfcs-plugin-paths.json")) &&
  !fs.existsSync(path.join(eHome, ".copilot-studio-cli", "plugin-paths.json")));
check("after --ensure the banner finds the stable folder", (() => {
  const clean = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, HOME: eHome, USERPROFILE: eHome };
  const r = cp.spawnSync(process.execPath, ["-e", banner + ";console.log(process.env.NODE_PATH||'')"], { env: clean, encoding: "utf8" });
  return r.stdout.trim().split(path.delimiter)[0] === nm(stableOf(eHome));
})());
const r2 = ensure({ FAKE_NPM_LOG: eLog }, eHome);
check("--ensure again does not install again", r2.status === 0 && fs.readFileSync(eLog, "utf8").trim().split("\n").length === 1, r2.stderr);

// Another plugin's folder, named by the shared names (CLAUDE_PLUGIN_DATA, plugin-paths.json),
// can hold a marker with the same file name. --ensure must never install into it: a shell
// started from a Claude Code session has CLAUDE_PLUGIN_DATA set to the folder of whatever
// plugin that session ran last.
const eHome2 = dir("ensure-home2");
fs.mkdirSync(path.join(eHome2, ".copilot-studio-cli"));
const other = dir("other-plugin-data", ["native-deps.json"]);
fs.mkdirSync(path.join(other, "node_modules", "theirs"), { recursive: true });
const snapshot = (d) => fs.readdirSync(d, { recursive: true }).sort().join("|") + fs.readFileSync(path.join(d, "native-deps.json"), "utf8");
const before = snapshot(other);
const shared = JSON.stringify({ pluginData: other, pluginRoot: "/other/root" });
fs.writeFileSync(path.join(eHome2, ".copilot-studio-cli", "plugin-paths.json"), shared);
const r3 = ensure({ CLAUDE_PLUGIN_DATA: other, COPILOT_PLUGIN_DATA: other, PLUGIN_DATA: other }, eHome2);
check("--ensure installs into the stable folder, not into another plugin's folder", r3.status === 0 &&
  r3.stdout.includes(stableOf(eHome2)) && fs.existsSync(path.join(stableOf(eHome2), "node_modules", "keytar")), r3.stderr + r3.stdout);
check("--ensure leaves another plugin's folder untouched", snapshot(other) === before);
check("--ensure leaves the shared plugin-paths.json alone", fs.readFileSync(path.join(eHome2, ".copilot-studio-cli", "plugin-paths.json"), "utf8") === shared);
check("after --ensure the banner prefers the stable folder to that shared folder", (() => {
  const clean = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, HOME: eHome2, USERPROFILE: eHome2, CLAUDE_PLUGIN_DATA: other };
  const r = cp.spawnSync(process.execPath, ["-e", banner + ";console.log(process.env.NODE_PATH||'')"], { env: clean, encoding: "utf8" });
  return r.stdout.trim().split(path.delimiter)[0] === nm(stableOf(eHome2));
})());

// a failing install: exit 1 and a message, the folder is not marked as done
const eHome3 = dir("ensure-home3");
const failBin = dir("fail-bin");
fs.writeFileSync(path.join(failBin, "npm"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
fs.writeFileSync(path.join(failBin, "npm.cmd"), "@exit /b 1\r\n");
const r4 = cp.spawnSync(process.execPath, [SETUP, "--ensure"], {
  env: { PATH: failBin + path.delimiter + process.env.PATH, SystemRoot: process.env.SystemRoot, HOME: eHome3, USERPROFILE: eHome3, SFCS_ENSURE_TIMEOUT_MS: "20000" },
  encoding: "utf8",
});
check("--ensure with a failing npm exits 1 and names the log", r4.status === 1 && r4.stderr.includes("install.log") &&
  !fs.existsSync(path.join(stableOf(eHome3), "native-deps.json")), r4.stderr);

// The generic PLUGIN_DATA name is not used by the hook (Codex sets CLAUDE_PLUGIN_DATA for it too).
{
  const h = dir("setup-home-plain-name");
  const res = setup({ PLUGIN_DATA: sData }, h);
  check("setup.js ignores a bare PLUGIN_DATA", res.status === 0 && !fs.existsSync(path.join(h, ".copilot-studio-cli")), res.stderr);
}

// --ensure on a folder it cannot write to: one line, exit 1, no stack trace
{
  const h = dir("ensure-home-nowrite");
  fs.mkdirSync(path.join(h, ".copilot-studio-cli"));
  fs.writeFileSync(path.join(h, ".copilot-studio-cli", "sfcs-data"), "in the way"); // a file where the folder should be
  const res = ensure({}, h);
  const lines = res.stderr.trim().split(/\r?\n/);
  check("--ensure with an unwritable data folder exits 1 with one line", res.status === 1 && lines.length === 1, res.stderr);
  check("--ensure with an unwritable data folder names the folder and the sandbox", lines[0].includes("sfcs-data") && /outside the sandbox/.test(lines[0]), res.stderr);
  check("--ensure with an unwritable data folder prints no stack trace", !/\n\s+at |node:internal/.test(res.stderr) && res.stdout.trim() === "", res.stderr + res.stdout);
  if (process.platform !== "win32" && !(process.getuid && process.getuid() === 0)) {
    const h2 = dir("ensure-home-readonly");
    fs.mkdirSync(path.join(h2, ".copilot-studio-cli"));
    fs.chmodSync(path.join(h2, ".copilot-studio-cli"), 0o555);
    const r = ensure({}, h2);
    fs.chmodSync(path.join(h2, ".copilot-studio-cli"), 0o755);
    check("--ensure on a read-only home folder exits 1 with one line and no stack", r.status === 1 && r.stderr.trim().split(/\r?\n/).length === 1 &&
      /EACCES|EPERM|EROFS/.test(r.stderr) && /outside the sandbox/.test(r.stderr), r.stderr);
  }
}

// Another session's installer is simulated by a live process whose pid names the
// .install-<pid> folder. It finishes the install after a delay (or never).
const sleeper = path.join(fake, "installer-sim.js");
fs.writeFileSync(sleeper, `
const fs = require("fs"), path = require("path");
const [d, manifest, delay] = process.argv.slice(2);
setTimeout(() => {
  if (!Number(delay)) return;
  fs.mkdirSync(path.join(d, "node_modules"), { recursive: true });
  fs.copyFileSync(manifest, path.join(d, "native-deps.json"));
  process.exit(0);
}, Number(delay) || 60000);
`);
function simulateInstaller(d, delayMs) {
  fs.mkdirSync(d, { recursive: true });
  const c = cp.spawn(process.execPath, [sleeper, d, path.join(SCRIPTS, "native-deps.json"), String(delayMs)], { stdio: "ignore" });
  fs.mkdirSync(path.join(d, ".install-" + c.pid));
  return c;
}
const logOf = (d) => { try { return fs.readFileSync(path.join(d, "install.log"), "utf8"); } catch { return ""; } };

{
  // while another installer runs, --ensure waits in its own process and starts no --install child
  const h = dir("ensure-home-wait");
  const npmLog = path.join(root, "npm-runs-wait.log");
  const sim = simulateInstaller(stableOf(h), 2000);
  const t0 = Date.now();
  const res = ensure({ FAKE_NPM_LOG: npmLog }, h);
  check("--ensure waits for another session's install and then succeeds", res.status === 0 && res.stdout.includes("ready in") && Date.now() - t0 >= 1500, res.stderr + res.stdout);
  check("--ensure does not start --install while another installer runs", !fs.existsSync(npmLog) && !/pid \d+/.test(logOf(stableOf(h))), logOf(stableOf(h)));
  sim.kill();
}
{
  // it gives up at the timeout, says who was installing, and leaves their folder alone
  const h = dir("ensure-home-wait-timeout");
  const sim = simulateInstaller(stableOf(h), 0);
  const res = ensure({ SFCS_ENSURE_TIMEOUT_MS: "2500" }, h);
  check("--ensure times out while another installer runs", res.status === 1 && res.stderr.includes("another session is still installing") && res.stderr.includes(".install-" + sim.pid), res.stderr);
  check("--ensure starts no --install child for a live installer even at the timeout", !/pid \d+/.test(logOf(stableOf(h))) &&
    fs.existsSync(path.join(stableOf(h), ".install-" + sim.pid)), logOf(stableOf(h)));
  sim.kill();
}
{
  // a timeout that is not a positive number falls back to the default (110 s), it does not end the wait at once
  for (const bad of ["abc", "", "0", "-5"]) {
    const h = dir("ensure-home-badtimeout");
    fs.rmSync(path.join(h, ".copilot-studio-cli"), { recursive: true, force: true });
    const res = ensure({ SFCS_ENSURE_TIMEOUT_MS: bad }, h);
    check(`--ensure with SFCS_ENSURE_TIMEOUT_MS="${bad}" installs normally`, res.status === 0 && res.stdout.includes("ready in"), res.stderr + res.stdout);
  }
}
{
  // leftovers: .old-<pid> and .install-<pid> of dead pids are removed, .old-<pid> of a live pid stays
  const h = dir("ensure-home-old");
  const d = stableOf(h);
  const live = cp.spawn(process.execPath, ["-e", "setTimeout(function () {}, 60000)"], { stdio: "ignore" });
  const dead = cp.spawnSync(process.execPath, ["-e", ""]).pid;
  for (const n of [".old-" + live.pid, ".old-" + dead, ".install-" + dead]) {
    fs.mkdirSync(path.join(d, n, "node_modules"), { recursive: true });
  }
  const res = ensure({}, h);
  const left = fs.readdirSync(d).sort();
  check("--ensure removes .old and .install folders of dead pids", res.status === 0 && !left.includes(".old-" + dead) && !left.includes(".install-" + dead), left.join(" ") + res.stderr);
  check("--ensure keeps the .old folder of a live pid", left.includes(".old-" + live.pid), left.join(" "));
  live.kill();
}

// A timeout kills the whole install: the --install child and the npm below it
{
  const slowBin = dir("slow-bin");
  const pidFile = path.join(root, "slow-npm.pid");
  fs.writeFileSync(path.join(slowBin, "npm-slow.js"), `require("fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setTimeout(function () {}, 60000);\n`);
  fs.writeFileSync(path.join(slowBin, "npm"), `#!/bin/sh\nexec node "${path.join(slowBin, "npm-slow.js")}" "$@"\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(slowBin, "npm.cmd"), `@node "${path.join(slowBin, "npm-slow.js")}" %*\r\n`);
  const h = dir("ensure-home-slow");
  const res = cp.spawnSync(process.execPath, [SETUP, "--ensure"], {
    env: { PATH: slowBin + path.delimiter + process.env.PATH, SystemRoot: process.env.SystemRoot, HOME: h, USERPROFILE: h, SFCS_ENSURE_TIMEOUT_MS: "5000" },
    encoding: "utf8",
  });
  const npmPid = fs.existsSync(pidFile) ? Number(fs.readFileSync(pidFile, "utf8")) : 0;
  const installPid = Number((/pid (\d+)/.exec(logOf(stableOf(h))) || [])[1]);
  const isAlive = (pid) => { try { process.kill(pid, 0); return true; } catch (err) { return err.code === "EPERM"; } };
  const t = Date.now();
  while ((isAlive(npmPid) || isAlive(installPid)) && Date.now() - t < 3000) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
  check("a timed-out --ensure exits 1 and says it stopped the install", res.status === 1 && /stopped/.test(res.stderr), res.stderr);
  check("the slow install was running when the timeout hit", npmPid > 0 && installPid > 0, `npm=${npmPid} install=${installPid}`);
  check("a timed-out --ensure kills the --install child and what it started", !isAlive(npmPid) && !isAlive(installPid), `npm alive=${isAlive(npmPid)} install alive=${isAlive(installPid)}`);
  if (isAlive(npmPid)) process.kill(npmPid, "SIGKILL");
}

// After --ensure, the banner and doctor pick the folder it reported, whatever else is set.
{
  const { pluginData } = require("../scripts/src/doctor.js");
  const fsCtx = (h, env) => ({ fs, env, home: h, scriptPath: path.join(SCRIPTS, "manage-agent.bundle.js") });
  const mk = (n) => { const d = dir(n); complete(d); return d; };
  const a = mk("agree-a"), b = mk("agree-b");
  const foreignD = dir("agree-foreign", ["package.json"]);
  // [label, env, files in ~/.copilot-studio-cli, stable folder already complete, expected folder or "stable"]
  const cases = [
    ["nothing known", {}, {}, false, "stable"],
    ["SFCS env", { SFCS_PLUGIN_DATA: a }, { "plugin-paths.json": b }, false, a],
    ["sfcs file", {}, { "sfcs-plugin-paths.json": a }, false, a],
    ["CLAUDE_PLUGIN_DATA with a marker is not used for the install", { CLAUDE_PLUGIN_DATA: a }, {}, false, "stable"],
    ["old shared file with a marker is not used for the install", {}, { "plugin-paths.json": b }, false, "stable"],
    ["foreign shared names", { CLAUDE_PLUGIN_DATA: foreignD }, { "plugin-paths.json": foreignD }, false, "stable"],
    ["stable folder complete", {}, {}, true, "stable"],
    ["stable folder beats the shared names", { CLAUDE_PLUGIN_DATA: a }, { "plugin-paths.json": b }, true, "stable"],
    ["sfcs file beats the stable folder", {}, { "sfcs-plugin-paths.json": a }, true, a],
    ["sfcs file of another copy is not used", {}, { "sfcs-plugin-paths.json": { pluginData: a, pluginRoot: otherRoot } }, false, "stable"],
    ["sfcs file of another copy loses to the stable folder", {}, { "sfcs-plugin-paths.json": { pluginData: a, pluginRoot: otherRoot } }, true, "stable"],
    ["sfcs file without pluginRoot is not used", {}, { "sfcs-plugin-paths.json": { pluginData: a } }, false, "stable"],
  ];
  for (const [label, env, files, withStableDir, want] of cases) {
    const h = dir("agree-home-" + label.replace(/\W+/g, "-"));
    fs.mkdirSync(path.join(h, ".copilot-studio-cli"), { recursive: true });
    for (const [f, data] of Object.entries(files)) fs.writeFileSync(path.join(h, ".copilot-studio-cli", f), JSON.stringify(pathsBody(f, data, REPO)));
    if (withStableDir) complete(stableOf(h));
    const res = ensure(env, h);
    const m = /ready in (.*?)\r?\n/.exec(res.stdout);
    const reported = m && m[1];
    const expected = want === "stable" ? stableOf(h) : want;
    const clean = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, HOME: h, USERPROFILE: h, ...env };
    const probe = cp.spawnSync(process.execPath, ["-e", banner + ";console.log(process.env.NODE_PATH||'')"], { env: clean, encoding: "utf8", cwd: SCRIPTS });
    const first = probe.stdout.trim().split(path.delimiter)[0];
    const fromBanner = first ? path.dirname(first) : null;
    const fromDoctor = (pluginData(fsCtx(h, env)) || {}).dir || null;
    check(`--ensure, the banner and doctor agree: ${label}`,
      reported === expected && fromBanner === expected && fromDoctor === expected,
      `expected=${expected} ensure=${reported} banner=${fromBanner} doctor=${fromDoctor} ${res.stderr}`);
  }
}

fs.rmSync(root, { recursive: true, force: true });
console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
