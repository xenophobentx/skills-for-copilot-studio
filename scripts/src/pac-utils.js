/**
 * pac-utils.js: pure helpers for the pac backend of manage-agent.
 * No I/O except the file lookups in resolvePac(); everything else takes text.
 */

const fs = require("fs");
const path = require("path");

// Older pac versions lose data when a pull hits a conflict.
const MIN_PAC_VERSION = "2.13.1";

function parsePacVersion(helpText) {
  const m = /Version:\s*(\d+\.\d+\.\d+)/.exec(helpText || "");
  return m ? m[1] : null;
}

function versionAtLeast(version, min = MIN_PAC_VERSION) {
  const a = String(version).split(".").map(Number);
  const b = min.split(".").map(Number);
  if (a.length < 3 || a.some(Number.isNaN)) return false;
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return true;
}

function defaultIsFile(p) {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}

// Finds the pac executable: CPS_PAC_PATH (file, or a folder holding pac), then PATH.
// On Windows it also accepts pac.cmd and pac.bat (the MSI installs a .cmd shim).
function resolvePac(env = process.env, platform = process.platform, isFile = defaultIsFile) {
  const win = platform === "win32";
  const names = win ? ["pac.exe", "pac.cmd", "pac.bat"] : ["pac"];
  const override = env.CPS_PAC_PATH;
  if (override) {
    if (isFile(override)) return override;
    for (const n of names) {
      const p = path.join(override, n);
      if (isFile(p)) return p;
    }
    return null;
  }
  const dirs = (env.PATH || env.Path || "").split(win ? ";" : ":").filter(Boolean);
  for (const dir of dirs) {
    for (const n of names) {
      const p = path.join(dir.replace(/^"|"$/g, ""), n);
      if (isFile(p)) return p;
    }
  }
  return null;
}

// Command, args and spawn options for running pac. A .cmd/.bat shim needs cmd.exe.
function buildPacCommand(file, args, platform = process.platform, comspec = "cmd.exe") {
  if (platform === "win32" && /\.(cmd|bat)$/i.test(file)) {
    if (args.some((a) => /["%]/.test(a))) {
      throw new Error("Quotes and percent signs in arguments are not supported with pac.cmd");
    }
    const line = [file, ...args].map((a) => `"${a}"`).join(" ");
    return { cmd: comspec, args: ["/d", "/s", "/c", `"${line}"`], options: { windowsVerbatimArguments: true } };
  }
  return { cmd: file, args, options: {} };
}

// The active row of `pac auth list` (marked with *). A UNIVERSAL profile works for
// every environment of the tenant; another kind only for the environment it is
// bound to, which the table shows as a URL.
function activeProfileCovers(authListText, envUrl) {
  const line = String(authListText || "").split(/\r?\n/).find((l) => /^\s*\[\d+\]\s+\*/.test(l));
  if (!line) return false;
  if (/\bUNIVERSAL\b/.test(line)) return true;
  if (!envUrl) return false;
  const host = envUrl.replace(/^https?:\/\//i, "").replace(/\/.*$/, "").toLowerCase();
  return host !== "" && line.toLowerCase().includes(host);
}

function lines(text) {
  return String(text || "").split(/\r?\n/);
}

function firstNumber(re, text) {
  const m = re.exec(text || "");
  return m ? parseInt(m[1], 10) : null;
}

// "Pull complete. 2 change(s) applied." and the warning pac prints (with exit 0)
// when the pull wrote conflict markers.
function parsePull(stdout) {
  return {
    applied: firstNumber(/Pull complete\.\s*(\d+)\s+change/, stdout),
    conflict: /contain merge conflicts/.test(stdout || ""),
  };
}

function parsePush(stdout) {
  if (/Nothing to push/.test(stdout || "")) return { pushed: 0 };
  return { pushed: firstNumber(/Push complete\.\s*(\d+)\s+change/, stdout) };
}

function parseClone(stdout) {
  const m = /Agent cloned to '([^']+)'/.exec(stdout || "");
  return m ? m[1] : null;
}

// Only the success marker. The date after it is in the machine locale.
function publishSucceeded(stdout) {
  return /Published successfully!/.test(stdout || "");
}

function isRemoteConflict(text) {
  return /Remote changes conflict/.test(text || "");
}

// The last "Error:" line with the indented lines under it, or null.
function pacErrorText(stdout, stderr) {
  const all = [...lines(stdout), ...lines(stderr)];
  let at = -1;
  all.forEach((l, i) => { if (/^Error:/.test(l)) at = i; });
  if (at === -1) return null;
  const out = [all[at].replace(/^Error:\s*/, "").trim()];
  for (let i = at + 1; i < all.length && /^\s+\S/.test(all[i]); i++) out.push(all[i].trim());
  return out.join(" ").slice(0, 800);
}

// publishedOn line of settings.mcs.yml, as written. Compared as text, never parsed.
function readPublishedOn(settingsText) {
  const m = /^publishedOn:[ \t]*(.*?)[ \t]*$/m.exec(String(settingsText || "").replace(/\r/g, ""));
  return m && m[1] ? m[1].replace(/^["']|["']$/g, "") : null;
}

// `pac env list --json` to the shape of the LSP list-envs.
function mapEnvList(json) {
  return json.map((e) => ({
    environmentId: e.EnvironmentIdentifier && e.EnvironmentIdentifier.Id,
    displayName: e.FriendlyName,
    dataverseUrl: e.EnvironmentUrl,
    agentManagementUrl: null,
    environmentSku: null,
  }));
}

function parseBackend(value) {
  const v = String(value || "lsp").toLowerCase();
  return ["lsp", "pac", "auto"].includes(v) ? v : null;
}

// requested: lsp|pac|auto. probe: { ok, reason } from the pac check.
// Returns { backend, error } where error is set only for an explicit pac request that cannot run.
function chooseBackend(requested, probe) {
  if (requested === "lsp") return { backend: "lsp" };
  if (probe.ok) return { backend: "pac" };
  if (requested === "pac") return { backend: null, error: probe.reason };
  return { backend: "lsp", note: probe.reason };
}

module.exports = {
  MIN_PAC_VERSION,
  parsePacVersion,
  versionAtLeast,
  resolvePac,
  buildPacCommand,
  activeProfileCovers,
  parsePull,
  parsePush,
  parseClone,
  publishSucceeded,
  isRemoteConflict,
  pacErrorText,
  readPublishedOn,
  mapEnvList,
  parseBackend,
  chooseBackend,
};
