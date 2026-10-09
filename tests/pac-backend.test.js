/**
 * Tests for the pac backend of manage-agent: version gate, backend choice,
 * output mapping, argument building and pac.exe/.cmd lookup. The last part runs
 * the built bundle (scripts/manage-agent.bundle.js) against a fake pac, with no
 * network and no sign-in.
 *
 * The fixtures are cut from real pac 2.13.1 runs (Mac, Linux and Windows).
 *
 * Run: node tests/pac-backend.test.js
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const u = require("../scripts/src/pac-utils");

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

// ---------------------------------------------------------------------------
// Recorded pac output
// ---------------------------------------------------------------------------

const HELP = "Microsoft PowerPlatform CLI\nVersion: 2.13.1+g251dee1 (.NET 10.0.12)\nOnline documentation: https://aka.ms/PowerPlatformCLI\n";
const HELP_OLD = "Microsoft PowerPlatform CLI\r\nVersion: 2.12.2+ga6b1ffa (.NET Framework 4.8)\r\n";
const AUTH_UNIVERSAL = "Index Active Kind      Name User                                     Cloud  Type Environment Environment Url                        ERP URL\n[1]   *      UNIVERSAL      kornel.felfoldi@testcips.onmicrosoft.com Public User kornel_sand https://orgf3e07203.crm4.dynamics.com/ \n";
const AUTH_BOUND = "Index Active Kind     Name User             Cloud  Type Environment Environment Url\n[1]   *      DATAVERSE      me@example.com Public User sand        https://orgf3e07203.crm4.dynamics.com/\n[2]          UNIVERSAL      me@example.com Public User other       https://other.crm4.dynamics.com/\n";
const AUTH_INACTIVE = "Index Active Kind      Name User  Cloud  Type Environment Environment Url\n[1]          UNIVERSAL      me@example.com Public User sand https://orgf3e07203.crm4.dynamics.com/\n";
const PULL_OK = "Connected as me@example.com\nPulling remote changes for workspace at '/x/'...\nPull complete. 0 change(s) applied.\n";
const PULL_CONFLICT = "Pull complete. 2 change(s) applied.\nPull applied remote changes but 1 file(s) now contain merge conflicts. Resolve them before pushing:\n  topics/Greeting.mcs.yml(23,1): Unresolved merge conflict. Choose one side, remove the conflict markers, then sync again.\n";
const PUSH_OK = "Pushing local changes for workspace at '/x/'...\nPush complete. 1 change(s) pushed.\n";
const PUSH_NOTHING = "Pushing local changes for workspace at '/x/'...\nNo local changes detected. Nothing to push.\n";
const PUSH_REMOTE = "Pushing local changes for workspace at '/x/'...\nMicrosoft PowerPlatform CLI\nVersion: 2.13.1+g251dee1 (.NET 10.0.12)\n\nError: Remote changes conflict with local changes. Run 'pac copilot pull' first to resolve conflicts before pushing.\n\n";
const PUSH_MARKERS = "Error: Workspace at '/x/' is not a valid agent workspace. 1 workspace file(s) contain unresolved merge conflicts. Choose one side, remove the conflict markers, then try again:\r\n  topics/Greeting.mcs.yml(23,1): Unresolved merge conflict. Choose one side, remove the conflict markers, then sync again.\r\n";
const CLONE_OK = "Cloning agent to '/x/'...\nClone complete. Agent cloned to 'zzt sfcs pac spike'.\n";
const PUBLISH_OK = "Connected to... kornel_sand\n...Published successfully! 4a16bc71 Succeeded [10/9/2026 10:18:36 PM].\n";
const PUBLISH_HU = ".....Published successfully! 4a16bc71 Succeeded [2026. 10. 09. 22:20:22].\r\n";

(async () => {
try {
  // -------------------------------------------------------------------------
  // Version gate
  // -------------------------------------------------------------------------

  assertEqual(u.parsePacVersion(HELP), "2.13.1", "version from pac help");
  assertEqual(u.parsePacVersion(HELP_OLD), "2.12.2", "version from CRLF help of the MSI build");
  assertEqual(u.parsePacVersion("no version here"), null, "no version in the text");
  assertEqual(u.versionAtLeast("2.13.1"), true, "2.13.1 passes");
  assertEqual(u.versionAtLeast("2.13.2"), true, "2.13.2 passes");
  assertEqual(u.versionAtLeast("2.14.0"), true, "2.14.0 passes");
  assertEqual(u.versionAtLeast("3.0.0"), true, "3.0.0 passes");
  assertEqual(u.versionAtLeast("2.13.0"), false, "2.13.0 is refused");
  assertEqual(u.versionAtLeast("2.12.2"), false, "2.12.2 is refused");
  assertEqual(u.versionAtLeast("2.9.9"), false, "2.9.9 is refused (numeric compare, not text)");
  assertEqual(u.versionAtLeast("2.13"), false, "a short version is refused");
  assertEqual(u.versionAtLeast(null), false, "no version is refused");

  // -------------------------------------------------------------------------
  // Auth profile
  // -------------------------------------------------------------------------

  const url = "https://orgf3e07203.crm4.dynamics.com/";
  const WHO = "Connected as me@example.com\n\nType:                       User\nCloud:                      Public\nTenant Id:                  8DA7352D-9308-4B9F-80AF-119D78F5A973\nUser:                       me@example.com\nToken Expires:              10/9/2026 11:36:44 PM +00:00\n";
  const tenant = "8da7352d-9308-4b9f-80af-119d78f5a973";
  assertEqual(u.parseWhoTenant(WHO), tenant, "tenant id from pac auth who, lower cased");
  assertEqual(u.parseWhoTenant("Connected as me@example.com\n"), null, "no tenant line");
  assertEqual(u.parseWhoTenant(WHO.replace(/\n/g, "\r\n")), tenant, "tenant id, CRLF");
  const fit = (o) => u.profileFits({ authList: AUTH_UNIVERSAL, who: WHO, tenantId: tenant, envUrl: url, ...o });
  assertEqual(fit({}).ok, true, "universal profile, same tenant");
  assertEqual(fit({ tenantId: "11111111-2222-3333-4444-555555555555" }).ok, false, "universal profile, other tenant");
  assertEqual(fit({ who: "Connected as me@example.com\n" }).ok, false, "universal profile, pac shows no tenant");
  assertEqual(fit({ tenantId: null }).ok, false, "universal profile, workspace tenant unknown");
  assertEqual(fit({ authList: AUTH_BOUND, who: "", tenantId: null }).ok, true, "bound profile, same environment, no tenant needed");
  assertEqual(fit({ authList: AUTH_BOUND, envUrl: "https://other.crm4.dynamics.com" }).ok, false, "bound profile, other environment");
  assertEqual(fit({ authList: AUTH_BOUND, envUrl: null }).ok, false, "bound profile, environment unknown");
  assertEqual(fit({ authList: AUTH_INACTIVE }).ok, false, "no active profile");
  assertEqual(fit({ authList: "" }).ok, false, "empty auth list");
  assertEqual(/different tenant/.test(fit({ tenantId: "x" }).reason), true, "reason names the tenant");
  assertEqual(JSON.stringify(fit({ tenantId: "x" })).includes("example.com"), false, "reason carries no account data");

  // -------------------------------------------------------------------------
  // Backend selection
  // -------------------------------------------------------------------------

  assertEqual(u.parseBackend(undefined), "lsp", "default backend is lsp");
  assertEqual(u.parseBackend(""), "lsp", "empty value means lsp");
  assertEqual(u.parseBackend("PAC"), "pac", "case does not matter");
  assertEqual(u.parseBackend("auto"), "auto", "auto is accepted");
  assertEqual(u.parseBackend("dotnet"), null, "unknown value is rejected");

  const good = { ok: true, version: "2.13.1" };
  const bad = { ok: false, reason: "pac 2.12.2 is too old." };
  assertEqual(u.chooseBackend("lsp", good), { backend: "lsp" }, "lsp stays lsp even if pac is fine");
  assertEqual(u.chooseBackend("pac", good), { backend: "pac" }, "pac with a good probe");
  assertEqual(u.chooseBackend("auto", good), { backend: "pac" }, "auto picks pac when it is usable");
  assertEqual(u.chooseBackend("auto", bad), { backend: "lsp", note: bad.reason }, "auto falls back to lsp");
  assertEqual(u.chooseBackend("pac", bad), { backend: null, error: bad.reason }, "explicit pac does not fall back");

  // -------------------------------------------------------------------------
  // Output mapping
  // -------------------------------------------------------------------------

  assertEqual(u.parsePull(PULL_OK), { applied: 0, conflict: false }, "pull, no change");
  assertEqual(u.parsePull(PULL_CONFLICT), { applied: 2, conflict: true }, "pull with conflict markers (exit 0)");
  assertEqual(u.parsePull(PULL_CONFLICT.replace(/\n/g, "\r\n")), { applied: 2, conflict: true }, "pull with conflict, CRLF");
  assertEqual(u.parsePush(PUSH_OK), { pushed: 1 }, "push, one change");
  assertEqual(u.parsePush(PUSH_NOTHING), { pushed: 0 }, "push, nothing to push");
  assertEqual(u.parseClone(CLONE_OK), "zzt sfcs pac spike", "clone folder name with spaces");
  assertEqual(u.parseClone("Error: nope"), null, "clone without the success line");
  assertEqual(u.publishSucceeded(PUBLISH_OK), true, "publish, en-US date");
  assertEqual(u.publishSucceeded(PUBLISH_HU), true, "publish, Hungarian date, CRLF");
  assertEqual(u.publishSucceeded("Unhandled exception: System.ArgumentException"), false, "publish flake text");
  assertEqual(u.isRemoteConflict(PUSH_REMOTE), true, "remote changes conflict");
  assertEqual(u.isRemoteConflict(PUSH_MARKERS), false, "markers are not a remote conflict");
  assertEqual(
    u.pacErrorText("", PUSH_REMOTE),
    "Remote changes conflict with local changes. Run 'pac copilot pull' first to resolve conflicts before pushing.",
    "error line after the version banner"
  );
  assertEqual(
    u.pacErrorText(PUSH_MARKERS, ""),
    "Workspace at '/x/' is not a valid agent workspace. 1 workspace file(s) contain unresolved merge conflicts. Choose one side, remove the conflict markers, then try again: topics/Greeting.mcs.yml(23,1): Unresolved merge conflict. Choose one side, remove the conflict markers, then sync again.",
    "error with the file list under it, CRLF"
  );
  assertEqual(u.pacErrorText("all fine", ""), null, "no error line");

  assertEqual(u.readPublishedOn("a: 1\npublishedOn: 2026-10-09T22:21:29.0000000Z\ntemplate: x\n"), "2026-10-09T22:21:29.0000000Z", "publishedOn read");
  assertEqual(u.readPublishedOn("publishedOn: 2026-10-09T22:21:29.0000000Z\r\nx: 1\r\n"), "2026-10-09T22:21:29.0000000Z", "publishedOn read, CRLF");
  assertEqual(u.readPublishedOn("a: 1\n"), null, "never published");

  assertEqual(
    u.mapEnvList([{ FriendlyName: "kornel_sand", EnvironmentIdentifier: { Type: 1, Id: "5428dd9c", IsDefault: false }, EnvironmentUrl: "https://orgf3e07203.crm4.dynamics.com", Geo: "EMEA" }]),
    [{ environmentId: "5428dd9c", displayName: "kornel_sand", dataverseUrl: "https://orgf3e07203.crm4.dynamics.com", agentManagementUrl: null, environmentSku: null }],
    "env list mapped to the list-envs shape"
  );

  // -------------------------------------------------------------------------
  // Arguments with spaces, pac.exe / pac.cmd
  // -------------------------------------------------------------------------

  const spaced = ["copilot", "pull", "--project-dir", "/Users/x y/ws/zzt sfcs pac spike"];
  assertEqual(u.buildPacCommand("/opt/pac", spaced, "linux"), { cmd: "/opt/pac", args: spaced, options: {} }, "posix: args passed as they are");
  assertEqual(u.buildPacCommand("C:\\t\\pac.exe", spaced, "win32"), { cmd: "C:\\t\\pac.exe", args: spaced, options: {} }, "windows pac.exe: args passed as they are");
  assertEqual(
    u.buildPacCommand("C:\\Program Files\\pac.cmd", ["copilot", "push", "--project-dir", "C:\\my ws\\agent"], "win32", "cmd.exe"),
    {
      cmd: "cmd.exe",
      args: ["/d", "/s", "/v:off", "/c", "\"\"C:\\Program Files\\pac.cmd\" \"copilot\" \"push\" \"--project-dir\" \"C:\\my ws\\agent\"\""],
      options: { windowsVerbatimArguments: true },
    },
    "windows pac.cmd: run through cmd.exe, every part quoted"
  );
  let threw = false;
  try { u.buildPacCommand("C:\\pac.cmd", ["x", "a\"b"], "win32"); } catch { threw = true; }
  assertEqual(threw, true, "windows pac.cmd: quote in an argument is refused");

  const files = new Set();
  const isFile = (p) => files.has(p);
  const winEnv = { PATH: "C:\\a;C:\\Tools\\pac;C:\\b" };
  assertEqual(u.resolvePac(winEnv, "win32", isFile), null, "windows: nothing on PATH");
  files.add(path.win32.join("C:\\Tools\\pac", "pac.cmd"));
  assertEqual(u.resolvePac(winEnv, "win32", isFile), path.win32.join("C:\\Tools\\pac", "pac.cmd"), "windows: finds pac.cmd");
  files.add(path.win32.join("C:\\Tools\\pac", "pac.exe"));
  assertEqual(u.resolvePac(winEnv, "win32", isFile), path.win32.join("C:\\Tools\\pac", "pac.exe"), "windows: pac.exe wins over pac.cmd in one folder");
  files.add(path.win32.join("C:\\a", "pac.cmd"));
  assertEqual(u.resolvePac(winEnv, "win32", isFile), path.win32.join("C:\\a", "pac.cmd"), "windows: earlier PATH folder wins");
  assertEqual(u.resolvePac({ Path: "C:\\a" }, "win32", isFile), path.win32.join("C:\\a", "pac.cmd"), "windows: the variable is called Path");
  assertEqual(u.resolvePac({ PATH: "/bin:/usr/local/bin" }, "linux", (p) => p === "/usr/local/bin/pac"), "/usr/local/bin/pac", "posix: finds pac");
  assertEqual(u.resolvePac({ PATH: "/bin" }, "linux", () => false), null, "posix: no pac");
  assertEqual(u.resolvePac({ CPS_PAC_PATH: "/x/mypac", PATH: "/bin" }, "linux", (p) => p === "/x/mypac"), "/x/mypac", "CPS_PAC_PATH points at the file");
  assertEqual(u.resolvePac({ CPS_PAC_PATH: "/x/dir", PATH: "/bin" }, "linux", (p) => p === "/x/dir/pac"), "/x/dir/pac", "CPS_PAC_PATH points at a folder");
  assertEqual(u.resolvePac({ CPS_PAC_PATH: "/x/gone", PATH: "/bin/" }, "linux", (p) => p === "/bin/pac"), null, "CPS_PAC_PATH wins and is not searched further");

  // -------------------------------------------------------------------------
  // CLI against a fake pac
  // -------------------------------------------------------------------------

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pac-backend-"));
  const fakeDir = path.join(root, "fake bin");
  fs.mkdirSync(fakeDir, { recursive: true });
  fs.writeFileSync(path.join(fakeDir, "fakepac.js"), `
const fs = require("fs"), path = require("path");
const a = process.argv.slice(2);
const dir = process.env.FAKE_DIR, mode = process.env.FAKE_MODE || "";
fs.appendFileSync(path.join(dir, "argv.log"), JSON.stringify(a) + "\\n");
const val = (n) => a[a.indexOf(n) + 1];
const out = (s, code) => { process.stdout.write(s); process.exit(code || 0); };
if (a[0] === "help") out("Microsoft PowerPlatform CLI\\nVersion: " + (process.env.FAKE_VERSION || "2.13.1+gabc") + " (.NET 10)\\n");
if (a[0] === "auth" && a[1] === "who") out("Connected as me@example.com\\n\\nType: User\\n" + (process.env.FAKE_TENANT === "" ? "" : "Tenant Id:                  " + (process.env.FAKE_TENANT || "tenant-1") + "\\n") + "User: me@example.com\\n");
if (a[0] === "auth") out("Index Active Kind Name User Cloud Type Environment Environment Url\\n[1] * " + (process.env.FAKE_KIND || "UNIVERSAL") + " me@example.com Public User sand " + (process.env.FAKE_ENVURL || "https://o.crm4.dynamics.com/") + "\\n");
if (a[1] === "clone") {
  const d = path.join(val("--output-dir"), "Fake Agent", ".mcs");
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, "conn.json"), "{}");
  out("Clone complete. Agent cloned to 'Fake Agent'.\\n");
}
if (a[1] === "pull") {
  const pd = val("--project-dir");
  if (mode === "conflict") {
    fs.mkdirSync(path.join(pd, "topics"), { recursive: true });
    fs.writeFileSync(path.join(pd, "topics", "A.mcs.yml"), "a: 1\\n<<<<<<< \\nb: 2\\n=======\\nb: 3\\n>>>>>>> \\n");
    out("Pull complete. 1 change(s) applied.\\nPull applied remote changes but 1 file(s) now contain merge conflicts.\\n");
  }
  if (mode === "conflict-silent") {
    fs.mkdirSync(path.join(pd, "topics"), { recursive: true });
    fs.writeFileSync(path.join(pd, "topics", "A.mcs.yml"), "<<<<<<< \\nb: 2\\n=======\\nb: 3\\n>>>>>>> \\n");
    out("Pull complete. 1 change(s) applied.\\n");
  }
  if (mode === "hang") {
    const gc = require("child_process").spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "inherit" });
    fs.writeFileSync(path.join(dir, "gchild.pid"), String(gc.pid));
    setInterval(() => {}, 1000);
    return;
  }
  if (mode === "publish-conflict" && fs.existsSync(path.join(dir, "published"))) {
    fs.mkdirSync(path.join(pd, "topics"), { recursive: true });
    fs.writeFileSync(path.join(pd, "topics", "A.mcs.yml"), "a: 1\\n<<<<<<< \\nb: 2\\n=======\\nb: 3\\n>>>>>>> \\n");
  }
  if (mode === "pull-fails") out("Error: Workspace at '" + pd + "' is not a valid agent workspace.\\n", 1);
  if (mode.startsWith("publish")) {
    const stamp = fs.existsSync(path.join(process.env.FAKE_DIR, "published")) ? "2026-10-09T22:20:00.0000000Z" : "2026-10-09T22:10:00.0000000Z";
    fs.writeFileSync(path.join(pd, "settings.mcs.yml"), "displayName: x\\npublishedOn: " + stamp + "\\n");
  }
  out("Pull complete. 0 change(s) applied.\\n");
}
if (a[1] === "push") {
  if (mode === "remote") out("Error: Remote changes conflict with local changes. Run 'pac copilot pull' first to resolve conflicts before pushing.\\n", 1);
  if (mode === "empty") out("Push complete. 3 change(s) pushed.\\n");
  out("Push complete. 2 change(s) pushed.\\n");
}
if (a[1] === "publish") {
  if (mode === "publish-flake") { fs.writeFileSync(path.join(dir, "published"), "x"); out("Unhandled exception: System.ArgumentException: bad date\\n", 1); }
  if (mode === "publish-silent") out("...Published successfully! x Succeeded [10/9/2026 10:18:36 PM].\\n");
  if (mode === "publish-fails") out("Error: publish is not allowed\\n", 1);
  fs.writeFileSync(path.join(dir, "published"), "x");
  out("...Published successfully! x Succeeded [10/9/2026 10:18:36 PM].\\n");
}
if (a[0] === "env") out('[{"FriendlyName":"sand","EnvironmentIdentifier":{"Id":"e1"},"EnvironmentUrl":"https://o.crm4.dynamics.com"}]');
out("unexpected: " + a.join(" ") + "\\n", 9);
`);
  const win = process.platform === "win32";
  const pacFile = path.join(fakeDir, win ? "pac.cmd" : "pac");
  fs.writeFileSync(
    pacFile,
    win
      ? `@echo off\r\n"${process.execPath}" "%~dp0fakepac.js" %*\r\n`
      : `#!/bin/sh\nexec "${process.execPath}" "$(dirname "$0")/fakepac.js" "$@"\n`,
    { mode: 0o755 }
  );

  const cli = path.join(__dirname, "..", "scripts", "manage-agent.bundle.js");
  let wsN = 0;
  function makeWorkspace() {
    const ws = path.join(root, `work space ${wsN++}`, "Fake Agent");
    fs.mkdirSync(path.join(ws, ".mcs"), { recursive: true });
    fs.writeFileSync(path.join(ws, ".mcs", "conn.json"), JSON.stringify({ AgentId: "bot-1", EnvironmentId: "env-1", DataverseEndpoint: "https://o.crm4.dynamics.com/", AccountInfo: { TenantId: "tenant-1" } }));
    fs.writeFileSync(path.join(ws, ".mcs", "botdefinition.json"), "{}");
    return ws;
  }
  function run(argv, { mode = "", env = {}, ws } = {}) {
    fs.rmSync(path.join(fakeDir, "argv.log"), { force: true });
    fs.rmSync(path.join(fakeDir, "published"), { force: true });
    const r = spawnSync(process.execPath, [cli, ...argv], {
      encoding: "utf8",
      timeout: 90000,
      env: { ...process.env, CPS_PAC_PATH: pacFile, FAKE_DIR: fakeDir, FAKE_MODE: mode, CPS_BACKEND: "", ...env },
    });
    let json = null;
    try { json = JSON.parse(r.stdout); } catch {}
    let calls = [];
    try { calls = fs.readFileSync(path.join(fakeDir, "argv.log"), "utf8").trim().split("\n").map((l) => JSON.parse(l)); } catch {}
    return { code: r.status, json, calls, stderr: r.stderr };
  }
  const pacCalls = (r) => r.calls.filter((c) => c[0] === "copilot").map((c) => c.slice(0, 2).join(" "));

  // pull
  let ws = makeWorkspace();
  let r = run(["pull", "--backend", "pac", "--workspace", ws]);
  assertEqual([r.code, r.json && r.json.status, r.json && r.json.backend, r.json && r.json.result], [0, "ok", "pac", { applied: 0 }], "pull ok");
  assertEqual(r.calls.find((c) => c[1] === "pull"), ["copilot", "pull", "--project-dir", ws], "pull: project dir with spaces passed as one argument");

  ws = makeWorkspace();
  r = run(["pull", "--backend", "pac", "--workspace", ws], { mode: "conflict" });
  assertEqual([r.code, r.json && r.json.status, r.json && r.json.conflicts], [1, "conflict", [{ file: "topics/A.mcs.yml", lines: [2, 4, 6] }]], "pull with markers: status conflict, exit 1");

  ws = makeWorkspace();
  r = run(["pull", "--backend", "pac", "--workspace", ws], { mode: "conflict-silent" });
  assertEqual([r.code, r.json && r.json.status], [1, "conflict"], "pull with markers but without the warning text: marker scan still catches it");

  ws = makeWorkspace();
  r = run(["pull", "--backend", "pac", "--workspace", ws], { mode: "pull-fails" });
  assertEqual([r.code, r.json && r.json.status, r.json && /not a valid agent workspace/.test(r.json.error)], [1, "error", true], "pull error mapped");

  // push
  ws = makeWorkspace();
  r = run(["push", "--backend", "pac", "--workspace", ws, "--force"]);
  assertEqual([r.code, r.json && r.json.status, r.json && r.json.result, r.json && r.json.validation], [0, "ok", { pushed: 2 }, "skipped"], "push ok, forced so validation skipped");

  r = run(["push", "--backend", "pac", "--workspace", ws, "--force"], { mode: "remote" });
  assertEqual([r.code, r.json && r.json.status, r.json && /Run pull first/.test(r.json.error)], [1, "error", true], "push: remote changes mapped to a pull-first error");

  fs.mkdirSync(path.join(ws, "topics"), { recursive: true });
  fs.writeFileSync(path.join(ws, "topics", "A.mcs.yml"), "<<<<<<< \nx\n=======\ny\n>>>>>>> \n");
  r = run(["push", "--backend", "pac", "--workspace", ws, "--force"]);
  assertEqual([r.code, r.json && r.json.status, pacCalls(r)], [1, "error", []], "push with markers: refused before pac push, --force does not help");

  fs.writeFileSync(path.join(ws, "topics", "A.mcs.yml"), "description: \"never closed\n");
  r = run(["push", "--backend", "pac", "--workspace", ws, "--force"]);
  assertEqual([r.code, r.json && r.json.status, r.json && Array.isArray(r.json.syntaxErrors), pacCalls(r)], [1, "error", true, []], "push with broken YAML: refused before pac push, --force does not help");

  // publish
  ws = makeWorkspace();
  r = run(["publish", "--backend", "pac", "--workspace", ws], { mode: "publish" });
  assertEqual(
    [r.code, r.json && r.json.status, r.json && r.json.publishedOn, r.json && r.json.previousPublishedOn, pacCalls(r)],
    [0, "ok", "2026-10-09T22:20:00.0000000Z", "2026-10-09T22:10:00.0000000Z", ["copilot pull", "copilot publish", "copilot pull"]],
    "publish confirmed by a changed publishedOn"
  );
  assertEqual(r.calls.find((c) => c[1] === "publish"), ["copilot", "publish", "--bot", "bot-1", "--environment", "env-1"], "publish arguments from conn.json");

  ws = makeWorkspace();
  r = run(["publish", "--backend", "pac", "--workspace", ws], { mode: "publish-flake" });
  assertEqual([r.code, r.json && r.json.status], [0, "ok"], "publish exits 1 (ArgumentException) but publishedOn changed: still ok");

  ws = makeWorkspace();
  r = run(["publish", "--backend", "pac", "--workspace", ws], { mode: "publish-silent" });
  assertEqual([r.code, r.json && r.json.status, r.json && /publishedOn did not change/.test(r.json.error)], [1, "error", true], "publish exits 0 but publishedOn is the same: error");

  ws = makeWorkspace();
  r = run(["publish", "--backend", "pac", "--workspace", ws], { mode: "publish-fails" });
  assertEqual([r.code, r.json && r.json.status, r.json && r.json.error], [1, "error", "publish is not allowed"], "publish error text");

  // clone and list-envs
  const target = path.join(root, "clone target");
  r = run(["clone", "--backend", "pac", "--workspace", target, "--agent-id", "bot-1", "--environment-id", "env-1"]);
  assertEqual([r.code, r.json && r.json.status, r.json && r.json.result], [0, "ok", { agentFolderName: "Fake Agent" }], "clone ok");
  assertEqual(r.calls.find((c) => c[1] === "clone"), ["copilot", "clone", "--bot", "bot-1", "--environment", "env-1", "--output-dir", target], "clone arguments, target with spaces");

  r = run(["list-envs", "--backend", "pac"]);
  assertEqual([r.code, r.json && r.json.environments], [0, [{ environmentId: "e1", displayName: "sand", dataverseUrl: "https://o.crm4.dynamics.com", agentManagementUrl: null, environmentSku: null }]], "list-envs");

  // backend selection through the CLI
  ws = makeWorkspace();
  r = run(["pull", "--workspace", ws], { env: { CPS_BACKEND: "pac" } });
  assertEqual(r.json && r.json.backend, "pac", "CPS_BACKEND=pac picks pac");
  r = run(["pull", "--workspace", ws, "--backend", "auto"]);
  assertEqual(r.json && r.json.backend, "pac", "auto picks pac when version and profile are fine");
  r = run(["pull", "--workspace", ws, "--backend", "pac"], { env: { FAKE_VERSION: "2.12.2+gold" } });
  assertEqual([r.code, r.json && r.json.status, r.json && /too old/.test(r.json.error)], [1, "error", true], "explicit pac with an old version is an error");
  r = run(["pull", "--workspace", ws, "--backend", "bogus"]);
  assertEqual([r.code, r.json && /Unknown backend/.test(r.json.error)], [1, true], "unknown backend value");
  // Default and auto without a usable pac must not touch pac (and use the LSP path, which needs a tenant here).
  r = run(["pull", "--workspace", ws]);
  assertEqual([r.calls.length, r.json && /tenant-id/.test(r.json.error)], [0, true], "default is lsp: pac is never called");
  r = run(["pull", "--workspace", ws, "--backend", "auto"], { env: { FAKE_VERSION: "2.12.2+gold" } });
  assertEqual(r.json && /tenant-id/.test(r.json.error), true, "auto with an old pac falls back to the LSP path");


  // push without a usable LSP: refused unless --force (HOME points at an empty folder, so no extension)
  const emptyHome = path.join(root, "empty home");
  fs.mkdirSync(emptyHome, { recursive: true });
  const noLsp = { HOME: emptyHome, USERPROFILE: emptyHome, CPS_LSP_BINARY: "" };
  ws = makeWorkspace();
  r = run(["push", "--backend", "pac", "--workspace", ws], { env: noLsp });
  assertEqual([r.code, r.json && r.json.status, r.json && r.json.validation, pacCalls(r)], [1, "error", "unavailable", []], "push without LSP validation is refused, nothing sent");
  assertEqual(r.json && /--force/.test(r.json.error), true, "the refusal names --force");
  r = run(["push", "--backend", "pac", "--workspace", ws, "--force"], { env: noLsp });
  assertEqual([r.code, r.json && r.json.status, r.json && r.json.validation, pacCalls(r)], [0, "ok", "skipped", ["copilot push"]], "--force pushes without LSP validation and says skipped");
  r = run(["push", "--backend", "pac", "--workspace", ws], { env: { ...noLsp, CPS_LSP_BINARY: path.join(root, "missing", "LanguageServerHost") } });
  assertEqual([r.code, r.json && r.json.validation], [1, "unavailable"], "a wrong CPS_LSP_BINARY does not turn into a plain ok");

  // publish: environment must be the workspace's
  ws = makeWorkspace();
  r = run(["publish", "--backend", "pac", "--workspace", ws], { mode: "publish", env: { CPS_ENVIRONMENT_ID: "env-OTHER" } });
  assertEqual([r.code, r.json && r.json.status, r.json && /Nothing was published/.test(r.json.error), pacCalls(r)], [1, "error", true, []], "publish refused when CPS_ENVIRONMENT_ID differs from conn.json, no pac call");
  r = run(["publish", "--backend", "pac", "--workspace", ws, "--agent-id", "bot-OTHER"], { mode: "publish" });
  assertEqual([r.code, r.json && r.json.status, pacCalls(r)], [1, "error", []], "publish refused when --agent-id differs");
  r = run(["publish", "--backend", "pac", "--workspace", ws, "--environment-id", "ENV-1"], { mode: "publish" });
  assertEqual([r.code, r.json && r.json.status, r.calls.find((c) => c[1] === "publish")], [0, "ok", ["copilot", "publish", "--bot", "bot-1", "--environment", "env-1"]], "same environment in another case is accepted, conn.json values are used");

  // publish: markers from the pull after the publish
  ws = makeWorkspace();
  r = run(["publish", "--backend", "pac", "--workspace", ws], { mode: "publish-conflict" });
  assertEqual(
    [r.code, r.json && r.json.status, r.json && r.json.publishedOn, r.json && r.json.conflicts && r.json.conflicts.length],
    [1, "conflict", "2026-10-09T22:20:00.0000000Z", 1],
    "publish: markers after the second pull are reported as conflict, publishedOn still shown"
  );

  // auto: the profile must fit the workspace
  ws = makeWorkspace();
  const toLsp = (o) => { const x = run(["pull", "--workspace", ws, "--backend", "auto"], o); return [x.json && x.json.backend === "pac", x.json && /tenant-id/.test(x.json.error || "")]; };
  assertEqual(toLsp({ env: { FAKE_TENANT: "tenant-other" } }), [false, true], "auto: profile of another tenant, falls back to the LSP");
  assertEqual(toLsp({ env: { FAKE_TENANT: "" } }), [false, true], "auto: pac shows no tenant, falls back to the LSP");
  assertEqual(toLsp({ env: { FAKE_KIND: "DATAVERSE", FAKE_ENVURL: "https://other.crm4.dynamics.com/" } }), [false, true], "auto: profile bound to another environment, falls back");
  assertEqual(toLsp({ env: { FAKE_KIND: "DATAVERSE", FAKE_TENANT: "" } })[0], true, "auto: profile bound to the workspace environment, tenant not needed");
  r = run(["pull", "--workspace", ws, "--backend", "auto"], { env: { FAKE_TENANT: "tenant-other" } });
  assertEqual(r.stderr.includes("different tenant"), true, "auto: the reason is logged");
  assertEqual(r.stderr.includes("me@example.com"), false, "auto: no account data in the log");

  // timeout: pac and its child are stopped, and the call returns
  ws = makeWorkspace();
  fs.rmSync(path.join(fakeDir, "gchild.pid"), { force: true });
  const t0 = Date.now();
  r = run(["pull", "--backend", "pac", "--workspace", ws, "--timeout", "2000"], { mode: "hang" });
  assertEqual([r.code, r.json && r.json.status, r.json && /did not finish within 2s/.test(r.json.error), Date.now() - t0 < 12000], [1, "error", true, true], "timeout returns an error without waiting for the child");
  let gone = false;
  const gpid = parseInt(fs.readFileSync(path.join(fakeDir, "gchild.pid"), "utf8"), 10);
  for (let i = 0; i < 30 && !gone; i++) {
    try { process.kill(gpid, 0); await new Promise((res) => setTimeout(res, 200)); } catch { gone = true; }
  }
  assertEqual(gone, true, "timeout: the child process of pac is gone too");

  fs.rmSync(root, { recursive: true, force: true });
} catch (e) {
  failed++;
  console.error("FAIL: unexpected exception", e);
}

console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
})();
