/**
 * Tests for how manage-agent finds the LanguageServerHost binary inside the
 * VS Code extension folder. Since 1.9 the macOS package keeps the binary under
 * lspOut/osx-arm64 or lspOut/osx-x64; Linux and Windows still use lspOut/.
 *
 * Run: node tests/lsp-binary-path.test.js
 */

// The functions live in the manage-agent source, which runs main() on load,
// so pull them out of the source text instead of requiring it.
const fs = require("fs");
const os = require("os");
const path = require("path");

const src = fs.readFileSync(path.join(__dirname, "..", "scripts", "src", "manage-agent.js"), "utf8");

function extract(name) {
  const start = src.search(new RegExp(`^(?:async )?function ${name}\\(`, "m"));
  if (start === -1) throw new Error(`function ${name} not found in manage-agent.js`);
  const end = src.indexOf("\n}\n", start);
  return src.slice(start, end + 3);
}

const EXTENSION_ID = "ms-copilotstudio.vscode-copilotstudio";
const BINARY_NAME = "LanguageServerHost";
const log = () => {};

// Run the extracted functions against a faked platform and arch.
function load(platform, arch) {
  const fakeOs = Object.assign({}, os, { platform: () => platform, arch: () => arch });
  const body = ["getPlatformSuffix", "parseSemver", "compareSemver", "searchInDir"].map(extract).join("\n");
  return new Function("os", "fs", "path", "log", "EXTENSION_ID", "BINARY_NAME", `${body}\nreturn { searchInDir, getPlatformSuffix };`)(
    fakeOs, fs, path, log, EXTENSION_ID, BINARY_NAME
  );
}

let passed = 0;
let failed = 0;

function assertEqual(actual, expected, label) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    passed++;
  } else {
    failed++;
    console.error(`FAIL: ${label}\n  expected: ${e}\n  actual:   ${a}`);
  }
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), "lsp-binary-path-"));

function makeExt(dir, version, suffix, relBinary) {
  const extDir = path.join(dir, `${EXTENSION_ID}-${version}-${suffix}`);
  const bin = path.join(extDir, ...relBinary.split("/"));
  fs.mkdirSync(path.dirname(bin), { recursive: true });
  fs.writeFileSync(bin, "");
  return bin;
}

function rel(dir, p) {
  return p ? path.relative(dir, p).split(path.sep).join("/") : p;
}

try {
  // macOS arm64, new layout with both architectures
  {
    const dir = path.join(root, "mac-new");
    makeExt(dir, "1.9.14", "darwin-arm64", "lspOut/osx-arm64/LanguageServerHost");
    makeExt(dir, "1.9.14", "darwin-arm64", "lspOut/osx-x64/LanguageServerHost");
    const r = load("darwin", "arm64").searchInDir(dir);
    assertEqual(rel(dir, r.binaryPath), `${EXTENSION_ID}-1.9.14-darwin-arm64/lspOut/osx-arm64/LanguageServerHost`, "mac arm64 picks osx-arm64 binary");
    assertEqual(rel(dir, r.lspOutDir), `${EXTENSION_ID}-1.9.14-darwin-arm64/lspOut/osx-arm64`, "mac arm64 cwd is the binary folder");
    assertEqual(r.version, "1.9.14", "mac arm64 version");
  }

  // macOS x64 picks the osx-x64 binary
  {
    const dir = path.join(root, "mac-x64");
    makeExt(dir, "1.9.14", "darwin-x64", "lspOut/osx-arm64/LanguageServerHost");
    makeExt(dir, "1.9.14", "darwin-x64", "lspOut/osx-x64/LanguageServerHost");
    const r = load("darwin", "x64").searchInDir(dir);
    assertEqual(rel(dir, r.binaryPath), `${EXTENSION_ID}-1.9.14-darwin-x64/lspOut/osx-x64/LanguageServerHost`, "mac x64 picks osx-x64 binary");
  }

  // macOS, old layout still works
  {
    const dir = path.join(root, "mac-old");
    makeExt(dir, "1.8.22", "darwin-arm64", "lspOut/LanguageServerHost");
    const r = load("darwin", "arm64").searchInDir(dir);
    assertEqual(rel(dir, r.binaryPath), `${EXTENSION_ID}-1.8.22-darwin-arm64/lspOut/LanguageServerHost`, "mac old layout");
    assertEqual(rel(dir, r.lspOutDir), `${EXTENSION_ID}-1.8.22-darwin-arm64/lspOut`, "mac old layout cwd");
  }

  // Newest folder without a binary falls back to the next version
  {
    const dir = path.join(root, "fallback");
    makeExt(dir, "1.8.22", "darwin-arm64", "lspOut/LanguageServerHost");
    fs.mkdirSync(path.join(dir, `${EXTENSION_ID}-1.9.20-darwin-arm64`, "lspOut"), { recursive: true });
    const r = load("darwin", "arm64").searchInDir(dir);
    assertEqual(r.version, "1.8.22", "falls back to an older version that has a binary");
  }

  // Read-only lookup (doctor): no chmod, reports the executable bit and skipped folders
  if (process.platform !== "win32") {
    const dir = path.join(root, "readonly");
    const bin = makeExt(dir, "1.8.22", "linux-x64", "lspOut/LanguageServerHost");
    fs.mkdirSync(path.join(dir, `${EXTENSION_ID}-1.9.20-linux-x64`, "lspOut"), { recursive: true });
    fs.chmodSync(bin, 0o644);
    const r = load("linux", "x64").searchInDir(dir, { readOnly: true });
    assertEqual(r.executable, false, "read-only lookup reports a binary that is not executable");
    assertEqual(r.skipped, ["1.9.20"], "read-only lookup lists the newer folder without a binary");
    assertEqual((fs.statSync(bin).mode & 0o111) === 0, true, "read-only lookup leaves the mode alone");
    const w = load("linux", "x64").searchInDir(dir);
    assertEqual(w.executable, true, "normal lookup fixes the executable bit");
    assertEqual((fs.statSync(bin).mode & 0o111) !== 0, true, "normal lookup sets the executable bit");
  }

  // Linux keeps lspOut/ and ignores an osx-* folder
  {
    const dir = path.join(root, "linux");
    makeExt(dir, "1.9.14", "linux-x64", "lspOut/LanguageServerHost");
    makeExt(dir, "1.9.14", "linux-x64", "lspOut/osx-x64/LanguageServerHost");
    const r = load("linux", "x64").searchInDir(dir);
    assertEqual(rel(dir, r.binaryPath), `${EXTENSION_ID}-1.9.14-linux-x64/lspOut/LanguageServerHost`, "linux x64 uses lspOut/");
  }

  // Linux arm64 looks for the linux-arm64 package
  {
    const dir = path.join(root, "linux-arm");
    makeExt(dir, "1.9.14", "linux-x64", "lspOut/LanguageServerHost");
    makeExt(dir, "1.9.14", "linux-arm64", "lspOut/LanguageServerHost");
    const m = load("linux", "arm64");
    assertEqual(m.getPlatformSuffix(), "linux-arm64", "linux arm64 suffix");
    assertEqual(rel(dir, m.searchInDir(dir).binaryPath), `${EXTENSION_ID}-1.9.14-linux-arm64/lspOut/LanguageServerHost`, "linux arm64 package");
  }

  // Windows uses the .exe under lspOut/
  {
    const dir = path.join(root, "win");
    makeExt(dir, "1.9.14", "win32-x64", "lspOut/LanguageServerHost.exe");
    const r = load("win32", "x64").searchInDir(dir);
    assertEqual(rel(dir, r.binaryPath), `${EXTENSION_ID}-1.9.14-win32-x64/lspOut/LanguageServerHost.exe`, "windows exe");
  }

  // Nothing installed
  {
    const dir = path.join(root, "empty");
    fs.mkdirSync(dir);
    assertEqual(load("darwin", "arm64").searchInDir(dir), null, "no extension");
    assertEqual(load("darwin", "arm64").searchInDir(path.join(root, "missing")), null, "no extensions folder");
  }
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
