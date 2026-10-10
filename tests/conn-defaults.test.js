/**
 * Tests for conn-defaults: manage-agent fills missing connection options from
 * the workspace's .mcs/conn.json.
 *
 * Run: node tests/conn-defaults.test.js
 */

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const {
  WORKSPACE_COMMANDS,
  readConnJson,
  storedClusterCategory,
  applyConnDefaults,
  resolveConnDefaults,
} = require("../scripts/src/conn-defaults");

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
  } catch (e) {
    failed++;
    console.error(`FAIL: ${name}\n  ${String(e.message).split("\n").join("\n  ")}`);
  }
}

const TENANT = "8da7352d-9308-4b9f-80af-119d78f5a973";
const ENV = "5428dd9c-bae7-eb70-9855-4a7f49b23f4b";
const AGENT = "6352728b-c4bc-f111-aaaf-000d3ab656c6";

// Same shape as a conn.json that clone writes.
function realConn(extra = {}) {
  return {
    DataverseEndpoint: "https://orgf3e07203.crm4.dynamics.com",
    EnvironmentId: ENV,
    EnvironmentDisplayName: "kornel_sand",
    AccountInfo: { AccountId: `x.${TENANT}`, TenantId: TENANT, AccountEmail: "a@b.c", clusterCategory: 5 },
    AgentId: AGENT,
    AgentManagementEndpoint: "https://powervamg.eu-il102.gateway.prod.island.powerapps.com",
    AuthoringShape: 1,
    ...extra,
  };
}

function emptyArgs(extra = {}) {
  return {
    command: "validate",
    workspace: "/w",
    tenantId: null,
    environmentId: null,
    environmentUrl: null,
    agentMgmtUrl: null,
    environmentName: null,
    agentId: null,
    ...extra,
  };
}

// ---------------------------------------------------------------------------
// applyConnDefaults
// ---------------------------------------------------------------------------

test("nothing given: every option comes from conn.json", () => {
  const args = emptyArgs();
  const r = applyConnDefaults(args, realConn());
  assert.strictEqual(args.tenantId, TENANT);
  assert.strictEqual(args.environmentId, ENV);
  assert.strictEqual(args.agentId, AGENT);
  assert.strictEqual(args.environmentUrl, "https://orgf3e07203.crm4.dynamics.com");
  assert.strictEqual(args.agentMgmtUrl, "https://powervamg.eu-il102.gateway.prod.island.powerapps.com");
  assert.strictEqual(args.environmentName, "kornel_sand");
  assert.deepStrictEqual(r.used.map((u) => u.option).sort(), ["agentId", "agentMgmtUrl", "environmentId", "environmentName", "environmentUrl", "tenantId"]);
  assert.deepStrictEqual(r.mismatches, []);
});

test("explicit values win over conn.json", () => {
  const args = emptyArgs({
    tenantId: "other-tenant",
    environmentId: ENV,
    environmentUrl: "https://mine.crm.dynamics.com",
    agentMgmtUrl: "https://mine.example/mgmt",
    environmentName: "Mine",
    agentId: AGENT,
  });
  const r = applyConnDefaults(args, realConn());
  assert.strictEqual(args.tenantId, "other-tenant");
  assert.strictEqual(args.environmentUrl, "https://mine.crm.dynamics.com");
  assert.strictEqual(args.agentMgmtUrl, "https://mine.example/mgmt");
  assert.strictEqual(args.environmentName, "Mine");
  assert.deepStrictEqual(r.used, []);
  assert.strictEqual(r.mismatches.length, 1);
  assert.match(r.mismatches[0], /Tenant other-tenant differs from .* in \.mcs\/conn\.json; using other-tenant/);
});

test("partial flags: only the missing options are filled", () => {
  const args = emptyArgs({ tenantId: TENANT, environmentUrl: "https://mine.crm.dynamics.com" });
  const r = applyConnDefaults(args, realConn());
  assert.strictEqual(args.environmentUrl, "https://mine.crm.dynamics.com");
  assert.strictEqual(args.agentMgmtUrl, "https://powervamg.eu-il102.gateway.prod.island.powerapps.com");
  assert.ok(!r.used.some((u) => u.option === "tenantId" || u.option === "environmentUrl"));
});

test("same ids in another letter case are not a mismatch", () => {
  const args = emptyArgs({ tenantId: TENANT.toUpperCase(), environmentId: ENV.toUpperCase(), agentId: AGENT.toUpperCase() });
  const r = applyConnDefaults(args, realConn());
  assert.deepStrictEqual(r.mismatches, []);
  assert.strictEqual(args.tenantId, TENANT.toUpperCase());
});

test("another environment on the command line: its URLs are not taken from conn.json", () => {
  const args = emptyArgs({ environmentId: "11111111-2222-3333-4444-555555555555" });
  const r = applyConnDefaults(args, realConn());
  assert.strictEqual(args.environmentUrl, null);
  assert.strictEqual(args.agentMgmtUrl, null);
  assert.strictEqual(args.environmentName, null);
  assert.strictEqual(args.tenantId, TENANT);
  assert.ok(r.mismatches.some((m) => /^Environment 11111111/.test(m)));
});

test("empty strings count as not given", () => {
  const args = emptyArgs({ tenantId: "", environmentUrl: "" });
  applyConnDefaults(args, realConn());
  assert.strictEqual(args.tenantId, TENANT);
  assert.strictEqual(args.environmentUrl, "https://orgf3e07203.crm4.dynamics.com");
});

test("TenantId at the top level is read when AccountInfo has none", () => {
  const args = emptyArgs();
  applyConnDefaults(args, { TenantId: TENANT, EnvironmentId: ENV, AgentId: AGENT });
  assert.strictEqual(args.tenantId, TENANT);
  assert.strictEqual(args.environmentUrl, null);
});

test("AccountInfo.TenantId wins over a top-level TenantId", () => {
  const args = emptyArgs();
  applyConnDefaults(args, realConn({ TenantId: "top-level" }));
  assert.strictEqual(args.tenantId, TENANT);
});

test("missing fields stay empty and non-string values are ignored", () => {
  const args = emptyArgs();
  const r = applyConnDefaults(args, { EnvironmentId: 42, AgentId: null, DataverseEndpoint: "  ", AccountInfo: "no" });
  assert.deepStrictEqual(r.used, []);
  assert.strictEqual(args.tenantId, null);
  assert.strictEqual(args.environmentId, null);
});

test("no conn.json: args are left alone", () => {
  const args = emptyArgs({ tenantId: "t" });
  const r = applyConnDefaults(args, null);
  assert.deepStrictEqual(r, { used: [], mismatches: [], clusterCategory: null });
  assert.strictEqual(args.tenantId, "t");
  assert.strictEqual(args.environmentId, null);
});

test("cluster category is reported but not copied into args", () => {
  const args = emptyArgs();
  const r = applyConnDefaults(args, realConn());
  assert.strictEqual(r.clusterCategory, 5);
  assert.ok(!("clusterCategory" in args));
});

test("storedClusterCategory: integers only, 0 counts", () => {
  assert.strictEqual(storedClusterCategory(realConn()), 5);
  assert.strictEqual(storedClusterCategory({ AccountInfo: { clusterCategory: 0 } }), 0);
  assert.strictEqual(storedClusterCategory({ AccountInfo: { clusterCategory: "5" } }), null);
  assert.strictEqual(storedClusterCategory({ AccountInfo: {} }), null);
  assert.strictEqual(storedClusterCategory({}), null);
  assert.strictEqual(storedClusterCategory(null), null);
});

// ---------------------------------------------------------------------------
// readConnJson / resolveConnDefaults on real folders
// ---------------------------------------------------------------------------

const root = fs.mkdtempSync(path.join(os.tmpdir(), "zzt-conn-defaults-"));

function writeConn(dir, text) {
  fs.mkdirSync(path.join(dir, ".mcs"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".mcs", "conn.json"), text);
}

test("readConnJson: parses, tolerates a BOM, returns null for junk or a missing file", () => {
  const a = path.join(root, "a");
  writeConn(a, JSON.stringify(realConn()));
  assert.strictEqual(readConnJson(a).AgentId, AGENT);
  const bom = path.join(root, "bom");
  writeConn(bom, "﻿" + JSON.stringify(realConn()));
  assert.strictEqual(readConnJson(bom).AgentId, AGENT);
  const bad = path.join(root, "bad");
  writeConn(bad, "{not json");
  assert.strictEqual(readConnJson(bad), null);
  const arr = path.join(root, "arr");
  writeConn(arr, "[1]");
  assert.strictEqual(readConnJson(arr), null);
  assert.strictEqual(readConnJson(path.join(root, "nothing")), null);
});

function makeFindAgentDir() {
  // The real one is in manage-agent.js: the folder itself, else a subfolder with .mcs/conn.json.
  return (workspace) => {
    if (fs.existsSync(path.join(workspace, ".mcs", "conn.json"))) return workspace;
    for (const e of fs.readdirSync(workspace, { withFileTypes: true })) {
      if (e.isDirectory() && fs.existsSync(path.join(workspace, e.name, ".mcs", "conn.json"))) return path.join(workspace, e.name);
    }
    return workspace;
  };
}

function resolve(args) {
  const logs = [];
  const warns = [];
  const result = resolveConnDefaults(args, {
    findAgentDir: makeFindAgentDir(),
    log: (m) => logs.push(m),
    warn: (m) => warns.push(m),
  });
  return { result, logs, warns };
}

test("resolveConnDefaults: workspace is the agent folder", () => {
  const ws = path.join(root, "direct");
  writeConn(ws, JSON.stringify(realConn()));
  const args = emptyArgs({ workspace: ws });
  const { logs, warns } = resolve(args);
  assert.strictEqual(args.tenantId, TENANT);
  assert.strictEqual(args.environmentId, ENV);
  assert.deepStrictEqual(warns, []);
  assert.strictEqual(logs.length, 1);
  assert.match(logs[0], /^From \.mcs\/conn\.json: .*tenantId.*environmentId/);
});

test("resolveConnDefaults: workspace is the folder that holds the agent folder", () => {
  const ws = path.join(root, "parent");
  writeConn(path.join(ws, "my agent"), JSON.stringify(realConn()));
  const args = emptyArgs({ workspace: ws });
  resolve(args);
  assert.strictEqual(args.agentId, AGENT);
});

for (const command of ["validate", "push", "pull", "changes", "publish"]) {
  test(`resolveConnDefaults: ${command} is filled`, () => {
    const ws = path.join(root, "direct");
    const args = emptyArgs({ workspace: ws, command });
    resolve(args);
    assert.strictEqual(args.tenantId, TENANT);
  });
}

for (const command of ["clone", "auth", "list-agents", "list-envs", "doctor"]) {
  test(`resolveConnDefaults: ${command} is left alone`, () => {
    const ws = path.join(root, "direct");
    const args = emptyArgs({ workspace: ws, command });
    const { result } = resolve(args);
    assert.strictEqual(result, null);
    assert.strictEqual(args.tenantId, null);
  });
}

test("WORKSPACE_COMMANDS is exactly the five sync commands", () => {
  assert.deepStrictEqual([...WORKSPACE_COMMANDS].sort(), ["changes", "publish", "pull", "push", "validate"]);
});

test("resolveConnDefaults: without --workspace nothing happens", () => {
  const args = emptyArgs({ workspace: null });
  const { result, warns } = resolve(args);
  assert.strictEqual(result, null);
  assert.deepStrictEqual(warns, []);
});

test("resolveConnDefaults: no conn.json and no flags gives one warning that says what to do", () => {
  const ws = path.join(root, "empty");
  fs.mkdirSync(ws);
  const args = emptyArgs({ workspace: ws });
  const { warns } = resolve(args);
  assert.strictEqual(warns.length, 1);
  assert.match(warns[0], /No \.mcs\/conn\.json found under .*empty.*--tenant-id and --environment-id/);
});

test("resolveConnDefaults: no conn.json but the flags are given gives no warning", () => {
  const ws = path.join(root, "empty");
  const args = emptyArgs({ workspace: ws, tenantId: "t", environmentId: "e" });
  assert.deepStrictEqual(resolve(args).warns, []);
});

test("resolveConnDefaults: a differing explicit tenant warns once and keeps the flag", () => {
  const ws = path.join(root, "direct");
  const args = emptyArgs({ workspace: ws, tenantId: "other" });
  const { warns } = resolve(args);
  assert.strictEqual(warns.length, 1);
  assert.strictEqual(args.tenantId, "other");
});

// ---------------------------------------------------------------------------
// The built bundle, no network: a workspace with conn.json but without
// .mcs/botdefinition.json stops at the botdefinition check, which comes after
// the tenant and environment checks. So the run proves that the options were
// filled in from conn.json.
// ---------------------------------------------------------------------------

const bundle = path.join(__dirname, "..", "scripts", "manage-agent.bundle.js");
const home = fs.mkdtempSync(path.join(os.tmpdir(), "zzt-conn-defaults-home-"));

function runBundle(args) {
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  for (const k of Object.keys(env)) {
    if (/^CPS_/.test(k) || ["CLAUDE_PLUGIN_DATA", "CLAUDE_PLUGIN_ROOT", "SFCS_PLUGIN_DATA", "PLUGIN_DATA"].includes(k)) delete env[k];
  }
  return spawnSync(process.execPath, [bundle, ...args], { env, encoding: "utf8", timeout: 30000 });
}

const bundleWs = path.join(root, "bundle-ws");
writeConn(bundleWs, JSON.stringify(realConn()));

for (const command of ["validate", "push", "pull", "changes"]) {
  test(`bundle: ${command} --workspace alone gets past the tenant and environment checks`, () => {
    const r = runBundle([command, "--workspace", bundleWs]);
    assert.strictEqual(r.status, 1, r.stderr);
    const out = JSON.parse(r.stdout.trim());
    assert.match(out.error, /No \.mcs\/botdefinition\.json found/);
    assert.doesNotMatch(out.error, /--tenant-id|--environment-id/);
    assert.match(r.stderr, /From \.mcs\/conn\.json: .*tenantId/);
  });
}

test("bundle: the folder that holds the agent works as --workspace", () => {
  const parent = path.join(root, "bundle-parent");
  writeConn(path.join(parent, "agent"), JSON.stringify(realConn()));
  const r = runBundle(["validate", "--workspace", parent]);
  assert.match(JSON.parse(r.stdout.trim()).error, /No \.mcs\/botdefinition\.json found/);
});

test("bundle: without conn.json the old error and a hint", () => {
  const ws = path.join(root, "bundle-empty");
  fs.mkdirSync(ws);
  const r = runBundle(["validate", "--workspace", ws]);
  assert.strictEqual(r.status, 1);
  assert.match(JSON.parse(r.stdout.trim()).error, /--tenant-id \(or CPS_TENANT_ID\) is required/);
  assert.match(r.stderr, /\[WARN\] No \.mcs\/conn\.json found under/);
});

test("bundle: a conn.json without a tenant still asks for --tenant-id", () => {
  const ws = path.join(root, "bundle-notenant");
  writeConn(ws, JSON.stringify({ EnvironmentId: ENV, AgentId: AGENT }));
  const r = runBundle(["validate", "--workspace", ws]);
  assert.match(JSON.parse(r.stdout.trim()).error, /--tenant-id/);
});

test("bundle: an explicit --tenant-id that differs from conn.json is kept and warned about", () => {
  const r = runBundle(["validate", "--workspace", bundleWs, "--tenant-id", "00000000-0000-0000-0000-000000000000"]);
  assert.match(JSON.parse(r.stdout.trim()).error, /No \.mcs\/botdefinition\.json found/);
  assert.match(r.stderr, /\[WARN\] Tenant 00000000-0000-0000-0000-000000000000 differs from /);
});

fs.rmSync(root, { recursive: true, force: true });
fs.rmSync(home, { recursive: true, force: true });

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
