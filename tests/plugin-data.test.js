/**
 * Tests for how the scripts find the native dependencies folder. The banner in
 * scripts/package.json (inlined into the bundles) picks the folder, and
 * hooks/setup.js records it. Other plugins use CLAUDE_PLUGIN_DATA and
 * ~/.copilot-studio-cli/plugin-paths.json too, so this plugin must prefer its own
 * names and accept the shared ones only when the folder holds its own install.
 *
 * Run: node tests/plugin-data.test.js
 */

const cp = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const SCRIPTS = path.join(__dirname, "..", "scripts");
const SETUP = path.join(__dirname, "..", "hooks", "setup.js");
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
function resolve(env, home, pathsFiles) {
  const cfg = path.join(home, ".copilot-studio-cli");
  fs.rmSync(cfg, { recursive: true, force: true });
  fs.mkdirSync(cfg, { recursive: true });
  for (const [f, data] of Object.entries(pathsFiles || {})) {
    fs.writeFileSync(path.join(cfg, f), JSON.stringify({ pluginData: data }));
  }
  const clean = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, HOME: home, USERPROFILE: home, ...env };
  const r = cp.spawnSync(process.execPath, ["-e", banner + ";console.log(process.env.NODE_PATH||'')"], { env: clean, encoding: "utf8" });
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

fs.rmSync(root, { recursive: true, force: true });
console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
