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
  const join = win ? path.win32.join : path.posix.join;
  const names = win ? ["pac.exe", "pac.cmd", "pac.bat"] : ["pac"];
  const override = env.CPS_PAC_PATH;
  if (override) {
    if (isFile(override)) return override;
    for (const n of names) {
      const p = join(override, n);
      if (isFile(p)) return p;
    }
    return null;
  }
  const dirs = (env.PATH || env.Path || "").split(win ? ";" : ":").filter(Boolean);
  for (const dir of dirs) {
    for (const n of names) {
      const p = join(dir.replace(/^"|"$/g, ""), n);
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
    return { cmd: comspec, args: ["/d", "/s", "/v:off", "/c", `"${line}"`], options: { windowsVerbatimArguments: true } };
  }
  return { cmd: file, args, options: {} };
}

function hostOf(url) {
  return String(url || "").replace(/^https?:\/\//i, "").replace(/\/.*$/, "").toLowerCase();
}

// Tenant id from `pac auth who`. Only this one field is read, nothing else of
// the output is kept or logged.
function parseWhoTenant(whoText) {
  const m = /^Tenant Id:[ \t]*(\S+)/im.exec(String(whoText || ""));
  return m ? m[1].toLowerCase() : null;
}

// Does the active pac profile fit this workspace? Reads the active row of
// `pac auth list` (marked with *) and the tenant from `pac auth who`.
// - A profile of another kind is bound to the environment shown in its row and
//   fits only when that is the workspace's environment.
// - A UNIVERSAL profile fits when its tenant is the workspace tenant. If pac
//   does not show the tenant, or the workspace tenant is unknown, it does not fit.
// Returns { ok, reason }.
function profileFits({ authList, who, tenantId, envUrl }) {
  const line = String(authList || "").split(/\r?\n/).find((l) => /^\s*\[\d+\]\s+\*/.test(l));
  if (!line) return { ok: false, reason: "pac has no active auth profile. Create one with: pac auth create --deviceCode --environment <environment id>" };
  if (!/\bUNIVERSAL\b/.test(line)) {
    const host = hostOf(envUrl);
    if (host && line.toLowerCase().includes(host)) return { ok: true };
    return { ok: false, reason: "the active pac profile is bound to another environment than the workspace" };
  }
  const profileTenant = parseWhoTenant(who);
  if (!profileTenant) return { ok: false, reason: "pac does not show the tenant of the active profile, so it cannot be matched to the workspace" };
  if (!tenantId) return { ok: false, reason: "the tenant of the workspace is unknown, so the pac profile cannot be matched to it" };
  if (profileTenant !== String(tenantId).toLowerCase()) return { ok: false, reason: "the active pac profile belongs to a different tenant than the workspace" };
  return { ok: true };
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
  parseWhoTenant,
  profileFits,
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
