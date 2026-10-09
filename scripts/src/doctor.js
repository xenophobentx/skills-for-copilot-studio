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

const MIN_NODE_MAJOR = 18;
const MIN_PAC_VERSION = "2.13.1";
const NATIVE_MODULES = ["keytar", "@azure/msal-node-extensions"];

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
    return { value: JSON.parse(text.replace(/^﻿/, "")) };
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

// Same lookup the bundles do at startup: CLAUDE_PLUGIN_DATA, else plugin-paths.json.
function pluginData(ctx) {
  if (ctx.env.CLAUDE_PLUGIN_DATA) return { dir: ctx.env.CLAUDE_PLUGIN_DATA, source: "CLAUDE_PLUGIN_DATA" };
  const r = readJson(ctx, path.join(cliDir(ctx), "plugin-paths.json"));
  if (r.value && typeof r.value.pluginData === "string") {
    return { dir: r.value.pluginData, source: "plugin-paths.json" };
  }
  return null;
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
    if (/[\\/]PowerShell[\\/]7/i.test(mods)) {
      add("system", "OK", `${base}, PowerShell 7 (pwsh)`);
    } else if (/WindowsPowerShell/i.test(mods)) {
      add("system", "OK", `${base}, Windows PowerShell 5.1`, "Chain commands with ';', this shell has no '&&'.");
    } else {
      add("system", "OK", `${base}, shell not detected`);
    }
  } else {
    add("system", "OK", `${base}, shell ${path.basename(ctx.env.SHELL || "unknown")}`);
  }
}

function checkSession(ctx, deps, add) {
  const env = ctx.env;
  const ssh = Boolean(env.SSH_CONNECTION || env.SSH_CLIENT || env.SSH_TTY);
  const noDisplay = ctx.platform === "linux" && !env.DISPLAY && !env.WAYLAND_DISPLAY;
  if (ssh || noDisplay) {
    add(
      "session",
      "WARN",
      ssh ? "SSH session" : "no display",
      "Sign-in needs a browser on this machine. Use a desktop session or forward the port."
    );
  } else {
    add("session", "OK", "local session");
  }
}

function checkLsp(ctx, deps, add) {
  const override = ctx.env.CPS_LSP_BINARY;
  if (override && !exists(ctx, override)) {
    add("lsp", "FAIL", `CPS_LSP_BINARY points to a missing file: ${override}`, "Fix the path or unset it.");
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
    add("lsp", "FAIL", `${where} is not executable`, `Run: chmod +x "${info.binaryPath}"`);
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
  let allLoad = true;

  for (const name of NATIVE_MODULES) {
    try {
      ctx.tryRequire(name, dirs);
      add("native", "OK", `${name} loads`);
    } catch (e) {
      allLoad = false;
      // keytar is only called on macOS and Linux, and Windows stubs it.
      const level = name === "keytar" && ctx.platform === "win32" ? "WARN" : "FAIL";
      add(
        "native",
        level,
        `${name} does not load: ${firstLine(e)}`,
        (pd ? "Start a new session so the setup hook runs again." : "No plugin data folder is known, start a session with the plugin loaded.") + logHint
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
    add("native-marker", "WARN", `native-deps.json is missing in ${pd.dir}`, "Setup has not finished. Start a new session." + logHint);
  } else if (manifest !== null && current !== manifest) {
    add("native-marker", "WARN", `native-deps.json in ${pd.dir} differs from the plugin's copy`, "Start a new session so setup runs again." + logHint);
  } else if (manifest === null) {
    add("native-marker", "WARN", "could not read the plugin's native-deps.json to compare", "Check that the plugin folder is complete.");
  } else {
    add("native-marker", allLoad ? "OK" : "WARN", `setup marker matches (${pd.source})`);
  }
}

function checkPluginPaths(ctx, deps, add) {
  const file = path.join(cliDir(ctx), "plugin-paths.json");
  const r = readJson(ctx, file);
  if (r.missing) {
    if (ctx.env.CLAUDE_PLUGIN_DATA) {
      add("plugin-paths", "OK", "no plugin-paths.json, CLAUDE_PLUGIN_DATA is set");
    } else {
      add("plugin-paths", "WARN", `${file} not found`, "Start a session with the plugin loaded, the setup hook writes it.");
    }
    return;
  }
  if (r.error || !r.value || typeof r.value !== "object") {
    add("plugin-paths", "FAIL", `${file} is not valid JSON`, "Delete it and start a new session.");
    return;
  }
  const bad = ["pluginData", "pluginRoot"].filter((k) => typeof r.value[k] !== "string" || !exists(ctx, r.value[k]));
  if (bad.length > 0) {
    add("plugin-paths", "WARN", `${bad.join(" and ")} in ${file} does not exist`, "Start a new session to rewrite it.");
  } else {
    add("plugin-paths", "OK", `${file} points to existing folders`);
  }
}

function checkSecretService(ctx, deps, add) {
  if (ctx.platform !== "linux") return;
  const bus = ctx.env.DBUS_SESSION_BUS_ADDRESS ||
    (ctx.env.XDG_RUNTIME_DIR && exists(ctx, path.join(ctx.env.XDG_RUNTIME_DIR, "bus")));
  const tool = findOnPath(ctx, ["secret-tool"]);
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
      `D-Bus session found, secret-tool ${tool ? "found" : "not found"}`,
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

function checkPac(ctx, deps, add) {
  const win = ctx.platform === "win32";
  const fromEnv = ctx.env.CPS_PAC_PATH;
  const pac = fromEnv || findOnPath(ctx, win ? ["pac.exe", "pac.cmd", "pac"] : ["pac"]);
  if (!pac || !exists(ctx, pac)) {
    add(
      "pac",
      fromEnv ? "FAIL" : "OK",
      fromEnv ? `CPS_PAC_PATH points to a missing file: ${fromEnv}` : "pac not found (optional)",
      fromEnv ? "Fix the path or unset it." : undefined
    );
    return;
  }
  let out;
  try {
    out = ctx.run(pac, []);
  } catch (e) {
    add("pac", "WARN", `${pac} did not run: ${firstLine(e)}`, "Reinstall the Power Platform CLI.");
    return;
  }
  const m = /Version:\s*(\d+\.\d+\.\d+)/i.exec(out) || /^(\d+\.\d+\.\d+)/.exec(String(out).trim());
  if (!m) {
    add("pac", "WARN", `${pac} gave no version`, "Reinstall the Power Platform CLI.");
  } else if (deps.compareSemver(m[1], MIN_PAC_VERSION) < 0) {
    add("pac", "WARN", `pac ${m[1]} at ${pac}`, `Update to ${MIN_PAC_VERSION} or newer, the copilot commands need it.`);
  } else {
    add("pac", "OK", `pac ${m[1]} at ${pac}`);
  }
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
    const missing = ["AgentId", "EnvironmentId", "TenantId"].filter((k) => !conn.value[k]);
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
  if (/^\s*(template:\s*['"]?cliagent|authoring(Mode|Model):\s*['"]?CliCopilot)/im.test(settings)) {
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
  const { execFileSync } = require("child_process");
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
    run(file, argv) {
      const cmd = /\.(cmd|bat)$/i.test(file);
      return execFileSync(cmd ? `"${file}"` : file, argv, { encoding: "utf8", timeout: 15000, windowsHide: true, shell: cmd, stdio: ["ignore", "pipe", "ignore"] });
    },
  };
}

module.exports = { runDoctor, formatLine, makeContext };
