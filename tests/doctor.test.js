/**
 * Tests for `manage-agent doctor`: the read-only environment check.
 *
 * The checks get a fake context (temp home folder, fake env, fake tools), so
 * nothing here touches the real home directory, keyring or network.
 *
 * Run: node tests/doctor.test.js
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const { runDoctor, formatLine } = require("../scripts/src/doctor.js");
const { resolveAuthMode } = require("../scripts/src/shared-auth.js");

const src = fs.readFileSync(path.join(__dirname, "..", "scripts", "src", "manage-agent.js"), "utf8");

// The helpers doctor reuses live in manage-agent.js, which runs main() on load,
// so pull them out of the source text.
function extract(name) {
  const start = src.search(new RegExp(`^(?:async )?function ${name}\\(`, "m"));
  if (start === -1) throw new Error(`function ${name} not found in manage-agent.js`);
  return src.slice(start, src.indexOf("\n}\n", start) + 3);
}
const log = () => {};
const helpers = new Function(
  "fs", "path", "log",
  [src.match(/^const CONFLICT_MARKER_RE = .*;$/m)[0]].concat([
    "findMcsYmlFiles", "conflictMarkerLines", "findConflictMarkers", "formatConflicts", "findAgentDir", "parseSemver", "compareSemver",
  ].map(extract)).join("\n") +
    "\nreturn { findConflictMarkers, formatConflicts, findAgentDir, compareSemver };"
)(fs, path, log);

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

const root = fs.mkdtempSync(path.join(os.tmpdir(), "doctor-test-"));
let counter = 0;
function tmp(name) {
  const dir = path.join(root, `${name}-${++counter}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

const EXT_BIN = { binaryPath: "/x/LanguageServerHost", lspOutDir: "/x", version: "1.9.14", executable: true, skipped: [] };

function makeDeps(over = {}) {
  return Object.assign(
    {
      locateBinary: () => ({ info: EXT_BIN, searchDirs: ["/h/.vscode/extensions"] }),
      compareSemver: helpers.compareSemver,
      minExtensionVersion: "1.2.90",
      resolveAuthMode,
      findAgentDir: helpers.findAgentDir,
      findConflictMarkers: helpers.findConflictMarkers,
      formatConflicts: helpers.formatConflicts,
    },
    over
  );
}

// A context with a temp home, a fake env and fake tools. Each test overrides what it needs.
function makeCtx(over = {}) {
  const home = tmp("home");
  const scripts = tmp("scripts");
  fs.writeFileSync(path.join(scripts, "native-deps.json"), '{"dependencies":{}}');
  return Object.assign(
    {
      fs,
      env: {},
      platform: "linux",
      arch: "x64",
      release: "6.8.0",
      home,
      cwd: tmp("cwd"),
      nodeVersion: "22.1.0",
      scriptPath: path.join(scripts, "manage-agent.bundle.js"),
      workspace: null,
      tryRequire: () => ({}),
      stubKeytar: () => {},
    },
    over
  );
}

// Returns the entries of one named check (or all when name is omitted).
function run(ctx, deps, name) {
  const r = runDoctor(ctx, deps || makeDeps());
  return name ? r.checks.filter((c) => c.name === name) : r.checks;
}

function level(ctx, deps, name) {
  return run(ctx, deps, name).map((c) => c.level);
}

function writeFile(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

// The key structure of a conn.json written by a real clone (values are made up).
const REAL_CONN = JSON.stringify({
  DataverseEndpoint: "https://org.crm.dynamics.com/",
  EnvironmentId: "e",
  EnvironmentDisplayName: "Dev",
  AccountInfo: { AccountId: "a", TenantId: "t", AccountEmail: "x@example.com", clusterCategory: 3 },
  AgentId: "b",
  ComponentCollectionId: null,
  SolutionVersions: { SolutionVersions: {}, CopilotStudioSolutionVersion: "1" },
  AgentManagementEndpoint: "https://x/",
  AuthoringShape: 0,
});

function makeWorkspace(opts = {}) {
  const ws = tmp("ws");
  if (opts.conn !== false) writeFile(path.join(ws, ".mcs", "conn.json"), opts.conn || REAL_CONN);
  if (opts.bot !== false) writeFile(path.join(ws, ".mcs", "botdefinition.json"), opts.bot || "{}");
  writeFile(path.join(ws, "settings.mcs.yml"), opts.settings || "displayName: Test\n");
  writeFile(path.join(ws, "agent.mcs.yml"), "kind: GptComponentMetadata\n");
  if (opts.topic) writeFile(path.join(ws, "topics", "T.topic.mcs.yml"), opts.topic);
  return ws;
}

try {
  // ---- node
  assertEqual(level(makeCtx({ nodeVersion: "18.0.0" }), null, "node"), ["OK"], "node 18 is fine");
  assertEqual(level(makeCtx({ nodeVersion: "20.11.1" }), null, "node"), ["OK"], "node 20 is fine");
  assertEqual(level(makeCtx({ nodeVersion: "16.20.2" }), null, "node"), ["FAIL"], "node 16 fails");
  assertEqual(level(makeCtx({ nodeVersion: undefined }), null, "node"), ["FAIL"], "unknown node version fails, no throw");

  // ---- system and shell hints
  {
    const ps5 = run(makeCtx({ platform: "win32", env: { PSModulePath: "C:\\Users\\a\\Documents\\WindowsPowerShell\\Modules;C:\\Windows\\system32\\WindowsPowerShell\\v1.0\\Modules" } }), null, "system")[0];
    assertEqual(/5\.1/.test(ps5.message) && /&&/.test(ps5.hint), true, "Windows PowerShell 5.1 is named, with the && hint");
    const ps7 = run(makeCtx({ platform: "win32", env: { PSModulePath: "C:\\Program Files\\PowerShell\\7\\Modules" } }), null, "system")[0];
    assertEqual(/pwsh/.test(ps7.message), true, "PowerShell 7 is named");
    const gb = run(makeCtx({ platform: "win32", env: { MSYSTEM: "MINGW64", PSModulePath: "C:\\x\\WindowsPowerShell\\Modules" } }), null, "system")[0];
    assertEqual(/Git Bash/.test(gb.message) && !gb.hint, true, "Git Bash is not reported as PowerShell");
    const unknown = run(makeCtx({ platform: "win32", env: {} }), null, "system")[0];
    assertEqual(unknown.level, "OK", "Windows without PSModulePath still reports");
    const lin = run(makeCtx({ env: { SHELL: "/bin/zsh" } }), null, "system")[0];
    assertEqual(/linux x64/.test(lin.message) && /zsh/.test(lin.message), true, "Linux line has os, arch and shell");
  }

  // ---- sign-in mode (same rule as the sign-in itself)
  {
    const msg = (env, platform) => run(makeCtx({ env, platform: platform || "linux" }), null, "session")[0];
    assertEqual([msg({ SSH_CONNECTION: "1 2 3 4", DISPLAY: ":0" }).level, /device code.*SSH/.test(msg({ SSH_CONNECTION: "1" }).message)], ["OK", true], "SSH session: device code, no warning");
    assertEqual(/device code.*no display/.test(msg({}).message), true, "Linux without display: device code");
    assertEqual(/browser/.test(msg({ DISPLAY: ":0" }).message), true, "Linux with display: browser");
    assertEqual(/browser/.test(msg({ WAYLAND_DISPLAY: "wayland-0" }).message), true, "Wayland counts as a display");
    assertEqual(/browser/.test(msg({}, "darwin").message), true, "macOS without DISPLAY: browser");
    assertEqual(/device code.*CPS_AUTH_MODE/.test(msg({ CPS_AUTH_MODE: "device", DISPLAY: ":0" }).message), true, "CPS_AUTH_MODE is honoured");
    assertEqual(msg({ CPS_AUTH_MODE: "bogus" }).level, "WARN", "a bad CPS_AUTH_MODE warns");
    assertEqual(level(makeCtx(), makeDeps({ resolveAuthMode: () => { throw new Error("x"); } }), "session"), ["WARN"], "a throwing rule warns");
  }

  // ---- LanguageServerHost
  assertEqual(level(makeCtx(), null, "lsp"), ["OK"], "lsp found");
  assertEqual(level(makeCtx(), makeDeps({ locateBinary: () => ({ info: null, searchDirs: ["/a", "/b"] }) }), "lsp"), ["FAIL"], "lsp missing fails");
  assertEqual(
    level(makeCtx(), makeDeps({ locateBinary: () => ({ info: { ...EXT_BIN, executable: false }, searchDirs: [] }) }), "lsp"),
    ["WARN"], "lsp not executable warns, manage-agent chmods it"
  );
  {
    const r = run(makeCtx(), makeDeps({ locateBinary: () => ({ info: { ...EXT_BIN, version: "1.8.22", skipped: ["1.9.20"] }, searchDirs: [] }) }), "lsp");
    assertEqual(r.map((c) => c.level), ["WARN"], "lsp WARN when the newest folder has no binary");
    assertEqual(/1\.9\.20/.test(r[0].message), true, "the folder without a binary is named");
  }
  assertEqual(
    level(makeCtx(), makeDeps({ locateBinary: () => ({ info: { ...EXT_BIN, version: "1.2.10" }, searchDirs: [] }) }), "lsp"),
    ["WARN"], "lsp older than the tested version warns"
  );
  assertEqual(
    level(makeCtx(), makeDeps({ locateBinary: () => ({ info: { binaryPath: "/c/bin", lspOutDir: "/c", version: "custom" }, searchDirs: [] }) }), "lsp"),
    ["OK"], "CPS_LSP_BINARY override is fine"
  );
  assertEqual(
    level(makeCtx({ env: { CPS_LSP_BINARY: path.join(root, "nope") } }), null, "lsp"),
    ["WARN", "OK"], "CPS_LSP_BINARY pointing nowhere warns and falls back"
  );

  assertEqual(
    level(makeCtx({ env: { CPS_LSP_BINARY: path.join(root, "nope") } }), makeDeps({ locateBinary: () => ({ info: null, searchDirs: [] }) }), "lsp"),
    ["WARN", "FAIL"], "CPS_LSP_BINARY pointing nowhere and no extension fails"
  );

  // ---- native dependencies and the setup marker
  {
    const data = tmp("data");
    const ctx = makeCtx({ env: { CLAUDE_PLUGIN_DATA: data } });
    const manifest = fs.readFileSync(path.join(path.dirname(ctx.scriptPath), "native-deps.json"), "utf8");
    assertEqual(level(ctx, null, "native-marker"), ["WARN"], "marker missing warns");
    writeFile(path.join(data, "native-deps.json"), manifest + " ");
    assertEqual(level(ctx, null, "native-marker"), ["WARN"], "marker that differs warns");
    writeFile(path.join(data, "native-deps.json"), manifest);
    assertEqual(level(ctx, null, "native-marker"), ["OK"], "matching marker is fine");
    assertEqual(level(ctx, null, "native"), ["OK", "OK", "OK"], "all three modules load");

    writeFile(path.join(data, "install.log"), "boom");
    const bad = run(
      makeCtx({ env: { CLAUDE_PLUGIN_DATA: data }, tryRequire: (n) => { if (n === "keytar") throw new Error("libsecret-1.so.0 missing\nstack"); return {}; } }),
      null, "native"
    );
    assertEqual(bad.map((c) => c.level), ["FAIL", "OK", "OK"], "keytar failing to load fails on Linux");
    assertEqual(bad[0].hint.includes(path.join(data, "install.log")), true, "install.log is shown when it exists");
    assertEqual(bad[0].message.includes("stack"), false, "only the first error line is shown");
    const win = run(
      makeCtx({ platform: "win32", env: { CLAUDE_PLUGIN_DATA: data }, tryRequire: (n) => { if (n === "keytar") throw new Error("no binding"); return {}; } }),
      null, "native"
    );
    assertEqual(win.map((c) => c.level), ["WARN", "OK", "OK"], "keytar failing on Windows only warns");
    // msal-node-extensions needs the keytar stub on Windows, like msal-cache.js
    let stubbed = false;
    const winStub = run(
      makeCtx({
        platform: "win32",
        env: { CLAUDE_PLUGIN_DATA: data },
        stubKeytar: () => { stubbed = true; },
        tryRequire: (n) => { if (n === "keytar" || (n === "@azure/msal-node-extensions" && !stubbed)) throw new Error("no binding"); return {}; },
      }),
      null, "native"
    );
    assertEqual(winStub.map((c) => c.level), ["WARN", "OK", "OK"], "on Windows msal-node-extensions loads after the keytar stub");
    const winNoStub = run(
      makeCtx({ platform: "win32", env: { CLAUDE_PLUGIN_DATA: data }, tryRequire: (n) => { if (n !== "vscode-jsonrpc") throw new Error("no binding"); return {}; } }),
      null, "native"
    );
    assertEqual(winNoStub.map((c) => c.level), ["WARN", "FAIL", "OK"], "on Windows a broken msal-node-extensions still fails");
    const jsonrpc = run(makeCtx({ env: { CLAUDE_PLUGIN_DATA: data }, tryRequire: (n) => { if (n === "vscode-jsonrpc") throw new Error("gone"); return {}; } }), null, "native");
    assertEqual(jsonrpc.map((c) => c.level), ["OK", "OK", "FAIL"], "a missing vscode-jsonrpc fails");
  }
  {
    const r = run(makeCtx({ tryRequire: () => { throw new Error("Cannot find module"); } }), null, "native");
    assertEqual(r.map((c) => c.level), ["FAIL", "FAIL", "FAIL"], "no plugin data and no modules fails");
    assertEqual(/plugin/.test(r[0].hint), true, "hint explains the missing plugin data folder");
  }
  {
    // plugin data found through plugin-paths.json, like the bundles do
    const data = tmp("data");
    const ctx = makeCtx();
    writeFile(path.join(ctx.home, ".copilot-studio-cli", "plugin-paths.json"), JSON.stringify({ pluginData: data, pluginRoot: data }));
    let seen = null;
    ctx.tryRequire = (n, dirs) => { seen = dirs; return {}; };
    run(ctx, null, "native");
    assertEqual(seen, [path.join(data, "node_modules")], "modules are looked up in the folder from plugin-paths.json");
  }

  // ---- plugin-paths.json
  {
    const ctx = makeCtx();
    assertEqual(level(ctx, null, "plugin-paths"), ["WARN"], "no plugin-paths.json warns");
    assertEqual(level(makeCtx({ env: { CLAUDE_PLUGIN_DATA: "/d" } }), null, "plugin-paths"), ["OK"], "no file is fine when CLAUDE_PLUGIN_DATA is set");
    const file = path.join(ctx.home, ".copilot-studio-cli", "plugin-paths.json");
    writeFile(file, "{not json");
    assertEqual(level(ctx, null, "plugin-paths"), ["FAIL"], "broken JSON fails");
    writeFile(file, JSON.stringify({ pluginData: path.join(root, "gone"), pluginRoot: root }));
    const r = run(ctx, null, "plugin-paths");
    assertEqual([r[0].level, r[0].message.includes("pluginData")], ["WARN", true], "a path that does not exist warns and is named");
    writeFile(file, JSON.stringify({ pluginData: root, pluginRoot: root }));
    assertEqual(level(ctx, null, "plugin-paths"), ["OK"], "existing paths are fine");
    // another plugin owns the file
    writeFile(file, JSON.stringify({ pluginData: root, pluginRoot: tmp("other-plugin") }));
    const foreign = run(ctx, null, "plugin-paths")[0];
    assertEqual([foreign.level, /another plugin/.test(foreign.message), /outside a Claude Code session/.test(foreign.hint)], ["WARN", true, true], "pluginRoot of another plugin warns and explains");
    const marker = run(ctx, null, "native-marker");
    assertEqual(marker.every((c) => c.level !== "WARN" || !/Start a new session\.$/.test(c.hint || "")), true, "the marker hint does not just say start a new session");
    writeFile(file, "[]");
    assertEqual(level(ctx, null, "plugin-paths"), ["WARN"], "wrong shape warns");
  }

  // ---- Secret Service (Linux only)
  assertEqual(level(makeCtx(), null, "secret-service"), ["WARN"], "Linux without D-Bus warns about plaintext");
  assertEqual(
    run(makeCtx(), null, "secret-service")[0].message.includes("plaintext"), true, "the plaintext fallback is named"
  );
  assertEqual(level(makeCtx({ env: { DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus" } }), null, "secret-service"), ["OK"], "D-Bus session is fine");
  {
    const runtime = tmp("run");
    writeFile(path.join(runtime, "bus"), "");
    assertEqual(level(makeCtx({ env: { XDG_RUNTIME_DIR: runtime } }), null, "secret-service"), ["OK"], "a bus socket in XDG_RUNTIME_DIR counts");
  }
  assertEqual(level(makeCtx({ platform: "darwin" }), null, "secret-service"), [], "no Secret Service line on macOS");
  assertEqual(level(makeCtx({ platform: "win32" }), null, "secret-service"), [], "no Secret Service line on Windows");

  // ---- token cache: names, sizes and times only
  {
    const ctx = makeCtx();
    assertEqual(level(ctx, null, "token-cache"), ["OK"], "no cache folder is fine");
    const dir = path.join(ctx.home, ".copilot-studio-cli");
    writeFile(path.join(dir, "manage-agent.cache.json"), "SECRET-TOKEN-CONTENT");
    writeFile(path.join(dir, "chat.cache.json"), "SECRET-TOKEN-CONTENT");
    const reads = [];
    ctx.fs = Object.assign({}, fs, { readFileSync: (f, ...a) => { reads.push(String(f)); return fs.readFileSync(f, ...a); } });
    const r = run(ctx, null, "token-cache")[0];
    assertEqual(r.level, "OK", "cache files are listed");
    assertEqual(/manage-agent\.cache\.json \(20 bytes, \d{4}-\d{2}-\d{2}\)/.test(r.message), true, "name, size and date are shown");
    assertEqual(r.message.includes("SECRET"), false, "contents never show up");
    assertEqual(reads.some((f) => f.endsWith(".cache.json")), false, "cache files are never opened");
    for (let i = 0; i < 6; i++) writeFile(path.join(dir, `x${i}.cache.json`), "");
    assertEqual(/and 4 more/.test(run(ctx, null, "token-cache")[0].message), true, "a long list is cut");
  }

  // ---- pac (information only, never started)
  assertEqual(level(makeCtx(), null, "pac"), ["OK"], "pac missing is fine, it is optional");
  {
    const bin = tmp("bin");
    const pac = path.join(bin, "pac");
    writeFile(pac, "");
    const env = { PATH: bin };
    const one = (store, e) => run(makeCtx({ env: e || env }), null, "pac")[0];
    assertEqual(one().level, "OK", "pac without a readable version is OK");
    assertEqual(/version not read/.test(one().message), true, "and says the version was not read");
    fs.mkdirSync(path.join(bin, ".store", "microsoft.powerapps.cli.tool", "2.12.2"), { recursive: true });
    const old = one();
    assertEqual([old.level, /pac 2\.12\.2/.test(old.message), /our own tests/.test(old.hint)], ["OK", true, true], "2.12.2 from the dotnet tool store is OK and carries the note");
    fs.mkdirSync(path.join(bin, ".store", "microsoft.powerapps.cli.tool", "2.13.1"), { recursive: true });
    const cur = one();
    assertEqual([cur.level, /pac 2\.13\.1/.test(cur.message), cur.hint], ["OK", true, undefined], "the newest folder wins, 2.13.1 has no note");
    assertEqual(/only used by the optional pac backend/.test(cur.message), true, "the message says what pac is for");
    const win = tmp("winbin");
    writeFile(path.join(win, "pac.cmd"), "");
    fs.mkdirSync(path.join(win, "Microsoft.PowerApps.CLI.2.11.2"));
    fs.mkdirSync(path.join(win, "Microsoft.PowerApps.CLI.2.12.2"));
    assertEqual(/pac 2\.12\.2/.test(run(makeCtx({ platform: "win32", env: { PATH: win } }), null, "pac")[0].message), true, "Windows installer folders are read");
    assertEqual(one(null, { CPS_PAC_PATH: pac }).level, "OK", "CPS_PAC_PATH is used");
    const missing = one(null, { CPS_PAC_PATH: path.join(root, "nope"), PATH: bin });
    assertEqual([missing.level, /CPS_PAC_PATH points to a missing file/.test(missing.message)], ["OK", true], "a wrong CPS_PAC_PATH falls back to PATH, no FAIL");
  }

  // ---- workspace
  assertEqual(run(makeCtx(), null, "workspace").map((c) => c.level), ["OK"], "an empty folder is not a workspace, no failure");
  assertEqual(level(makeCtx({ workspace: path.join(root, "nope") }), null, "workspace"), ["FAIL"], "--workspace that does not exist fails");
  {
    const ws = makeWorkspace({ topic: "kind: AdaptiveDialog\n" });
    const all = run(makeCtx({ workspace: ws }));
    const pick = (n) => all.filter((c) => c.name === n).map((c) => c.level);
    assertEqual([pick("conn.json"), pick("botdefinition"), pick("workspace-type"), pick("conflicts")], [["OK"], ["OK"], ["OK"], ["OK"]], "a healthy classic workspace is all OK");
  }
  {
    const ws = makeWorkspace();
    const ctx = makeCtx({ cwd: ws });
    assertEqual(level(ctx, null, "conn.json"), ["OK"], "cwd that looks like a workspace is checked without --workspace");
  }
  {
    const ws = makeWorkspace({ bot: false });
    assertEqual(level(makeCtx({ workspace: ws }), null, "botdefinition"), ["FAIL"], "missing botdefinition.json fails (#155)");
  }
  {
    const ws = makeWorkspace({ conn: false });
    assertEqual(level(makeCtx({ workspace: ws }), null, "conn.json"), ["FAIL"], "missing conn.json fails");
    const ws2 = makeWorkspace({ conn: "{oops" });
    assertEqual(level(makeCtx({ workspace: ws2 }), null, "conn.json"), ["FAIL"], "broken conn.json fails");
    const ws5 = makeWorkspace({ conn: '{"AgentId":"a","EnvironmentId":"e","TenantId":"t"}' });
    assertEqual(level(makeCtx({ workspace: ws5 }), null, "conn.json"), ["OK"], "the eval fixture shape (top level TenantId) is accepted too");
    const ws6 = makeWorkspace({ conn: '{"AgentId":"a","EnvironmentId":"e","AccountInfo":{"AccountId":"x"}}' });
    assertEqual(run(makeCtx({ workspace: ws6 }), null, "conn.json")[0].message.endsWith("no TenantId"), true, "AccountInfo without TenantId is named");
    const ws3 = makeWorkspace({ conn: '{"AgentId":"a"}' });
    const r = run(makeCtx({ workspace: ws3 }), null, "conn.json")[0];
    assertEqual([r.level, /EnvironmentId, TenantId/.test(r.message)], ["WARN", true], "conn.json without ids warns and names them");
    const ws4 = makeWorkspace({ bot: "{oops" });
    assertEqual(level(makeCtx({ workspace: ws4 }), null, "botdefinition"), ["FAIL"], "broken botdefinition.json fails");
  }
  {
    const ws = makeWorkspace({ topic: "a: 1\n<<<<<<< HEAD\nb: 2\n=======\nb: 3\n>>>>>>> server\n" });
    const r = run(makeCtx({ workspace: ws }), null, "conflicts")[0];
    assertEqual([r.level, /T\.topic\.mcs\.yml \(lines 2, 4, 6\)/.test(r.message)], ["FAIL", true], "conflict markers fail and name file and lines");
  }
  {
    const ws = makeWorkspace({ settings: "template: cliagent-1.0.0\n" });
    assertEqual(level(makeCtx({ workspace: ws }), null, "workspace-type"), ["WARN"], "CLI agent workspace warns");
    const ws2 = makeWorkspace({ settings: "configuration:\n  authoringModel: CliCopilot\n" });
    assertEqual(level(makeCtx({ workspace: ws2 }), null, "workspace-type"), ["WARN"], "authoringModel CliCopilot counts as CLI agent");
  }
  {
    // UNC path on Windows (the path is faked, nothing is read from a share)
    const deps = makeDeps({ findAgentDir: () => "\\\\srv\\share\\agent" });
    const ctx = makeCtx({ platform: "win32", workspace: root });
    assertEqual(level(ctx, deps, "workspace-path"), ["FAIL"], "UNC workspace fails on Windows");
    assertEqual(level(makeCtx({ platform: "linux", workspace: root }), deps, "workspace-path"), [], "UNC rule is Windows only");
  }

  // ---- never throws
  {
    const boom = () => { throw new Error("broken"); };
    const brokenFs = new Proxy({}, { get: () => boom });
    const ctx = makeCtx({ fs: brokenFs, workspace: root, tryRequire: boom, stubKeytar: boom });
    const deps = makeDeps({ locateBinary: boom, findAgentDir: boom, findConflictMarkers: boom });
    let r;
    let threw = false;
    try {
      r = runDoctor(ctx, deps);
    } catch {
      threw = true;
    }
    assertEqual(threw, false, "doctor survives a broken fs and broken helpers");
    assertEqual(r.checks.every((c) => ["OK", "WARN", "FAIL"].includes(c.level)), true, "every entry still has a level");
    assertEqual(r.checks.filter((c) => c.name === "lsp").every((c) => c.level === "WARN"), true, "a check that throws becomes a WARN");

    let empty;
    threw = false;
    try {
      empty = runDoctor({}, {});
    } catch {
      threw = true;
    }
    assertEqual(threw, false, "doctor survives an empty context");
    assertEqual(Array.isArray(empty.checks) && empty.checks.length >= 8, true, "an empty context still reports every check");
  }

  // ---- JSON shape and status
  {
    const r = runDoctor(makeCtx({ env: { DISPLAY: ":0" } }), makeDeps());
    assertEqual(Object.keys(r), ["status", "summary", "checks"], "result keys");
    assertEqual(Object.keys(r.summary), ["ok", "warn", "fail"], "summary keys");
    assertEqual(r.checks.every((c) => typeof c.name === "string" && typeof c.message === "string"), true, "each check has a name and a message");
    assertEqual(r.summary.ok + r.summary.warn + r.summary.fail, r.checks.length, "summary adds up");
    assertEqual(JSON.parse(JSON.stringify(r)), r, "result survives JSON");
    const fail = runDoctor(makeCtx({ nodeVersion: "12.0.0" }), makeDeps());
    assertEqual([r.summary.fail, r.status], [0, "ok"], "status is ok without FAIL");
    assertEqual(fail.status, "fail", "status is fail with a FAIL");
    // WARN alone keeps status ok
    const warnOnly = runDoctor(makeCtx({ env: { SSH_CONNECTION: "x" } }), makeDeps());
    assertEqual([warnOnly.summary.warn > 0, warnOnly.status], [true, "ok"], "WARN alone keeps status ok");
    assertEqual(formatLine({ name: "node", level: "OK", message: "Node 22" }), "OK    node: Node 22", "line format");
    assertEqual(formatLine({ name: "lsp", level: "FAIL", message: "missing", hint: "Install it." }), "FAIL  lsp: missing. Install it.", "line format with a hint");
  }

  // ---- the real command through the bundle: JSON on stdout, exit 1 on FAIL
  {
    const bundle = path.join(__dirname, "..", "scripts", "manage-agent.bundle.js");
    const home = tmp("home");
    const ws = makeWorkspace({ bot: false });
    const res = spawnSync(process.execPath, [bundle, "doctor", "--workspace", ws], {
      encoding: "utf8",
      env: { PATH: path.dirname(process.execPath), HOME: home, USERPROFILE: home, SystemRoot: process.env.SystemRoot },
    });
    let out = null;
    try {
      out = JSON.parse(res.stdout);
    } catch {}
    assertEqual(out !== null && out.status === "fail", true, "the command prints JSON with status fail for a workspace without botdefinition.json");
    assertEqual(res.status, 1, "the command exits 1 on FAIL");
    assertEqual(/^FAIL {2}botdefinition:/m.test(res.stderr), true, "the lines go to stderr");
    assertEqual(fs.existsSync(path.join(home, ".copilot-studio-cli")), false, "the command writes nothing to the home folder");
  }
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
