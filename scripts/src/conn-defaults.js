/**
 * conn-defaults.js: fill missing manage-agent options from the workspace's
 * .mcs/conn.json.
 *
 * clone writes conn.json into the agent folder. validate, push, pull, changes
 * and publish are then given --workspace and need no other connection flag.
 * Explicit values (flags and the CPS_* variables) always win. Nothing is read
 * from the network and no secret is involved.
 */

const fs = require("fs");
const path = require("path");

// Commands that work on a cloned workspace. clone is left out on purpose: its
// workspace is the target folder, and an unrelated agent in a subfolder must
// not feed it defaults.
const WORKSPACE_COMMANDS = ["validate", "push", "pull", "changes", "publish"];

// conn.json fields, option name on the parsed args. Environment-bound options
// are only taken when the environment is the one conn.json describes.
const TENANT_OPTION = "tenantId";
const AGENT_OPTION = "agentId";
const ENVIRONMENT_ID_OPTION = "environmentId";
const ENVIRONMENT_BOUND = [
  ["environmentUrl", "DataverseEndpoint"],
  ["agentMgmtUrl", "AgentManagementEndpoint"],
  ["environmentName", "EnvironmentDisplayName"],
];

function str(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function sameId(a, b) {
  return String(a).toLowerCase() === String(b).toLowerCase();
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
 * Cluster category stored in conn.json (AccountInfo.clusterCategory), or null.
 * The tokens for push, pull and changes are already requested for this
 * category; the value is returned here so a lookup can use it too.
 */
function storedClusterCategory(conn) {
  const value = conn && conn.AccountInfo && conn.AccountInfo.clusterCategory;
  return Number.isInteger(value) ? value : null;
}

/**
 * Fill the options of `args` that are still empty from `conn`. Mutates args.
 *
 * Returns { used: [{ option, from }], mismatches: [string], clusterCategory }.
 *   used           options filled from conn.json
 *   mismatches     explicit values that differ from conn.json (the explicit
 *                  value is kept)
 *   clusterCategory the stored category or null; not copied into args
 */
function applyConnDefaults(args, conn) {
  const result = { used: [], mismatches: [], clusterCategory: storedClusterCategory(conn) };
  if (!conn) return result;

  const take = (option, value, from) => {
    if (args[option] == null || args[option] === "") {
      if (!value) return false;
      args[option] = value;
      result.used.push({ option, from });
      return true;
    }
    return false;
  };
  const compare = (option, value, label) => {
    if (value && args[option] && !sameId(args[option], value) && !result.used.some((u) => u.option === option)) {
      result.mismatches.push(`${label} ${args[option]} differs from ${value} in .mcs/conn.json; using ${args[option]}`);
    }
  };

  const tenant = str(conn.AccountInfo && conn.AccountInfo.TenantId) || str(conn.TenantId);
  const envId = str(conn.EnvironmentId);
  const agentId = str(conn.AgentId);

  take(TENANT_OPTION, tenant, "AccountInfo.TenantId");
  take(AGENT_OPTION, agentId, "AgentId");
  take(ENVIRONMENT_ID_OPTION, envId, "EnvironmentId");
  compare(TENANT_OPTION, tenant, "Tenant");
  compare(AGENT_OPTION, agentId, "Agent");
  compare(ENVIRONMENT_ID_OPTION, envId, "Environment");

  // URLs and the display name belong to the environment. With an explicit
  // other environment they would point at the wrong place, so leave the
  // lookup to do its job.
  const sameEnvironment = !args.environmentId || !envId || sameId(args.environmentId, envId);
  if (sameEnvironment) {
    for (const [option, field] of ENVIRONMENT_BOUND) take(option, str(conn[field]), field);
  }
  return result;
}

/**
 * The manage-agent entry point: for the commands in WORKSPACE_COMMANDS with a
 * --workspace, find the agent folder (findAgentDir), read its conn.json and
 * fill the gaps in args. Logs one line with what it took and one warning per
 * explicit value that disagrees with conn.json.
 */
function resolveConnDefaults(args, { findAgentDir, log, warn, fsImpl = fs }) {
  if (!WORKSPACE_COMMANDS.includes(args.command) || !args.workspace) return null;
  const conn = readConnJson(findAgentDir(args.workspace, true), fsImpl);
  const result = applyConnDefaults(args, conn);
  if (!conn && (!args.tenantId || !args.environmentId)) {
    warn(
      `No .mcs/conn.json found under ${args.workspace}, so tenant and environment cannot be read from it. ` +
        "Point --workspace at a cloned agent folder, or pass --tenant-id and --environment-id."
    );
  }
  if (result.used.length > 0) {
    log(`From .mcs/conn.json: ${result.used.map((u) => u.option).join(", ")}`);
  }
  for (const m of result.mismatches) warn(m);
  return result;
}

module.exports = {
  WORKSPACE_COMMANDS,
  readConnJson,
  storedClusterCategory,
  applyConnDefaults,
  resolveConnDefaults,
};
