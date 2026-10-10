/**
 * Tests for the install part of hooks/setup.js, run against a fake npm on PATH so
 * they need no network. They cover what the hook passes to npm, where npm's output
 * ends up, the fallback for a skipped keytar install script, and the env file.
 *
 * Run: node tests/setup-install.test.js
 */

const cp = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const SCRIPTS = path.join(__dirname, "..", "scripts");
const SETUP = path.join(__dirname, "..", "hooks", "setup.js");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "setup-install-test-"));

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
function dir(name) {
  const d = path.join(root, name);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

// The manifest must let npm 12 run keytar's install script.
const manifest = JSON.parse(fs.readFileSync(path.join(SCRIPTS, "native-deps.json"), "utf8"));
check("manifest allows the keytar install script", manifest.allowScripts && manifest.allowScripts.keytar === true);
check("manifest denies the msal-node-extensions install script (it only runs exit 0)", manifest.allowScripts && manifest.allowScripts["@azure/msal-node-extensions"] === false);

// Fake npm: records its arguments and the staged package.json, prints noise on
// stdout and stderr, and creates every dependency as a loadable module.
// FAKE_NPM_KEYTAR picks what happens to keytar's native binary:
//   unset      the install script ran, the binary is there
//   rebuild    no binary after install; `npm rebuild keytar` creates it
//   prebuild   no binary; `npm rebuild` does nothing, prebuild-install creates it
//   fail       no binary; neither creates it (prebuild-install exits 1)
const bin = dir("bin");
fs.writeFileSync(path.join(bin, "fake-npm.js"), `
const fs = require("fs");
const path = require("path");
const mode = process.env.FAKE_NPM_KEYTAR;
const binary = path.join("node_modules", "keytar", "build", "Release", "keytar.node");
function makeBinary(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "");
}
fs.appendFileSync(process.env.FAKE_NPM_LOG, JSON.stringify({ args: process.argv.slice(2), cwd: path.basename(process.cwd()), manifest: JSON.parse(fs.readFileSync("package.json", "utf8")) }) + "\\n");
console.log("npm stdout noise");
console.error("npm stderr noise");
if (process.argv[2] === "rebuild") {
  if (mode === "rebuild") makeBinary(binary);
  process.exit(0);
}
for (const n of Object.keys(JSON.parse(fs.readFileSync("package.json", "utf8")).dependencies)) {
  const m = path.join("node_modules", n);
  fs.mkdirSync(m, { recursive: true });
  if (n === "keytar") {
    fs.writeFileSync(path.join(m, "index.js"), "require('fs').accessSync(require('path').join(__dirname, 'build', 'Release', 'keytar.node'));");
    if (mode) {
      fs.mkdirSync(path.join("node_modules", "prebuild-install"), { recursive: true });
      fs.writeFileSync(path.join("node_modules", "prebuild-install", "bin.js"), mode === "fail"
        ? "console.log('prebuild fails'); process.exit(1);"
        : "const fs = require('fs'); fs.mkdirSync('build/Release', { recursive: true }); fs.writeFileSync('build/Release/keytar.node', ''); console.log('prebuild ran in ' + require('path').basename(process.cwd()));");
    } else {
      makeBinary(path.join(m, "build", "Release", "keytar.node"));
    }
  } else {
    fs.writeFileSync(path.join(m, "index.js"), "");
  }
}
`);
if (process.platform === "win32") {
  fs.writeFileSync(path.join(bin, "npm.cmd"), `@echo off\r\n"${process.execPath}" "%~dp0fake-npm.js" %*\r\n`);
} else {
  fs.writeFileSync(path.join(bin, "npm"), `#!/bin/sh\nexec "${process.execPath}" "$(dirname "$0")/fake-npm.js" "$@"\n`, { mode: 0o755 });
}

function runHook(data, home, extra) {
  const env = {
    PATH: bin + path.delimiter + process.env.PATH,
    SystemRoot: process.env.SystemRoot,
    HOME: home,
    USERPROFILE: home,
    CLAUDE_PLUGIN_DATA: data,
    ...extra,
  };
  return cp.spawnSync(process.execPath, [SETUP], { env, encoding: "utf8", timeout: 60000 });
}

// A fresh install.
const home = dir("home");
const data = dir("data");
const npmLog = path.join(root, "npm.log");
const res = runHook(data, home, { FAKE_NPM_LOG: npmLog });
check("fresh install: hook exits 0", res.status === 0, res.stderr);
check("npm output does not reach the hook stdout", res.stdout === "", JSON.stringify(res.stdout));
check("npm output does not reach the hook stderr", res.stderr === "", JSON.stringify(res.stderr));
const log = fs.readFileSync(path.join(data, "install.log"), "utf8");
check("npm output goes to install.log", log.includes("npm stdout noise") && log.includes("npm stderr noise"));
const calls = fs.readFileSync(npmLog, "utf8").trim().split("\n").map((l) => JSON.parse(l));
check("npm runs once", calls.length === 1, String(calls.length));
check("npm does not get --ignore-scripts", !calls[0].args.some((a) => a.startsWith("--ignore-scripts")), calls[0].args.join(" "));
check("the staged package.json carries allowScripts for keytar", calls[0].manifest.allowScripts && calls[0].manifest.allowScripts.keytar === true);
check("install is swapped in and the manifest copy is written",
  fs.existsSync(path.join(data, "node_modules", "keytar", "build", "Release", "keytar.node")) &&
  fs.readFileSync(path.join(data, "native-deps.json"), "utf8") === fs.readFileSync(path.join(SCRIPTS, "native-deps.json"), "utf8"));
check("no staging or old folders are left", fs.readdirSync(data).every((n) => !n.startsWith(".install-") && !n.startsWith(".old-")), fs.readdirSync(data).join(","));
check("an install with the binary in place does not run the fallback", !log.includes("prebuild") && calls.length === 1);

// npm skipped the keytar install script: the hook gets the binary itself.
const home2 = dir("home2");
const data2 = dir("data2");
const res2 = runHook(data2, home2, { FAKE_NPM_LOG: npmLog, FAKE_NPM_KEYTAR: "rebuild" });
const log2 = fs.readFileSync(path.join(data2, "install.log"), "utf8");
check("skipped keytar script: hook exits 0", res2.status === 0, res2.stderr);
check("skipped keytar script: npm rebuild keytar is tried first and is enough", log2.includes("running npm rebuild keytar") && !log2.includes("prebuild-install"));
check("skipped keytar script: keytar binary is in place", fs.existsSync(path.join(data2, "node_modules", "keytar", "build", "Release", "keytar.node")));

const data2b = dir("data2b");
const res2b = runHook(data2b, dir("home2b"), { FAKE_NPM_LOG: npmLog, FAKE_NPM_KEYTAR: "prebuild" });
const log2b = fs.readFileSync(path.join(data2b, "install.log"), "utf8");
check("rebuild did nothing: hook exits 0", res2b.status === 0, res2b.stderr);
check("rebuild did nothing: prebuild-install runs in the keytar folder", log2b.includes("prebuild ran in keytar"));
check("rebuild did nothing: keytar binary is in place", fs.existsSync(path.join(data2b, "node_modules", "keytar", "build", "Release", "keytar.node")));

// Nothing can get the binary: the hook fails, swaps nothing in, and leaves the old install alone.
const data4 = dir("data4");
fs.writeFileSync(path.join(data4, "native-deps.json"), "{\"old\":true}");
fs.mkdirSync(path.join(data4, "node_modules", "old-module"), { recursive: true });
fs.writeFileSync(path.join(data4, "node_modules", "old-module", "index.js"), "");
const res4 = runHook(data4, dir("home4"), { FAKE_NPM_LOG: npmLog, FAKE_NPM_KEYTAR: "fail" });
check("failed fetch: hook exits 1 and says so", res4.status === 1 && /failed, see/.test(res4.stderr), res4.status + " " + res4.stderr);
check("failed fetch: the log names the failure", /prebuild-install failed/.test(fs.readFileSync(path.join(data4, "install.log"), "utf8")));
check("failed fetch: the old node_modules and manifest copy are untouched",
  fs.existsSync(path.join(data4, "node_modules", "old-module", "index.js")) &&
  !fs.existsSync(path.join(data4, "node_modules", "keytar")) &&
  fs.readFileSync(path.join(data4, "native-deps.json"), "utf8") === "{\"old\":true}");

fs.rmSync(root, { recursive: true, force: true });
console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
