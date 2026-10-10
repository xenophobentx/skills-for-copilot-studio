/**
 * doctor.js: read-only environment check behind `manage-agent doctor`.
 *
 * One line per check: OK, WARN or FAIL plus one sentence on what to do. It
 * makes no network calls, never signs in, never opens token caches or keyring
 * entries (only file names, sizes and times), and changes nothing on disk.
 * Every check catches its own errors.
 *
 * Everything the checks touch comes in through ctx (fs, env, home, platform,
 * ...) and deps (functions from manage-agent.js), so the tests can fake it.
 */

const path = require("path");

const MIN_NODE_MAJOR = 20;
const MIN_PAC_VERSION = "2.13.1";
const NATIVE_MODULES = ["keytar", "@azure/msal-node-extensions", "vscode-jsonrpc"];

function firstLine(e) {
  return String((e && e.message) || e).split(/\r?\n/)[0].slice(0, 200);
}

function exists(ctx, p) {
  try {
    return ctx.fs.existsSync(p);
  } catch {
    return false;
  }
}

// { value } when the file parses, { missing: true } when it is not there, else { error }
function readJson(ctx, file) {
  let text;
  try {
    text = ctx.fs.readFileSync(file, "utf8");
  } catch (e) {
    return e && e.code === "ENOENT" ? { missing: true } : { error: firstLine(e) };
  }
  try {
    return { value: JSON.parse(text.replace(/^\uFEFF/, "")) };
  } catch (e) {
    return { error: firstLine(e) };
  }
}

function findOnPath(ctx, names) {
  const dirs = String(ctx.env.PATH || ctx.env.Path || "").split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    for (const name of names) {
      const full = path.join(dir, name);
      if (exists(ctx, full)) return full;
    }
  }
  return null;
}

function cliDir(ctx) {
  return path.join(ctx.home, ".copilot-studio-cli");
}

// Per user: it sits under the home folder. Same name as in the banner and hooks/setup.js.
function fallbackDir(ctx) {
  return path.join(cliDir(ctx), "sfcs-data");
}

// The command that sets up the native dependencies without a session hook.
function ensureCommand(ctx) {
  return `node "${path.join(ownRoot(ctx), "hooks", "setup.js")}" --ensure`;
}

// Path file entry: pluginData as a string, only if the folder exists (same as the bundle banner).
function pathFileData(ctx, name) {
  const r = readJson(ctx, path.join(cliDir(ctx), name));
  const v = r.value && r.value.pluginData;
  return typeof v === "string" && exists(ctx, v) ? v : null;
}

// Folder of a plugin install, recognized by the marker setup.js writes last.
function ours(ctx, dir) {
  return typeof dir === "string" && dir !== "" && exists(ctx, path.join(dir, "native-deps.json"));
}

// Same lookup, in the same order, as the banner in scripts/package.json and
// hooks/setup.js. The shared CLAUDE_PLUGIN_DATA and plugin-paths.json belong to whichever
// plugin wrote last, so they count only when the folder holds this plugin's marker.
// tests/doctor.test.js runs the banner and this function on the same fixtures.
function pluginData(ctx) {
  if (ctx.env.SFCS_PLUGIN_DATA) return { dir: ctx.env.SFCS_PLUGIN_DATA, source: "SFCS_PLUGIN_DATA" };
  const own = pathFileData(ctx, "sfcs-plugin-paths.json");
  if (own) return { dir: own, source: "sfcs-plugin-paths.json" };
  // The folder `hooks/setup.js --ensure` installs into when no hook has run (Codex without a
  // trusted hook). It exists only after someone ran that, and it is ours, so it comes before
  // the shared names: another plugin's folder can hold a marker with the same file name.
  const fb = fallbackDir(ctx);
  if (ours(ctx, fb)) return { dir: fb, source: "stable folder" };
  if (ours(ctx, ctx.env.CLAUDE_PLUGIN_DATA)) return { dir: ctx.env.CLAUDE_PLUGIN_DATA, source: "CLAUDE_PLUGIN_DATA" };
  const old = pathFileData(ctx, "plugin-paths.json");
  if (ours(ctx, old)) return { dir: old, source: "plugin-paths.json" };
  return null;
}

// The root of the plugin this bundle belongs to (scripts/ is one level below it).
function ownRoot(ctx) {
  return path.resolve(path.dirname(ctx.scriptPath), "..");
}

function samePath(ctx, a, b) {
  const real = (p) => {
    try {
      return ctx.fs.realpathSync(p);
    } catch {
      return path.resolve(p);
    }
  };
  const x = real(a);
  const y = real(b);
  return ctx.platform === "win32" ? x.toLowerCase() === y.toLowerCase() : x === y;
}

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

function checkNode(ctx, deps, add) {
  const major = parseInt(String(ctx.nodeVersion).split(".")[0], 10);
  if (major >= MIN_NODE_MAJOR) {
    add("node", "OK", `Node ${ctx.nodeVersion}`);
  } else {
    add("node", "FAIL", `Node ${ctx.nodeVersion} is too old`, `Install Node ${MIN_NODE_MAJOR} or newer.`);
  }
}

function checkSystem(ctx, deps, add) {
  const base = `${ctx.platform} ${ctx.arch} ${ctx.release || ""}`.trim();
  if (ctx.platform === "win32") {
    const mods = String(ctx.env.PSModulePath || "");
    if (ctx.env.MSYSTEM) {
      add("system", "OK", `${base}, Git Bash`);
    } else if (/[\\/]PowerShell[\\/]7/i.test(mods)) {
      add("system", "OK", `${base}, PowerShell 7 (pwsh)`);
    } else if (/WindowsPowerShell/i.test(mods)) {
      add("system", "OK", `${base}, PowerShell 5.1 or cmd (guessed from PSModulePath)`, "In PowerShell 5.1 chain commands with ';', it has no '&&'.");
    } else {
      add("system", "OK", `${base}, shell not detected`);
    }
  } else {
    add("system", "OK", `${base}, shell ${path.basename(ctx.env.SHELL || "unknown")}`);
  }
}

function checkSession(ctx, deps, add) {
  let auth;
  try {
    auth = deps.resolveAuthMode(ctx.env, ctx.platform);
  } catch (e) {
    add("session", "WARN", `sign-in mode: ${firstLine(e).replace(/\.$/, "")}`, "Fix or unset CPS_AUTH_MODE.");
    return;
  }
  if (auth.mode === "device") {
    add("session", "OK", `sign-in will use the device code flow (${auth.reason})`);
  } else {
    add("session", "OK", "sign-in will open a browser");
  }
}

function checkLsp(ctx, deps, add) {
  const override = ctx.env.CPS_LSP_BINARY;
  if (override && !exists(ctx, override)) {
    add("lsp", "WARN", `CPS_LSP_BINARY points to a missing file: ${override}, the extension folder is used instead`, "Fix the path or unset it.");
  }
  const { info, searchDirs } = deps.locateBinary({ readOnly: true });
  if (!info) {
    add(
      "lsp",
      "FAIL",
      `LanguageServerHost not found in ${searchDirs.join(", ")}`,
      "Install the Copilot Studio VS Code extension, or set CPS_LSP_BINARY."
    );
    return;
  }
  const where = `${info.binaryPath} (${info.version === "custom" ? "CPS_LSP_BINARY" : "v" + info.version})`;
  if (info.executable === false) {
    add("lsp", "WARN", `${where} is not executable, manage-agent tries chmod +x when it starts it`, `If that fails run: chmod +x "${info.binaryPath}"`);
  } else if (info.skipped && info.skipped.length > 0) {
    add(
      "lsp",
      "WARN",
      `${where}; newer extension folder ${info.skipped.join(", ")} has no binary`,
      "Reinstall the extension so the newest folder is complete."
    );
  } else if (info.version !== "custom" && deps.compareSemver(info.version, deps.minExtensionVersion) < 0) {
    add("lsp", "WARN", `${where} is older than the tested ${deps.minExtensionVersion}`, "Update the VS Code extension.");
  } else {
    add("lsp", "OK", where);
  }
}

function checkNative(ctx, deps, add) {
  const pd = pluginData(ctx);
  const dirs = pd ? [path.join(pd.dir, "node_modules")] : [];
  const log = pd ? path.join(pd.dir, "install.log") : null;
  const logHint = log && exists(ctx, log) ? ` See ${log}.` : "";
  const session = `Start a new session with this plugin loaded, or run ${ensureCommand(ctx)}`;
  let allLoad = true;

  for (const name of NATIVE_MODULES) {
    try {
      ctx.tryRequire(name, dirs);
      add("native", "OK", `${name} loads`);
    } catch (e) {
      // msal-cache.js stubs keytar on Windows, where the token cache uses DPAPI instead.
      const winKeytar = name === "keytar" && ctx.platform === "win32";
      if (winKeytar) {
        try {
          ctx.stubKeytar(dirs);
        } catch {}
      } else {
        allLoad = false;
      }
      add(
        "native",
        winKeytar ? "WARN" : "FAIL",
        `${name} does not load: ${firstLine(e)}${winKeytar ? " (Windows does not use it)" : ""}`,
        winKeytar ? undefined : (pd ? session : `No plugin data folder is known. Start a session with the plugin loaded, or run ${ensureCommand(ctx)}`) + logHint
      );
    }
  }
  if (!pd) return;

  const marker = readJson(ctx, path.join(pd.dir, "native-deps.json"));
  let manifest = null;
  try {
    manifest = ctx.fs.readFileSync(path.join(path.dirname(ctx.scriptPath), "native-deps.json"), "utf8");
  } catch {}
  let current = null;
  try {
    current = ctx.fs.readFileSync(path.join(pd.dir, "native-deps.json"), "utf8");
  } catch {}
  if (marker.missing) {
    add("native-marker", "WARN", `native-deps.json is missing in ${pd.dir}`, "Setup has not finished. " + session + logHint);
  } else if (manifest !== null && current !== manifest) {
    add("native-marker", "WARN", `native-deps.json in ${pd.dir} differs from the plugin's copy`, "Setup has to run again. " + session + logHint);
  } else if (manifest === null) {
    add("native-marker", "WARN", "could not read the plugin's native-deps.json to compare", "Check that the plugin folder is complete.");
  } else {
    add("native-marker", allLoad ? "OK" : "WARN", `setup marker matches (${pd.source})`);
  }
}

function checkPluginPaths(ctx, deps, add) {
  const file = path.join(cliDir(ctx), "sfcs-plugin-paths.json");
  const r = readJson(ctx, file);
  if (r.missing) {
    const pd = pluginData(ctx);
    if (ctx.env.SFCS_PLUGIN_DATA) {
      add("plugin-paths", "OK", "no sfcs-plugin-paths.json, SFCS_PLUGIN_DATA is set");
    } else if (pd && pd.source === "stable folder") {
      add("plugin-paths", "OK", `no sfcs-plugin-paths.json, the scripts use the stable folder ${pd.dir} (set up with hooks/setup.js --ensure)`);
    } else {
      add("plugin-paths", "WARN", `${file} not found`, `Start a session with the plugin loaded, the setup hook writes it. Without a hook run ${ensureCommand(ctx)}`);
    }
  } else if (r.error || !r.value || typeof r.value !== "object" || Array.isArray(r.value)) {
    add("plugin-paths", "WARN", `${file} is not valid, the scripts ignore it`, "Start a new session with the plugin loaded to rewrite it.");
  } else if (typeof r.value.pluginData !== "string" || !exists(ctx, r.value.pluginData)) {
    add("plugin-paths", "WARN", `pluginData in ${file} is missing or does not exist, the scripts ignore it`, "Start a new session with the plugin loaded to rewrite it.");
  } else {
    const pd = pluginData(ctx);
    if (pd && pd.source === "SFCS_PLUGIN_DATA" && !samePath(ctx, pd.dir, r.value.pluginData)) {
      add("plugin-paths", "OK", `${file} points to ${r.value.pluginData}; this session uses SFCS_PLUGIN_DATA (${pd.dir})`);
    } else {
      add("plugin-paths", "OK", `${file} points to an existing folder`);
    }
  }

  // The shared file of the earlier versions: information only, another plugin may write it.
  const old = path.join(cliDir(ctx), "plugin-paths.json");
  const o = readJson(ctx, old);
  if (o.missing) return;
  const data = o.value && typeof o.value.pluginData === "string" ? o.value.pluginData : null;
  if (data && ours(ctx, data)) {
    add("plugin-paths-old", "OK", `${old} is an old file from an earlier version, still accepted`);
  } else {
    const who = o.value && typeof o.value.pluginRoot === "string" ? ` (pluginRoot ${o.value.pluginRoot})` : "";
    add("plugin-paths-old", "OK", `${old} was written by another plugin${who} or is not readable, this plugin does not use it`);
  }
}

function checkSecretService(ctx, deps, add) {
  if (ctx.platform !== "linux") return;
  const bus = ctx.env.DBUS_SESSION_BUS_ADDRESS ||
    (ctx.env.XDG_RUNTIME_DIR && exists(ctx, path.join(ctx.env.XDG_RUNTIME_DIR, "bus")));
  if (!bus) {
    add(
      "secret-service",
      "WARN",
      "no D-Bus session, tokens would be saved in a plaintext file under ~/.copilot-studio-cli",
      "Fine on a test box. Elsewhere start a keyring (for example gnome-keyring) in this session."
    );
  } else {
    add(
      "secret-service",
      "OK",
      "D-Bus session found",
      "A locked or missing keyring at sign-in falls back to a plaintext file."
    );
  }
}

function checkTokenCache(ctx, deps, add) {
  const dir = cliDir(ctx);
  let names;
  try {
    names = ctx.fs.readdirSync(dir).filter((n) => /\.cache\.json$/.test(n)).sort();
  } catch {
    add("token-cache", "OK", `no ${dir} yet, nothing cached`);
    return;
  }
  if (names.length === 0) {
    add("token-cache", "OK", "no cache files, the first push or pull asks for a sign-in");
    return;
  }
  const shown = names.slice(0, 4);
  const parts = shown.map((n) => {
    try {
      const st = ctx.fs.statSync(path.join(dir, n));
      return `${n} (${st.size} bytes, ${new Date(st.mtimeMs).toISOString().slice(0, 10)})`;
    } catch {
      return `${n} (unreadable)`;
    }
  });
  const more = names.length > shown.length ? `, and ${names.length - shown.length} more` : "";
  add("token-cache", "OK", `${names.length} cache file(s) in ${dir}: ${parts.join(", ")}${more}`);
}

// pac is only used by the optional pac backend, so this check is informational.
// It never starts pac: the version comes from the install folder name.
function pacVersion(ctx, pac) {
  const dir = path.dirname(pac);
  const found = [];
  const add = (folder, re) => {
    try {
      for (const n of ctx.fs.readdirSync(folder)) {
        const m = re.exec(n);
        if (m) found.push(m[1]);
      }
    } catch {}
  };
  add(path.join(dir, ".store", "microsoft.powerapps.cli.tool"), /^(\d+\.\d+\.\d+)$/);
  add(dir, /^Microsoft\.PowerApps\.CLI\.(\d+\.\d+\.\d+)$/i);
  return found.length > 0 ? found : null;
}

function checkPac(ctx, deps, add) {
  const win = ctx.platform === "win32";
  const fromEnv = ctx.env.CPS_PAC_PATH;
  const envOk = fromEnv && exists(ctx, fromEnv);
  const pac = envOk ? fromEnv : findOnPath(ctx, win ? ["pac.exe", "pac.cmd", "pac"] : ["pac"]);
  const note = fromEnv && !envOk ? `CPS_PAC_PATH points to a missing file (${fromEnv}), PATH was searched instead. ` : "";
  if (!pac) {
    add("pac", "OK", `${note}pac not found, only the optional pac backend needs it`);
    return;
  }
  const versions = pacVersion(ctx, pac);
  if (!versions) {
    add("pac", "OK", `${note}pac at ${pac}, version not read (pac is only used by the optional pac backend)`);
    return;
  }
  versions.sort(deps.compareSemver);
  const newest = versions[versions.length - 1];
  if (deps.compareSemver(newest, MIN_PAC_VERSION) < 0) {
    add(
      "pac",
      "OK",
      `${note}pac ${newest} at ${pac} (newest installed, only used by the optional pac backend)`,
      `In our tests pac 2.12.2 emptied a file on a conflicting pull and ${MIN_PAC_VERSION} kept both versions. Update to ${MIN_PAC_VERSION} or later before you use the pac backend.`
    );
  } else {
    add("pac", "OK", `${note}pac ${newest} at ${pac} (newest installed, only used by the optional pac backend)`);
  }
}

// Same pattern as the Grep check in skills/int-project-context. manage-agent
// uses it too, to refuse pull and push.
function isCliAgentSettings(text) {
  return /^\s*(template:\s*['"]?cliagent|authoring(Mode|Model):\s*['"]?CliCopilot)/im.test(text);
}

function looksLikeWorkspace(ctx, dir) {
  return ["agent.mcs.yml", "settings.mcs.yml", ".mcs"].some((n) => exists(ctx, path.join(dir, n)));
}

function checkWorkspace(ctx, deps, add) {
  const given = ctx.workspace;
  const start = path.resolve(ctx.cwd, given || ".");
  if (given && !exists(ctx, start)) {
    add("workspace", "FAIL", `${start} does not exist`, "Check the --workspace path.");
    return;
  }
  const dir = deps.findAgentDir(start);
  if (!given && !looksLikeWorkspace(ctx, dir)) {
    add("workspace", "OK", `${start} is not an agent folder, pass --workspace to check one`);
    return;
  }

  if (ctx.platform === "win32" && /^[\\/]{2}/.test(dir)) {
    add("workspace-path", "FAIL", `${dir} is a UNC path`, "LanguageServerHost rejects UNC paths. Use a drive letter or a local copy.");
  }

  const conn = readJson(ctx, path.join(dir, ".mcs", "conn.json"));
  if (conn.missing) {
    add("conn.json", "FAIL", `.mcs/conn.json missing in ${dir}`, "This is not a cloned agent. Clone it first.");
  } else if (conn.error || !conn.value || typeof conn.value !== "object") {
    add("conn.json", "FAIL", ".mcs/conn.json is not valid JSON", "Clone the agent again into a new folder.");
  } else {
    // Clones keep the tenant under AccountInfo, the eval fixtures at the top.
    const c = conn.value;
    const missing = [
      !c.AgentId && "AgentId",
      !c.EnvironmentId && "EnvironmentId",
      !((c.AccountInfo && c.AccountInfo.TenantId) || c.TenantId) && "TenantId",
    ].filter(Boolean);
    if (missing.length > 0) {
      add("conn.json", "WARN", `.mcs/conn.json has no ${missing.join(", ")}`, "Clone the agent again into a new folder.");
    } else {
      add("conn.json", "OK", ".mcs/conn.json found");
    }
  }

  const bot = readJson(ctx, path.join(dir, ".mcs", "botdefinition.json"));
  if (bot.missing) {
    add(
      "botdefinition",
      "FAIL",
      ".mcs/botdefinition.json missing (git never tracks it)",
      "Clone the agent again into a new folder and copy your YAML over."
    );
  } else if (bot.error) {
    add("botdefinition", "FAIL", ".mcs/botdefinition.json is not valid JSON", "Clone the agent again into a new folder.");
  } else {
    add("botdefinition", "OK", ".mcs/botdefinition.json found");
  }

  let settings = "";
  try {
    settings = ctx.fs.readFileSync(path.join(dir, "settings.mcs.yml"), "utf8");
  } catch {}
  if (isCliAgentSettings(settings)) {
    add("workspace-type", "WARN", "CLI agent workspace", "Do not pull, push or publish here, use microsoft/copilot-studio-plugin.");
  } else {
    add("workspace-type", "OK", "classic agent workspace");
  }

  const conflicts = deps.findConflictMarkers(dir);
  if (conflicts.length > 0) {
    add("conflicts", "FAIL", `merge markers in ${deps.formatConflicts(conflicts)}`, "Pick the right lines, remove the markers, then run validate.");
  } else {
    add("conflicts", "OK", "no merge markers");
  }
}

const CHECKS = [
  ["node", checkNode],
  ["system", checkSystem],
  ["session", checkSession],
  ["lsp", checkLsp],
  ["native", checkNative],
  ["plugin-paths", checkPluginPaths],
  ["secret-service", checkSecretService],
  ["token-cache", checkTokenCache],
  ["pac", checkPac],
  ["workspace", checkWorkspace],
];

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

function runDoctor(ctx, deps) {
  const checks = [];
  for (const [name, fn] of CHECKS) {
    const add = (id, level, message, hint) => {
      const c = { name: id, level, message };
      if (hint) c.hint = hint;
      checks.push(c);
    };
    try {
      fn(ctx, deps, add);
    } catch (e) {
      add(name, "WARN", `check could not run: ${firstLine(e)}`, "Please report this.");
    }
  }
  const count = (level) => checks.filter((c) => c.level === level).length;
  const summary = { ok: count("OK"), warn: count("WARN"), fail: count("FAIL") };
  return { status: summary.fail > 0 ? "fail" : "ok", summary, checks };
}

function formatLine(c) {
  return `${c.level.padEnd(4)}  ${c.name}: ${c.message}${c.hint ? ". " + c.hint : ""}`;
}

function makeContext(args) {
  const fs = require("fs");
  const os = require("os");
  return {
    fs,
    env: process.env,
    platform: process.platform,
    arch: process.arch,
    release: os.release(),
    home: os.homedir(),
    cwd: process.cwd(),
    nodeVersion: process.versions.node,
    scriptPath: process.argv[1] || __filename,
    workspace: args.workspace || null,
    // Load a module from the plugin data folder first, then the normal path.
    tryRequire(name, dirs) {
      if (dirs.length > 0) {
        try {
          return require(require.resolve(name, { paths: dirs }));
        } catch {}
      }
      return require(name);
    },
    // Same stub msal-cache.js registers on Windows: msal-node-extensions requires
    // keytar at load time, but only macOS and Linux call it.
    stubKeytar(dirs) {
      const Module = require("module");
      const keytarPath = require.resolve("keytar", { paths: dirs });
      const unavailable = () => Promise.reject(new Error("keytar native binding is not available on this platform"));
      const stub = new Module(keytarPath);
      stub.filename = keytarPath;
      stub.loaded = true;
      stub.exports = { getPassword: unavailable, setPassword: unavailable, deletePassword: unavailable, findPassword: unavailable, findCredentials: unavailable };
      require.cache[keytarPath] = stub;
    },
  };
}

module.exports = { runDoctor, formatLine, makeContext, pluginData, isCliAgentSettings };
