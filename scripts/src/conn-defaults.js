/**
 * conn-defaults.js: fill missing manage-agent options from the workspace's
 * .mcs/conn.json, and say where the command goes.
 *
 * clone writes conn.json into the agent folder. validate, push, pull, changes
 * and publish are then given --workspace and need no other connection flag.
 *
 * Precedence for every option: its flag (--url counts for the environment and
 * agent id), then conn.json, then the CPS_* variable. A variable set once in a
 * shell profile must not beat the file that describes this agent.
 *
 * conn.json is input from a folder, so it is checked: a URL is taken only if it
 * is https on a known host, and everything that belongs to the environment (URLs,
 * name, agent id, cluster category) is taken only when the environment is the
 * one conn.json describes. Nothing is read from the network and no secret is
 * involved.
 */

const fs = require("fs");
const path = require("path");

// Commands that work on a cloned workspace. clone is left out on purpose: its
// workspace is the target folder, and an unrelated agent in a subfolder must
// not feed it defaults.
const WORKSPACE_COMMANDS = ["validate", "push", "pull", "changes", "publish", "remote-changes", "verify"];

// Commands that write to the server. An environment mismatch stops them.
const WRITE_COMMANDS = ["push", "pull", "publish"];

const FLAGS = {
  tenantId: "--tenant-id",
  environmentId: "--environment-id",
  environmentUrl: "--environment-url",
  agentMgmtUrl: "--agent-mgmt-url",
  environmentName: "--environment-name",
  agentId: "--agent-id",
};

const ENV_VARS = {
  tenantId: "CPS_TENANT_ID",
  environmentId: "CPS_ENVIRONMENT_ID",
  environmentUrl: "CPS_ENVIRONMENT_URL",
  agentMgmtUrl: "CPS_AGENT_MGMT_URL",
  environmentName: "CPS_ENVIRONMENT_NAME",
};

// Host suffixes of what BAP returns, for example orgf3e07203.crm4.dynamics.com and
// powervamg.eu-il102.gateway.prod.island.powerapps.com. Other clouds: pass the flag.
const DATAVERSE_SUFFIXES = [".dynamics.com"];
const AGENT_MGMT_SUFFIXES = [".powerapps.com", ".powerplatform.com"];

function str(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function sameId(a, b) {
  return String(a).toLowerCase() === String(b).toLowerCase();
}

/**
 * A URL from conn.json is used only when it is https, has no credentials, uses the
 * default port and its host ends in one of `suffixes`. Returns { url } (the parsed
 * origin, so path, query and odd spellings are gone) or { reason }.
 */
function checkUrl(value, suffixes) {
  const text = str(value);
  if (!text) return { reason: "missing" };
  let u;
  try {
    u = new URL(text);
  } catch {
    return { reason: "not a URL" };
  }
  if (u.protocol !== "https:") return { reason: "not https" };
  if (u.username || u.password) return { reason: "has credentials" };
  if (u.port && u.port !== "443") return { reason: "unusual port" };
  const host = u.hostname.toLowerCase();
  if (!suffixes.some((s) => host.endsWith(s))) return { reason: `host is not on ${suffixes.join(" or ")}` };
  return { url: u.origin }; // the parsed origin, never the text as typed
}

function originOf(value) {
  try {
    return new URL(String(value)).origin.toLowerCase();
  } catch {
    return String(value).toLowerCase();
  }
}

function hostOf(value) {
  if (!value) return "(looked up)";
  try {
    return new URL(value).host;
  } catch {
    return String(value);
  }
}

/**
 * Read <agentDir>/.mcs/conn.json. Returns the parsed object, or null when the
 * file is missing, unreadable or not a JSON object. A byte order mark is
 * tolerated.
 */
function readConnJson(agentDir, fsImpl = fs) {
  try {
    const text = fsImpl.readFileSync(path.join(agentDir, ".mcs", "conn.json"), "utf8");
    const conn = JSON.parse(text.replace(/^﻿/, ""));
    return conn && typeof conn === "object" && !Array.isArray(conn) ? conn : null;
  } catch {
    return null;
  }
}

/**
 * The agent folders a --workspace can mean: the folder itself when it has
 * .mcs/conn.json, else every direct subfolder that has one, sorted by name.
 */
function listAgentFolders(workspace, fsImpl = fs) {
  const ws = path.resolve(workspace);
  if (fsImpl.existsSync(path.join(ws, ".mcs", "conn.json"))) return [ws];
  let entries;
  try {
    entries = fsImpl.readdirSync(ws, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isDirectory() && !e.name.startsWith("."))
    .map((e) => path.join(ws, e.name))
    .filter((dir) => fsImpl.existsSync(path.join(dir, ".mcs", "conn.json")))
    .sort();
}

function connTenant(conn) {
  return conn ? str(conn.AccountInfo && conn.AccountInfo.TenantId) || str(conn.TenantId) : null;
}

/**
 * True when args and conn.json describe the same environment. Anything that
 * belongs to the environment (URLs, name, agent id, cluster category, solution
 * versions) may be taken from conn.json only then.
 */
function matchesEnvironment(args, conn) {
  if (!conn) return false;
  const envId = str(conn.EnvironmentId);
  if (!envId) return !args.environmentId;
  return Boolean(args.environmentId) && sameId(args.environmentId, envId);
}

/** True when args and conn.json have the same tenant. The account in conn.json belongs to it. */
function matchesTenant(args, conn) {
  const tenant = connTenant(conn);
  return Boolean(tenant) && Boolean(args.tenantId) && sameId(args.tenantId, tenant);
}

/**
 * Cluster category stored in conn.json (AccountInfo.clusterCategory), or null.
 * It belongs to the environment: null when the environment is another one.
 */
function storedClusterCategory(conn, args) {
  if (args && !matchesEnvironment(args, conn)) return null;
  const value = conn && conn.AccountInfo && conn.AccountInfo.clusterCategory;
  return Number.isInteger(value) ? value : null;
}

/**
 * Where did args[option] come from? { kind: "flag" | "url" | "env", label } or null
 * when it is empty. `argv` is the command line (without node and the script),
 * `env` is process.env.
 */
function sourceOf(option, args, { argv = [], env = {} } = {}) {
  const value = args[option];
  if (!value) return null;
  if (argv.includes(FLAGS[option])) return { kind: "flag", label: FLAGS[option] };
  if ((option === "environmentId" || option === "agentId") && argv.includes("--url")) {
    return { kind: "url", label: "--url" };
  }
  if (ENV_VARS[option] && env[ENV_VARS[option]] === value) {
    return { kind: "env", label: ENV_VARS[option] };
  }
  return { kind: "flag", label: FLAGS[option] };
}

/**
 * Fill the options of `args` from `conn`. Mutates args.
 *
 * ctx: { argv, env, command }
 * Returns { used, warnings, envMismatch, envMatches, rejected } where
 *   used         [{ option, from }] options filled from conn.json
 *   warnings     strings; each names the source of the value that lost or won
 *   envMismatch  { source, given, stored } when an explicit environment differs from conn.json, else null
 *   envMatches   whether conn.json's environment is the one in args afterwards
 *   rejected     [{ option, value, reason }] conn.json URLs that failed the check
 */
function applyConnDefaults(args, conn, ctx = {}) {
  const result = { used: [], warnings: [], envMismatch: null, urlMismatches: [], envMatches: false, rejected: [] };
  if (!conn) return result;
  const where = { argv: ctx.argv || [], env: ctx.env || {} };

  // Take conn.json's value unless a flag gave one. A flag that disagrees is
  // reported (when `compare`), an environment variable that loses is too.
  const fill = (option, value, from, { compare = true, label } = {}) => {
    const src = sourceOf(option, args, where);
    if (!value) return src;
    if (!src || src.kind === "env") {
      if (src && !sameId(args[option], value)) {
        result.warnings.push(`${src.label} (${args[option]}) differs from ${from} in .mcs/conn.json (${value}); using conn.json. A flag would win over both.`);
      }
      args[option] = value;
      result.used.push({ option, from });
    } else if (compare && !sameId(args[option], value)) {
      result.warnings.push(`${src.label} ${args[option]} differs from the ${label || option} in .mcs/conn.json (${value}); using ${src.label}.`);
    }
    return src;
  };

  fill("tenantId", connTenant(conn), "AccountInfo.TenantId", { label: "tenant" });

  const envId = str(conn.EnvironmentId);
  const envSrc = fill("environmentId", envId, "EnvironmentId", { compare: false });
  if (envSrc && envSrc.kind !== "env" && envId && !sameId(args.environmentId, envId)) {
    result.envMismatch = { source: envSrc.label, given: args.environmentId, stored: envId };
    const name = str(conn.EnvironmentDisplayName);
    result.warnings.push(
      `${envSrc.label} environment ${args.environmentId} differs from the environment in .mcs/conn.json (${name ? name + ", " : ""}${envId}). ` +
        "The workspace belongs to the one in conn.json. Its URLs, agent id and cluster category are not used."
    );
  }

  result.envMatches = matchesEnvironment(args, conn);
  if (!result.envMatches) return result;

  // Environment-bound. The agent id is only compared for publish, the one command
  // that sends it; the others sync the agent in the workspace files.
  fill("agentId", str(conn.AgentId), "AgentId", { compare: ctx.command === "publish", label: "agent" });
  fill("environmentName", str(conn.EnvironmentDisplayName), "EnvironmentDisplayName", { compare: false });
  for (const [option, field, suffixes] of [
    ["environmentUrl", "DataverseEndpoint", DATAVERSE_SUFFIXES],
    ["agentMgmtUrl", "AgentManagementEndpoint", AGENT_MGMT_SUFFIXES],
  ]) {
    if (conn[field] == null) continue;
    const checked = checkUrl(conn[field], suffixes);
    if (checked.url) {
      const src = fill(option, checked.url, field, { compare: false });
      // A URL flag that points somewhere else than the workspace's environment is as
      // much a mismatch as another environment id: publish uses the URL, not the id.
      if (src && src.kind !== "env" && originOf(args[option]) !== originOf(checked.url)) {
        const what = option === "environmentUrl" ? "Dataverse URL" : "agent management URL";
        result.urlMismatches.push({ source: src.label, option, what, given: args[option], stored: checked.url });
        result.warnings.push(
          `${src.label} ${args[option]} differs from the ${what} in .mcs/conn.json (${checked.url}). ` +
            "The workspace belongs to the environment in conn.json."
        );
      }
    } else {
      result.rejected.push({ option, value: String(conn[field]).slice(0, 200), reason: checked.reason });
      const remedy =
        ctx.command === "publish"
          ? option === "environmentUrl"
            ? "publish has no environment lookup, so pass --environment-url."
            : "publish does not use it."
          : `${FLAGS[option]} sets it, or the environment lookup fills it.`;
      if (ctx.command !== "publish" || option === "environmentUrl") {
        result.warnings.push(`.mcs/conn.json ${field} (${String(conn[field]).slice(0, 120)}) is not used: ${checked.reason}. ${remedy}`);
      }
    }
  }
  return result;
}

function targetLine(args, agentDir) {
  const env = args.environmentName ? `${args.environmentName} (${args.environmentId || "?"})` : args.environmentId || "?";
  return (
    `Target ${agentDir}: environment ${env}, agent ${args.agentId || "(from workspace)"}, tenant ${args.tenantId || "?"}, ` +
    `Dataverse ${hostOf(args.environmentUrl)}, agent management ${hostOf(args.agentMgmtUrl)}`
  );
}

function noConnHint(command, workspace) {
  if (command === "publish") {
    return (
      `No .mcs/conn.json found under ${workspace}. publish then needs --tenant-id, --environment-url and --agent-id.`
    );
  }
  return (
    `No .mcs/conn.json found under ${workspace}, so tenant and environment cannot be read from it, and the folder has no ` +
    ".mcs/botdefinition.json either. Clone the agent again into a new folder and use that folder as --workspace."
  );
}

/**
 * The manage-agent entry point: for the commands in WORKSPACE_COMMANDS with a
 * --workspace, find the agent folder, read its conn.json and fill the gaps in args.
 * Stops (die) when the workspace holds several agents, and for push, pull and
 * publish when an explicit environment id or environment/agent management URL is not
 * the one in conn.json, unless --force.
 * Logs one line with the target and one warning per value that lost.
 *
 * deps: { findAgentDir, log, warn, die, argv, env, fsImpl }
 */
function resolveConnDefaults(args, { findAgentDir, log, warn, die, argv = process.argv.slice(2), env = process.env, fsImpl = fs }) {
  if (!WORKSPACE_COMMANDS.includes(args.command) || !args.workspace) return null;

  const folders = listAgentFolders(args.workspace, fsImpl);
  if (folders.length > 1) {
    die(
      `Several agents found under ${path.resolve(args.workspace)}:\n` +
        folders.map((f) => `  ${f}`).join("\n") +
        "\nPass --workspace with the folder of the one you mean."
    );
  }

  const agentDir = findAgentDir(args.workspace, true);
  const conn = readConnJson(agentDir, fsImpl);
  const result = applyConnDefaults(args, conn, { argv, env, command: args.command });

  if (!conn) {
    const missing =
      args.command === "publish"
        ? !args.tenantId || !args.environmentUrl || !args.agentId
        : !args.tenantId || !args.environmentId;
    if (missing) warn(noConnHint(args.command, args.workspace));
  }
  for (const w of result.warnings) warn(w);

  if (WRITE_COMMANDS.includes(args.command) && !args.force) {
    const m = result.envMismatch;
    if (m) {
      die(
        `${args.command} refused: ${m.source} environment ${m.given} is not the environment of this workspace (${m.stored} in .mcs/conn.json). ` +
          "Use the workspace of that environment, or add --force if you mean it."
      );
    }
    const u = result.urlMismatches[0];
    if (u) {
      die(
        `${args.command} refused: ${u.source} ${u.given} is not the ${u.what} of this workspace (${u.stored} in .mcs/conn.json). ` +
          "Use the workspace of that environment, or add --force if you mean it."
      );
    }
  }

  if (conn) {
    log(targetLine(args, agentDir));
    if (result.used.length > 0) log(`From .mcs/conn.json: ${result.used.map((u) => u.option).join(", ")}`);
  }
  return Object.assign(result, { agentDir, conn });
}

module.exports = {
  WORKSPACE_COMMANDS,
  WRITE_COMMANDS,
  checkUrl,
  readConnJson,
  listAgentFolders,
  matchesEnvironment,
  matchesTenant,
  storedClusterCategory,
  sourceOf,
  applyConnDefaults,
  resolveConnDefaults,
};
