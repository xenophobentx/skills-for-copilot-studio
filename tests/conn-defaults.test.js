/**
 * Tests for conn-defaults: manage-agent fills missing connection options from
 * the workspace's .mcs/conn.json, and checks what it takes.
 *
 * Run: node tests/conn-defaults.test.js
 */

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const cd = require("../scripts/src/conn-defaults");
const { applyConnDefaults, resolveConnDefaults, checkUrl, listAgentFolders, readConnJson } = cd;
const { resolveClusterCategory } = require("../scripts/src/shared-auth");

let passed = 0;
let failed = 0;
const pending = [];
function fail(name, e) {
  failed++;
  console.error(`FAIL: ${name}\n  ${String(e && e.message).split("\n").join("\n  ")}`);
}
function test(name, fn) {
  try {
    const r = fn();
    if (r && typeof r.then === "function") {
      pending.push(r.then(() => { passed++; }, (e) => fail(name, e)));
    } else {
      passed++;
    }
  } catch (e) {
    fail(name, e);
  }
}

const TENANT = "8da7352d-9308-4b9f-80af-119d78f5a973";
const ENV = "5428dd9c-bae7-eb70-9855-4a7f49b23f4b";
const AGENT = "6352728b-c4bc-f111-aaaf-000d3ab656c6";
const OTHER_ENV = "11111111-2222-3333-4444-555555555555";
const DV = "https://orgf3e07203.crm4.dynamics.com";
const MG = "https://powervamg.eu-il102.gateway.prod.island.powerapps.com";

// Same shape as a conn.json that clone writes.
function realConn(extra = {}) {
  return {
    DataverseEndpoint: DV,
    EnvironmentId: ENV,
    EnvironmentDisplayName: "kornel_sand",
    AccountInfo: { AccountId: `x.${TENANT}`, TenantId: TENANT, AccountEmail: "a@b.c", clusterCategory: 5 },
    AgentId: AGENT,
    AgentManagementEndpoint: MG,
    AuthoringShape: 1,
    ...extra,
  };
}

function emptyArgs(extra = {}) {
  return {
    command: "validate",
    workspace: "/w",
    force: false,
    tenantId: null,
    environmentId: null,
    environmentUrl: null,
    agentMgmtUrl: null,
    environmentName: null,
    agentId: null,
    ...extra,
  };
}

// ctx for applyConnDefaults: the command line and environment the args came from
function ctx(argv = [], env = {}, command = "validate") {
  return { argv, env, command };
}

// ---------------------------------------------------------------------------
// applyConnDefaults: filling
// ---------------------------------------------------------------------------

test("nothing given: every option comes from conn.json", () => {
  const args = emptyArgs();
  const r = applyConnDefaults(args, realConn(), ctx());
  assert.strictEqual(args.tenantId, TENANT);
  assert.strictEqual(args.environmentId, ENV);
  assert.strictEqual(args.agentId, AGENT);
  assert.strictEqual(args.environmentUrl, DV);
  assert.strictEqual(args.agentMgmtUrl, MG);
  assert.strictEqual(args.environmentName, "kornel_sand");
  assert.deepStrictEqual(r.used.map((u) => u.option).sort(), ["agentId", "agentMgmtUrl", "environmentId", "environmentName", "environmentUrl", "tenantId"]);
  assert.deepStrictEqual(r.warnings, []);
  assert.strictEqual(r.envMatches, true);
});

test("flags win over conn.json", () => {
  const args = emptyArgs({
    tenantId: "other-tenant",
    environmentId: ENV,
    environmentUrl: "https://mine.crm.dynamics.com",
    agentMgmtUrl: "https://mine.example/mgmt",
    environmentName: "Mine",
    agentId: AGENT,
  });
  const argv = ["--tenant-id", "other-tenant", "--environment-id", ENV, "--environment-url", "https://mine.crm.dynamics.com", "--agent-mgmt-url", "https://mine.example/mgmt", "--environment-name", "Mine", "--agent-id", AGENT];
  const r = applyConnDefaults(args, realConn(), ctx(argv));
  assert.strictEqual(args.tenantId, "other-tenant");
  assert.strictEqual(args.environmentUrl, "https://mine.crm.dynamics.com");
  assert.strictEqual(args.agentMgmtUrl, "https://mine.example/mgmt");
  assert.strictEqual(args.environmentName, "Mine");
  assert.deepStrictEqual(r.used, []);
  assert.strictEqual(r.warnings.length, 3); // the tenant, the Dataverse URL and the agent management URL
  assert.match(r.warnings[0], /^--tenant-id other-tenant differs from the tenant in \.mcs\/conn\.json \(8da7352d.*\); using --tenant-id\./);
});

test("partial flags: only the missing options are filled", () => {
  const args = emptyArgs({ tenantId: TENANT, environmentUrl: "https://mine.crm.dynamics.com" });
  const r = applyConnDefaults(args, realConn(), ctx(["--tenant-id", TENANT, "--environment-url", "https://mine.crm.dynamics.com"]));
  assert.strictEqual(args.environmentUrl, "https://mine.crm.dynamics.com");
  assert.strictEqual(args.agentMgmtUrl, MG);
  assert.ok(!r.used.some((u) => u.option === "tenantId" || u.option === "environmentUrl"));
});

test("same ids in another letter case are not a mismatch", () => {
  const args = emptyArgs({ tenantId: TENANT.toUpperCase(), environmentId: ENV.toUpperCase(), agentId: AGENT.toUpperCase() });
  const r = applyConnDefaults(args, realConn(), ctx(["--tenant-id", "x", "--environment-id", "x", "--agent-id", "x"], {}, "publish"));
  assert.deepStrictEqual(r.warnings, []);
  assert.strictEqual(r.envMismatch, null);
});

test("empty strings count as not given", () => {
  const args = emptyArgs({ tenantId: "", environmentUrl: "" });
  applyConnDefaults(args, realConn(), ctx());
  assert.strictEqual(args.tenantId, TENANT);
  assert.strictEqual(args.environmentUrl, DV);
});

test("TenantId at the top level is read when AccountInfo has none", () => {
  const args = emptyArgs();
  applyConnDefaults(args, { TenantId: TENANT, EnvironmentId: ENV, AgentId: AGENT }, ctx());
  assert.strictEqual(args.tenantId, TENANT);
  assert.strictEqual(args.environmentUrl, null);
});

test("AccountInfo.TenantId wins over a top-level TenantId", () => {
  const args = emptyArgs();
  applyConnDefaults(args, realConn({ TenantId: "top-level" }), ctx());
  assert.strictEqual(args.tenantId, TENANT);
});

test("missing fields stay empty and non-string values are ignored", () => {
  const args = emptyArgs();
  const r = applyConnDefaults(args, { EnvironmentId: 42, AgentId: null, DataverseEndpoint: "  ", AccountInfo: "no" }, ctx());
  assert.deepStrictEqual(r.used, []);
  assert.strictEqual(args.tenantId, null);
  assert.strictEqual(args.environmentId, null);
});

test("no conn.json: args are left alone", () => {
  const args = emptyArgs({ tenantId: "t" });
  const r = applyConnDefaults(args, null, ctx());
  assert.deepStrictEqual(r.used, []);
  assert.deepStrictEqual(r.warnings, []);
  assert.strictEqual(args.tenantId, "t");
  assert.strictEqual(args.environmentId, null);
});

// ---------------------------------------------------------------------------
// Precedence: flags, then conn.json, then CPS_* variables. Warnings name the source.
// ---------------------------------------------------------------------------

test("CPS_TENANT_ID loses to conn.json and the warning names the variable", () => {
  const args = emptyArgs({ tenantId: "contoso.onmicrosoft.com" });
  const r = applyConnDefaults(args, realConn(), ctx([], { CPS_TENANT_ID: "contoso.onmicrosoft.com" }));
  assert.strictEqual(args.tenantId, TENANT);
  assert.strictEqual(r.warnings.length, 1);
  assert.match(r.warnings[0], /^CPS_TENANT_ID \(contoso\.onmicrosoft\.com\) differs from AccountInfo\.TenantId in \.mcs\/conn\.json/);
});

test("CPS_TENANT_ID with the same value is silent", () => {
  const args = emptyArgs({ tenantId: TENANT });
  const r = applyConnDefaults(args, realConn(), ctx([], { CPS_TENANT_ID: TENANT }));
  assert.deepStrictEqual(r.warnings, []);
});

test("a flag beats conn.json and CPS_TENANT_ID; the flag is named", () => {
  const args = emptyArgs({ tenantId: "from-flag" });
  const r = applyConnDefaults(args, realConn(), ctx(["--tenant-id", "from-flag"], { CPS_TENANT_ID: "from-env" }));
  assert.strictEqual(args.tenantId, "from-flag");
  assert.match(r.warnings[0], /^--tenant-id from-flag differs/);
});

test("CPS_ENVIRONMENT_URL for the same environment loses to the checked conn.json URL, with a warning", () => {
  const args = emptyArgs({ environmentUrl: "https://elsewhere.crm.dynamics.com" });
  const r = applyConnDefaults(args, realConn(), ctx([], { CPS_ENVIRONMENT_URL: "https://elsewhere.crm.dynamics.com" }));
  assert.strictEqual(args.environmentUrl, DV);
  assert.ok(r.warnings.some((w) => /^CPS_ENVIRONMENT_URL /.test(w)));
});

test("CPS_ENVIRONMENT_ID loses to conn.json, so it is no environment mismatch", () => {
  const args = emptyArgs({ environmentId: OTHER_ENV });
  const r = applyConnDefaults(args, realConn(), ctx([], { CPS_ENVIRONMENT_ID: OTHER_ENV }));
  assert.strictEqual(args.environmentId, ENV);
  assert.strictEqual(r.envMismatch, null);
  assert.strictEqual(args.environmentUrl, DV);
  assert.ok(r.warnings.some((w) => /^CPS_ENVIRONMENT_ID /.test(w)));
});

// ---------------------------------------------------------------------------
// Agent id: only publish sends it, so only publish compares it
// ---------------------------------------------------------------------------

for (const command of ["validate", "push", "pull", "changes"]) {
  test(`${command}: an --agent-id that differs gives no warning`, () => {
    const args = emptyArgs({ command, agentId: "other-agent" });
    const r = applyConnDefaults(args, realConn(), ctx(["--agent-id", "other-agent"], {}, command));
    assert.deepStrictEqual(r.warnings, []);
  });
}

test("publish: an --agent-id that differs warns and wins", () => {
  const args = emptyArgs({ command: "publish", agentId: "other-agent" });
  const r = applyConnDefaults(args, realConn(), ctx(["--agent-id", "other-agent"], {}, "publish"));
  assert.strictEqual(args.agentId, "other-agent");
  assert.strictEqual(r.warnings.length, 1);
  assert.match(r.warnings[0], /^--agent-id other-agent differs from the agent in \.mcs\/conn\.json/);
});

test("publish: the agent id from --url that differs warns and names --url", () => {
  const args = emptyArgs({ command: "publish", environmentId: ENV, agentId: "agent-from-url" });
  const r = applyConnDefaults(args, realConn(), ctx(["--url", "https://x"], {}, "publish"));
  assert.match(r.warnings[0], /^--url agent-from-url differs/);
});

// ---------------------------------------------------------------------------
// Environment mismatch
// ---------------------------------------------------------------------------

test("another environment by flag: reported, and nothing environment-bound is taken", () => {
  const args = emptyArgs({ environmentId: OTHER_ENV });
  const r = applyConnDefaults(args, realConn(), ctx(["--environment-id", OTHER_ENV]));
  assert.deepStrictEqual(r.envMismatch, { source: "--environment-id", given: OTHER_ENV, stored: ENV });
  assert.strictEqual(r.envMatches, false);
  assert.strictEqual(args.environmentUrl, null);
  assert.strictEqual(args.agentMgmtUrl, null);
  assert.strictEqual(args.environmentName, null);
  assert.strictEqual(args.agentId, null);
  assert.strictEqual(args.tenantId, TENANT);
  assert.match(r.warnings[0], /^--environment-id environment 11111111.* differs from the environment in \.mcs\/conn\.json \(kornel_sand, 5428dd9c/);
});

test("another environment by --url names --url", () => {
  const args = emptyArgs({ environmentId: OTHER_ENV, agentId: "a" });
  const r = applyConnDefaults(args, realConn(), ctx(["--url", "https://x"]));
  assert.strictEqual(r.envMismatch.source, "--url");
  assert.strictEqual(args.agentId, "a");
});

test("conn.json without an EnvironmentId and an explicit environment: nothing environment-bound is taken", () => {
  const args = emptyArgs({ environmentId: ENV });
  applyConnDefaults(args, realConn({ EnvironmentId: undefined }), ctx(["--environment-id", ENV]));
  assert.strictEqual(args.environmentUrl, null);
});

// ---------------------------------------------------------------------------
// Stored values belong to an environment or tenant
// ---------------------------------------------------------------------------

test("matchesEnvironment, matchesTenant", () => {
  assert.strictEqual(cd.matchesEnvironment({ environmentId: ENV.toUpperCase() }, realConn()), true);
  assert.strictEqual(cd.matchesEnvironment({ environmentId: OTHER_ENV }, realConn()), false);
  assert.strictEqual(cd.matchesEnvironment({ environmentId: null }, realConn()), false);
  assert.strictEqual(cd.matchesEnvironment({ environmentId: ENV }, null), false);
  assert.strictEqual(cd.matchesTenant({ tenantId: TENANT }, realConn()), true);
  assert.strictEqual(cd.matchesTenant({ tenantId: "contoso.onmicrosoft.com" }, realConn()), false);
  assert.strictEqual(cd.matchesTenant({ tenantId: TENANT }, {}), false);
});

test("storedClusterCategory: same environment only, integers only, 0 counts", () => {
  const same = { environmentId: ENV };
  assert.strictEqual(cd.storedClusterCategory(realConn(), same), 5);
  assert.strictEqual(cd.storedClusterCategory(realConn(), { environmentId: OTHER_ENV }), null);
  assert.strictEqual(cd.storedClusterCategory({ EnvironmentId: ENV, AccountInfo: { clusterCategory: 0 } }, same), 0);
  assert.strictEqual(cd.storedClusterCategory({ EnvironmentId: ENV, AccountInfo: { clusterCategory: "5" } }, same), null);
  assert.strictEqual(cd.storedClusterCategory({ EnvironmentId: ENV, AccountInfo: {} }, same), null);
  assert.strictEqual(cd.storedClusterCategory(null, same), null);
});

// The functions below live in manage-agent.js, which runs main() on load, so
// they are cut out of the source text and run with stubs.
const src = fs.readFileSync(path.join(__dirname, "..", "scripts", "src", "manage-agent.js"), "utf8");
function extract(name) {
  const start = src.search(new RegExp(`^(?:async )?function ${name}\\(`, "m"));
  if (start === -1) throw new Error(`function ${name} not found in manage-agent.js`);
  return src.slice(start, src.indexOf("\n}\n", start) + 3);
}
function load(names, stubs) {
  const keys = Object.keys(stubs);
  return new Function(...keys, `${names.map(extract).join("\n")}\nreturn { ${names.join(", ")} };`)(...keys.map((k) => stubs[k]));
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "zzt-conn-defaults-"));
function writeConn(dir, text) {
  fs.mkdirSync(path.join(dir, ".mcs"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".mcs", "conn.json"), text);
}
const agentDir = path.join(tmp, "agent");
writeConn(agentDir, JSON.stringify(realConn()));

const tokens = { copilotStudio: { accessToken: "t1", account: { homeAccountId: "token-account", username: "token@user" } }, dataverse: { accessToken: "t2" } };
const syncFns = load(["toFileUri", "findAgentDir", "loadConnJson", "buildSyncRequest", "lookupClusterCategory"], {
  fs, path, log: () => {},
  readConnJson: cd.readConnJson,
  resolveClusterCategory,
  matchesEnvironment: cd.matchesEnvironment,
  matchesTenant: cd.matchesTenant,
  storedClusterCategory: cd.storedClusterCategory,
});

function request(argsExtra) {
  return syncFns.buildSyncRequest({ workspace: agentDir, tenantId: TENANT, environmentId: ENV, environmentUrl: DV, agentMgmtUrl: MG, environmentName: "kornel_sand", ...argsExtra }, tokens);
}

test("buildSyncRequest: same tenant and environment: the account and category come from conn.json", () => {
  const r = request({});
  assert.deepStrictEqual(r.accountInfo, { accountId: `x.${TENANT}`, accountEmail: "a@b.c", tenantId: TENANT, clusterCategory: 5 });
  assert.strictEqual(r.environmentInfo.dataverseUrl, DV);
});

test("buildSyncRequest: another tenant: no part of the account comes from conn.json", () => {
  const r = request({ tenantId: "22222222-0000-0000-0000-000000000000" });
  assert.deepStrictEqual(r.accountInfo, { accountId: "token-account", accountEmail: "token@user", tenantId: "22222222-0000-0000-0000-000000000000", clusterCategory: undefined });
});

test("buildSyncRequest: a tenant given as a domain does not mix in the account either", () => {
  const r = request({ tenantId: "contoso.onmicrosoft.com" });
  assert.strictEqual(r.accountInfo.accountId, "token-account");
  assert.strictEqual(r.accountInfo.tenantId, "contoso.onmicrosoft.com");
});

test("buildSyncRequest: another environment: account kept, cluster category and solution versions dropped", () => {
  const sv = { SolutionVersions: { X: "1" } };
  const dir2 = path.join(tmp, "agent-sv");
  writeConn(dir2, JSON.stringify(realConn({ SolutionVersions: sv })));
  const same = syncFns.buildSyncRequest({ workspace: dir2, tenantId: TENANT, environmentId: ENV, environmentUrl: DV, agentMgmtUrl: MG }, tokens);
  assert.deepStrictEqual(same.solutionVersions, sv);
  const other = syncFns.buildSyncRequest({ workspace: dir2, tenantId: TENANT, environmentId: OTHER_ENV, environmentUrl: DV, agentMgmtUrl: MG }, tokens);
  assert.strictEqual(other.accountInfo.accountId, `x.${TENANT}`);
  assert.strictEqual(other.accountInfo.clusterCategory, undefined);
  assert.strictEqual(other.solutionVersions, undefined);
});

test("buildSyncRequest: URLs are never read from conn.json directly", () => {
  const r = request({ environmentUrl: null, agentMgmtUrl: null });
  assert.strictEqual(r.environmentInfo.dataverseUrl, undefined);
  assert.strictEqual(r.environmentInfo.agentManagementUrl, undefined);
});

test("lookupClusterCategory: the stored category only for the same environment", () => {
  assert.strictEqual(syncFns.lookupClusterCategory({ workspace: agentDir, environmentId: ENV }), 5);
  const dir4 = path.join(tmp, "agent4");
  writeConn(dir4, JSON.stringify(realConn({ AccountInfo: { TenantId: TENANT, clusterCategory: 4 } })));
  assert.strictEqual(syncFns.lookupClusterCategory({ workspace: dir4, environmentId: ENV }), 4);
  assert.strictEqual(syncFns.lookupClusterCategory({ workspace: dir4, environmentId: OTHER_ENV }), 5);
  assert.strictEqual(
    syncFns.lookupClusterCategory({ workspace: dir4, environmentId: OTHER_ENV, url: "https://copilotstudio.preview.microsoft.com/environments/x/bots/y" }),
    4
  );
});

test("acquireLspTokens: the stored category is used for the same environment, not for another", async () => {
  const calls = [];
  const fns = load(["acquireLspTokens"], {
    findAgentDir: syncFns.findAgentDir,
    loadConnJson: syncFns.loadConnJson,
    log: () => {},
    matchesEnvironment: cd.matchesEnvironment,
    storedClusterCategory: cd.storedClusterCategory,
    VSCODE_CLIENT_ID: "client",
    getOrAcquireIslandToken: async (tenant, category) => { calls.push(["island", tenant, category]); return {}; },
    getOrAcquireToken: async (tenant, client, scopes) => { calls.push(["token", tenant, scopes[0]]); return {}; },
  });
  await fns.acquireLspTokens({ workspace: agentDir, tenantId: TENANT, environmentId: ENV, environmentUrl: DV });
  assert.deepStrictEqual(calls[0], ["island", TENANT, 5]);
  calls.length = 0;
  await fns.acquireLspTokens({ workspace: agentDir, tenantId: TENANT, environmentId: OTHER_ENV, environmentUrl: "https://other.crm.dynamics.com" });
  assert.deepStrictEqual(calls[0], ["token", TENANT, "https://api.powerplatform.com/.default"]);
});

// ---------------------------------------------------------------------------
// M3: URLs from conn.json
// ---------------------------------------------------------------------------

test("checkUrl accepts what BAP returns", () => {
  assert.ok(checkUrl(DV, [".dynamics.com"]).url);
  assert.ok(checkUrl(MG, [".powerapps.com", ".powerplatform.com"]).url);
  assert.ok(checkUrl("https://X.CRM.DYNAMICS.COM", [".dynamics.com"]).url);
  assert.ok(checkUrl("https://org.crm.dynamics.com:443/", [".dynamics.com"]).url);
});

for (const [label, value, reason] of [
  ["http", "http://org.crm.dynamics.com", /not https/],
  ["other host", "https://attacker.example/steal", /host is not on/],
  ["look-alike suffix", "https://evildynamics.com", /host is not on/],
  ["look-alike prefix", "https://org.crm.dynamics.com.evil.example", /host is not on/],
  ["credentials", "https://org.crm.dynamics.com@evil.example/", /credentials|host is not on/],
  ["credentials on a good host", "https://user:pw@org.crm.dynamics.com/", /credentials/],
  ["unusual port", "https://org.crm.dynamics.com:8443", /port/],
  ["not a URL", "orgf3e07203", /not a URL/],
  ["file URL", "file:///etc/passwd", /not https/],
]) {
  test(`checkUrl rejects ${label}`, () => {
    const r = checkUrl(value, [".dynamics.com"]);
    assert.strictEqual(r.url, undefined);
    assert.match(r.reason, reason);
  });
}

test("a bad Dataverse URL in conn.json is not used: warning, option left empty for the lookup", () => {
  const args = emptyArgs();
  const r = applyConnDefaults(args, realConn({ DataverseEndpoint: "http://attacker.example" }), ctx());
  assert.strictEqual(args.environmentUrl, null);
  assert.strictEqual(args.agentMgmtUrl, MG);
  assert.strictEqual(r.rejected.length, 1);
  assert.strictEqual(r.rejected[0].option, "environmentUrl");
  assert.match(r.warnings[0], /DataverseEndpoint \(http:\/\/attacker\.example\) is not used: not https\. --environment-url sets it, or the environment lookup fills it\./);
});

test("a bad agent management URL is not used either", () => {
  const args = emptyArgs();
  applyConnDefaults(args, realConn({ AgentManagementEndpoint: "https://attacker.example/steal" }), ctx());
  assert.strictEqual(args.agentMgmtUrl, null);
  assert.strictEqual(args.environmentUrl, DV);
});

test("an explicit flag can still set an unusual URL", () => {
  const args = emptyArgs({ agentMgmtUrl: "https://mgmt.gov.example/x" });
  applyConnDefaults(args, realConn({ AgentManagementEndpoint: "http://bad" }), ctx(["--agent-mgmt-url", "https://mgmt.gov.example/x"]));
  assert.strictEqual(args.agentMgmtUrl, "https://mgmt.gov.example/x");
});

// V1: the parsed origin comes back, not the text as typed
test("V1: checkUrl returns the parsed origin", () => {
  assert.strictEqual(checkUrl("https://X.CRM.DYNAMICS.COM:443/api/data?x=1#frag", [".dynamics.com"]).url, "https://x.crm.dynamics.com");
  assert.strictEqual(checkUrl("https:x.crm.dynamics.com", [".dynamics.com"]).url, "https://x.crm.dynamics.com");
  assert.strictEqual(checkUrl("https:\\\\x.crm.dynamics.com", [".dynamics.com"]).url, "https://x.crm.dynamics.com");
  assert.strictEqual(checkUrl("https://ev\nil.dynamics.com", [".dynamics.com"]).url, "https://evil.dynamics.com");
});

test("V1: the value that reaches args has no path, query or odd spelling", () => {
  const args = emptyArgs();
  applyConnDefaults(args, realConn({ DataverseEndpoint: `${DV}/api/data/v9.2?x=1#f`, AgentManagementEndpoint: "https:" + MG.slice(6) }), ctx());
  assert.strictEqual(args.environmentUrl, DV);
  assert.strictEqual(args.agentMgmtUrl, MG);
});

// V2: a URL flag that is not the workspace's environment
test("V2: --environment-url on another host is a mismatch, same host with a path is not", () => {
  const other = emptyArgs({ environmentId: ENV, environmentUrl: "https://orgprod.crm4.dynamics.com" });
  const r = applyConnDefaults(other, realConn(), ctx(["--environment-url", "https://orgprod.crm4.dynamics.com"]));
  assert.strictEqual(r.urlMismatches.length, 1);
  assert.deepStrictEqual([r.urlMismatches[0].source, r.urlMismatches[0].what, r.urlMismatches[0].stored], ["--environment-url", "Dataverse URL", DV]);
  assert.strictEqual(other.environmentUrl, "https://orgprod.crm4.dynamics.com");
  assert.match(r.warnings[0], /^--environment-url https:\/\/orgprod\.crm4\.dynamics\.com differs from the Dataverse URL in \.mcs\/conn\.json/);
  const same = emptyArgs({ environmentUrl: DV.toUpperCase() + "/some/path" });
  const r2 = applyConnDefaults(same, realConn(), ctx(["--environment-url", DV.toUpperCase() + "/some/path"]));
  assert.deepStrictEqual(r2.urlMismatches, []);
});

test("V2: --agent-mgmt-url on another host is a mismatch too", () => {
  const args = emptyArgs({ agentMgmtUrl: "https://powervamg.other.gateway.prod.island.powerapps.com" });
  const r = applyConnDefaults(args, realConn(), ctx(["--agent-mgmt-url", args.agentMgmtUrl]));
  assert.strictEqual(r.urlMismatches[0].what, "agent management URL");
});

test("V2: a CPS_ENVIRONMENT_URL does not count, conn.json wins; a rejected conn.json URL is not compared", () => {
  const a = emptyArgs({ environmentUrl: "https://orgprod.crm4.dynamics.com" });
  const r = applyConnDefaults(a, realConn(), ctx([], { CPS_ENVIRONMENT_URL: a.environmentUrl }));
  assert.deepStrictEqual(r.urlMismatches, []);
  assert.strictEqual(a.environmentUrl, DV);
  const b = emptyArgs({ environmentUrl: "https://orgprod.crm4.dynamics.com" });
  const r2 = applyConnDefaults(b, realConn({ DataverseEndpoint: "http://bad" }), ctx(["--environment-url", b.environmentUrl]));
  assert.deepStrictEqual(r2.urlMismatches, []);
});

test("V2: another environment id and a URL flag give the environment mismatch only", () => {
  const args = emptyArgs({ environmentId: OTHER_ENV, environmentUrl: "https://orgprod.crm4.dynamics.com" });
  const r = applyConnDefaults(args, realConn(), ctx(["--environment-id", OTHER_ENV, "--environment-url", args.environmentUrl]));
  assert.ok(r.envMismatch);
  assert.deepStrictEqual(r.urlMismatches, []);
});

// Nit: the wording of the rejected URL warning for publish
test("nit: publish says it has no lookup when the conn.json Dataverse URL is rejected", () => {
  const args = emptyArgs({ command: "publish" });
  const r = applyConnDefaults(args, realConn({ DataverseEndpoint: "http://bad.example" }), ctx([], {}, "publish"));
  assert.match(r.warnings[0], /is not used: not https\. publish has no environment lookup, so pass --environment-url\.$/);
  assert.doesNotMatch(r.warnings[0], /lookup fills it/);
});

test("nit: publish does not warn about a rejected agent management URL (it does not use it)", () => {
  const args = emptyArgs({ command: "publish" });
  const r = applyConnDefaults(args, realConn({ AgentManagementEndpoint: "http://bad.example" }), ctx([], {}, "publish"));
  assert.deepStrictEqual(r.warnings, []);
  assert.strictEqual(r.rejected.length, 1);
});

test("nit: the other commands keep the lookup wording", () => {
  const r = applyConnDefaults(emptyArgs(), realConn({ DataverseEndpoint: "http://bad.example" }), ctx());
  assert.match(r.warnings[0], /--environment-url sets it, or the environment lookup fills it\.$/);
});

test("nit: a BOM in conn.json is fine for the reader buildSyncRequest uses", () => {
  const dir = path.join(tmp, "bom-sync");
  writeConn(dir, "\uFEFF" + JSON.stringify(realConn({ SolutionVersions: { A: "1" } })));
  const r = syncFns.buildSyncRequest({ workspace: dir, tenantId: TENANT, environmentId: ENV, environmentUrl: DV, agentMgmtUrl: MG }, tokens);
  assert.strictEqual(r.accountInfo.accountId, `x.${TENANT}`);
  assert.deepStrictEqual(r.solutionVersions, { A: "1" });
});

test("nit: no em or en dash on the lines of manage-agent.js that this branch touches", () => {
  assert.ok(src.includes("// Build accountInfo: conn.json uses PascalCase"));
  const mine = fs.readFileSync(path.join(__dirname, "..", "scripts", "src", "conn-defaults.js"), "utf8");
  assert.ok(!/[\u2013\u2014]/.test(mine));
});

test("docs: the push section of the manage-agent skill says what --force skips", () => {
  const skill = fs.readFileSync(path.join(__dirname, "..", "skills", "manage-agent", "SKILL.md"), "utf8");
  assert.match(skill, /`--force` skips three things: validation, `instructions-shape`, and the environment guard\./);
});

// ---------------------------------------------------------------------------
// M1: several agents under the workspace
// ---------------------------------------------------------------------------

test("listAgentFolders: the folder itself, one subfolder, several sorted, none", () => {
  assert.deepStrictEqual(listAgentFolders(agentDir), [agentDir]);
  const one = path.join(tmp, "one");
  writeConn(path.join(one, "my agent"), JSON.stringify(realConn()));
  assert.deepStrictEqual(listAgentFolders(one), [path.join(one, "my agent")]);
  const two = path.join(tmp, "two");
  writeConn(path.join(two, "bbb-dev"), JSON.stringify(realConn()));
  writeConn(path.join(two, "aaa-prod"), JSON.stringify(realConn()));
  fs.mkdirSync(path.join(two, "notes"));
  writeConn(path.join(two, ".hidden"), JSON.stringify(realConn()));
  assert.deepStrictEqual(listAgentFolders(two), [path.join(two, "aaa-prod"), path.join(two, "bbb-dev")]);
  assert.deepStrictEqual(listAgentFolders(path.join(tmp, "nothing")), []);
});

// ---------------------------------------------------------------------------
// resolveConnDefaults on real folders
// ---------------------------------------------------------------------------

class Died extends Error {}
function resolve(args, { argv = [], env = {} } = {}) {
  const logs = [];
  const warns = [];
  let died = null;
  let result;
  try {
    result = resolveConnDefaults(args, {
      findAgentDir: (ws) => {
        const f = listAgentFolders(ws);
        return f.length ? f[0] : path.resolve(ws);
      },
      log: (m) => logs.push(m),
      warn: (m) => warns.push(m),
      die: (m) => { died = m; throw new Died(m); },
      argv,
      env,
    });
  } catch (e) {
    if (!(e instanceof Died)) throw e;
  }
  return { result, logs, warns, died };
}

test("resolveConnDefaults: workspace is the agent folder", () => {
  const args = emptyArgs({ workspace: agentDir });
  const { logs, warns, died } = resolve(args);
  assert.strictEqual(died, null);
  assert.strictEqual(args.tenantId, TENANT);
  assert.deepStrictEqual(warns, []);
  assert.strictEqual(logs.length, 2);
  assert.match(logs[1], /^From \.mcs\/conn\.json: .*tenantId.*environmentId/);
});

test("resolveConnDefaults: workspace is the folder that holds the one agent folder", () => {
  const args = emptyArgs({ workspace: path.join(tmp, "one") });
  resolve(args);
  assert.strictEqual(args.agentId, AGENT);
});

test("M1: several agents under the workspace stop with all of them listed", () => {
  const args = emptyArgs({ workspace: path.join(tmp, "two") });
  const { died } = resolve(args);
  assert.match(died, /^Several agents found under .*two:/);
  assert.ok(died.includes(path.join(tmp, "two", "aaa-prod")));
  assert.ok(died.includes(path.join(tmp, "two", "bbb-dev")));
  assert.match(died, /Pass --workspace with the folder of the one you mean\.$/);
  assert.strictEqual(args.tenantId, null);
});

test("M1: several agents stop push even when every flag is given", () => {
  const args = emptyArgs({ workspace: path.join(tmp, "two"), command: "push", tenantId: "t", environmentId: "e" });
  assert.match(resolve(args, { argv: ["--tenant-id", "t", "--environment-id", "e"] }).died, /Several agents/);
});

test("M2: the log line names the target: environment name and id, agent, tenant, both hosts", () => {
  const args = emptyArgs({ workspace: agentDir });
  const { logs } = resolve(args);
  assert.strictEqual(
    logs[0],
    `Target ${agentDir}: environment kornel_sand (${ENV}), agent ${AGENT}, tenant ${TENANT}, ` +
      "Dataverse orgf3e07203.crm4.dynamics.com, agent management powervamg.eu-il102.gateway.prod.island.powerapps.com"
  );
});

test("M2: the log line shows flag values and says when a URL will be looked up", () => {
  const args = emptyArgs({ workspace: agentDir, environmentUrl: "https://mine.crm.dynamics.com" });
  const { logs } = resolve(args, { argv: ["--environment-url", "https://mine.crm.dynamics.com"] });
  assert.match(logs[0], /Dataverse mine\.crm\.dynamics\.com, agent management powervamg/);
  const bad = path.join(tmp, "badurl");
  writeConn(bad, JSON.stringify(realConn({ AgentManagementEndpoint: "http://x" })));
  const args2 = emptyArgs({ workspace: bad });
  const r2 = resolve(args2);
  assert.match(r2.logs[0], /agent management \(looked up\)$/);
});

for (const command of ["validate", "push", "pull", "changes", "publish"]) {
  test(`resolveConnDefaults: ${command} is filled`, () => {
    const args = emptyArgs({ workspace: agentDir, command });
    resolve(args);
    assert.strictEqual(args.tenantId, TENANT);
  });
}

for (const command of ["clone", "auth", "list-agents", "list-envs", "doctor"]) {
  test(`resolveConnDefaults: ${command} is left alone`, () => {
    const args = emptyArgs({ workspace: path.join(tmp, "two"), command });
    const { result, died } = resolve(args);
    assert.strictEqual(result, null);
    assert.strictEqual(died, null);
    assert.strictEqual(args.tenantId, null);
  });
}

test("resolveConnDefaults: without --workspace nothing happens", () => {
  const { result, warns } = resolve(emptyArgs({ workspace: null }));
  assert.strictEqual(result, null);
  assert.deepStrictEqual(warns, []);
});

// Trust: an explicit environment that is not the workspace's
for (const command of ["push", "pull", "publish"]) {
  test(`trust: ${command} with another --environment-id is refused`, () => {
    const args = emptyArgs({ workspace: agentDir, command, environmentId: OTHER_ENV });
    const { died, warns } = resolve(args, { argv: ["--environment-id", OTHER_ENV] });
    assert.match(died, new RegExp(`^${command} refused: --environment-id environment ${OTHER_ENV} is not the environment of this workspace \\(${ENV} in \\.mcs/conn\\.json\\)\\. .*--force`));
    assert.ok(warns.length >= 1);
  });
  test(`trust: ${command} with another environment and --force goes on, without conn.json URLs`, () => {
    const args = emptyArgs({ workspace: agentDir, command, environmentId: OTHER_ENV, force: true });
    const { died, warns } = resolve(args, { argv: ["--environment-id", OTHER_ENV, "--force"] });
    assert.strictEqual(died, null);
    assert.strictEqual(args.environmentUrl, null);
    assert.strictEqual(args.agentId, null);
    assert.match(warns[0], /differs from the environment in \.mcs\/conn\.json/);
  });
}

for (const command of ["validate", "changes"]) {
  test(`trust: ${command} with another environment warns and goes on`, () => {
    const args = emptyArgs({ workspace: agentDir, command, environmentId: OTHER_ENV });
    const { died, warns } = resolve(args, { argv: ["--environment-id", OTHER_ENV] });
    assert.strictEqual(died, null);
    assert.strictEqual(warns.length, 1);
    assert.strictEqual(args.environmentUrl, null);
  });
}

test("trust: push --url of another environment is refused and names --url", () => {
  const args = emptyArgs({ workspace: agentDir, command: "push", environmentId: OTHER_ENV, agentId: "a" });
  assert.match(resolve(args, { argv: ["--url", "https://x"] }).died, /^push refused: --url environment/);
});

test("trust: publish --url of another environment with --force has no Dataverse URL to fall back on", () => {
  const args = emptyArgs({ workspace: agentDir, command: "publish", environmentId: OTHER_ENV, agentId: "a", force: true });
  resolve(args, { argv: ["--url", "https://x", "--force"] });
  assert.strictEqual(args.environmentUrl, null);
  assert.strictEqual(args.tenantId, TENANT);
});

test("trust: the same environment by flag is fine for push", () => {
  const args = emptyArgs({ workspace: agentDir, command: "push", environmentId: ENV });
  assert.strictEqual(resolve(args, { argv: ["--environment-id", ENV] }).died, null);
});

for (const command of ["push", "pull", "publish"]) {
  test(`V2: ${command} with another --environment-url is refused, --force goes on`, () => {
    const url = "https://orgprod.crm4.dynamics.com";
    const args = emptyArgs({ workspace: agentDir, command, environmentUrl: url });
    const r = resolve(args, { argv: ["--environment-url", url] });
    assert.match(r.died, new RegExp(`^${command} refused: --environment-url ${url.replace(/\./g, "\\.")} is not the Dataverse URL of this workspace \\(${DV.replace(/\./g, "\\.")} in \\.mcs/conn\\.json\\)\\. .*--force`));
    const forced = emptyArgs({ workspace: agentDir, command, environmentUrl: url, force: true });
    const f = resolve(forced, { argv: ["--environment-url", url, "--force"] });
    assert.strictEqual(f.died, null);
    assert.strictEqual(forced.environmentUrl, url);
    assert.match(f.warns[0], /differs from the Dataverse URL/);
  });
}

for (const command of ["validate", "changes"]) {
  test(`V2: ${command} with another --environment-url warns and goes on`, () => {
    const url = "https://orgprod.crm4.dynamics.com";
    const args = emptyArgs({ workspace: agentDir, command, environmentUrl: url });
    const r = resolve(args, { argv: ["--environment-url", url] });
    assert.strictEqual(r.died, null);
    assert.strictEqual(r.warns.length, 1);
  });
}

test("V2: push with another --agent-mgmt-url is refused and names the flag", () => {
  const url = "https://powervamg.other.gateway.prod.island.powerapps.com";
  const args = emptyArgs({ workspace: agentDir, command: "push", agentMgmtUrl: url });
  assert.match(resolve(args, { argv: ["--agent-mgmt-url", url] }).died, /^push refused: --agent-mgmt-url .* is not the agent management URL of this workspace/);
});

// Fallback hints without conn.json
const emptyWs = path.join(tmp, "empty");
fs.mkdirSync(emptyWs);

for (const command of ["validate", "push", "pull", "changes"]) {
  test(`hint: ${command} without conn.json says to clone again`, () => {
    const { warns } = resolve(emptyArgs({ workspace: emptyWs, command }));
    assert.strictEqual(warns.length, 1);
    assert.match(warns[0], /No \.mcs\/conn\.json found under .*empty.*botdefinition\.json either\. Clone the agent again into a new folder/);
    assert.doesNotMatch(warns[0], /--environment-id/);
  });
}

test("hint: publish without conn.json names the flags publish needs", () => {
  const { warns } = resolve(emptyArgs({ workspace: emptyWs, command: "publish" }));
  assert.match(warns[0], /publish then needs --tenant-id, --environment-url and --agent-id\.$/);
});

test("hint: publish with its flags given and no conn.json is quiet", () => {
  const args = emptyArgs({ workspace: emptyWs, command: "publish", tenantId: "t", environmentUrl: "u", agentId: "a" });
  assert.deepStrictEqual(resolve(args, { argv: ["--tenant-id", "t", "--environment-url", "u", "--agent-id", "a"] }).warns, []);
});

test("hint: validate with its flags given and no conn.json is quiet", () => {
  const args = emptyArgs({ workspace: emptyWs, tenantId: "t", environmentId: "e" });
  assert.deepStrictEqual(resolve(args, { argv: ["--tenant-id", "t", "--environment-id", "e"] }).warns, []);
});

test("readConnJson: parses, tolerates a BOM, returns null for junk or a missing file", () => {
  const bom = path.join(tmp, "bom");
  writeConn(bom, "\uFEFF" + JSON.stringify(realConn()));
  assert.strictEqual(readConnJson(bom).AgentId, AGENT);
  const bad = path.join(tmp, "bad");
  writeConn(bad, "{not json");
  assert.strictEqual(readConnJson(bad), null);
  const arr = path.join(tmp, "arr");
  writeConn(arr, "[1]");
  assert.strictEqual(readConnJson(arr), null);
  assert.strictEqual(readConnJson(path.join(tmp, "nothing")), null);
});

// ---------------------------------------------------------------------------
// The built bundle, no network. A workspace with conn.json but without
// .mcs/botdefinition.json stops at the botdefinition check, which comes after the
// tenant and environment checks, so these runs prove that the options were filled.
// ---------------------------------------------------------------------------

const bundle = path.join(__dirname, "..", "scripts", "manage-agent.bundle.js");
const home = fs.mkdtempSync(path.join(os.tmpdir(), "zzt-conn-defaults-home-"));

function runBundle(args, extraEnv = {}) {
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  for (const k of Object.keys(env)) {
    if (/^CPS_/.test(k) || ["CLAUDE_PLUGIN_DATA", "CLAUDE_PLUGIN_ROOT", "SFCS_PLUGIN_DATA", "PLUGIN_DATA"].includes(k)) delete env[k];
  }
  return spawnSync(process.execPath, [bundle, ...args], { env: { ...env, ...extraEnv }, encoding: "utf8", timeout: 30000 });
}
const errorOf = (r) => JSON.parse(r.stdout.trim()).error;

for (const command of ["validate", "push", "pull", "changes"]) {
  test(`bundle: ${command} --workspace alone gets past the tenant and environment checks`, () => {
    const r = runBundle([command, "--workspace", agentDir]);
    assert.strictEqual(r.status, 1, r.stderr);
    assert.match(errorOf(r), /No \.mcs\/botdefinition\.json found/);
    assert.match(r.stderr, new RegExp(`Target .*environment kornel_sand \\(${ENV}\\), agent ${AGENT}, tenant ${TENANT}, Dataverse orgf3e07203\\.crm4\\.dynamics\\.com`));
    assert.match(r.stderr, /From \.mcs\/conn\.json: .*tenantId/);
  });
}

test("bundle: M1 a parent with two agents stops before anything else", () => {
  const r = runBundle(["push", "--workspace", path.join(tmp, "two")]);
  assert.strictEqual(r.status, 1);
  assert.match(errorOf(r), /Several agents found under .*two:\n  .*aaa-prod\n  .*bbb-dev\nPass --workspace/);
});

test("bundle: M3 a conn.json with an http Dataverse URL warns and does not use it", () => {
  const ws = path.join(tmp, "bundle-badurl");
  writeConn(ws, JSON.stringify(realConn({ DataverseEndpoint: "http://attacker.example" })));
  const r = runBundle(["validate", "--workspace", ws]);
  assert.match(r.stderr, /\[WARN\] \.mcs\/conn\.json DataverseEndpoint \(http:\/\/attacker\.example\) is not used: not https/);
  assert.doesNotMatch(r.stderr, /Dataverse attacker/);
  assert.match(r.stderr, /Dataverse \(looked up\)/);
});

test("bundle: push to another environment is refused, validate only warns", () => {
  const push = runBundle(["push", "--workspace", agentDir, "--environment-id", OTHER_ENV]);
  assert.strictEqual(push.status, 1);
  assert.match(errorOf(push), /^push refused: --environment-id environment 11111111/);
  const forced = runBundle(["push", "--workspace", agentDir, "--environment-id", OTHER_ENV, "--force"]);
  assert.doesNotMatch(errorOf(forced), /refused/);
  const validate = runBundle(["validate", "--workspace", agentDir, "--environment-id", OTHER_ENV]);
  assert.match(validate.stderr, /\[WARN\] --environment-id environment 11111111/);
  assert.doesNotMatch(errorOf(validate), /refused/);
});

test("bundle: publish to another environment is refused", () => {
  const r = runBundle(["publish", "--workspace", agentDir, "--environment-id", OTHER_ENV]);
  assert.match(errorOf(r), /^publish refused: /);
});

test("bundle: V2 publish with another --environment-url is refused before any sign-in", () => {
  const r = runBundle(["publish", "--workspace", agentDir, "--environment-url", "https://orgprod.crm4.dynamics.com"]);
  assert.strictEqual(r.status, 1);
  assert.match(errorOf(r), /^publish refused: --environment-url https:\/\/orgprod\.crm4\.dynamics\.com is not the Dataverse URL of this workspace/);
});

test("bundle: V2 push with another --agent-mgmt-url is refused", () => {
  const r = runBundle(["push", "--workspace", agentDir, "--agent-mgmt-url", "https://x.island.powerapps.com"]);
  assert.match(errorOf(r), /^push refused: --agent-mgmt-url/);
});

const urlOf = (env, bot) => `https://copilotstudio.microsoft.com/environments/${env}/bots/${bot}/overview`;

test("bundle: V3 --url beats CPS_ENVIRONMENT_ID, so push --url of another environment is refused", () => {
  const r = runBundle(["push", "--workspace", agentDir, "--url", urlOf(OTHER_ENV, AGENT)], { CPS_ENVIRONMENT_ID: ENV });
  assert.strictEqual(r.status, 1);
  assert.match(errorOf(r), new RegExp(`^push refused: --url environment ${OTHER_ENV} is not the environment of this workspace`));
});

test("bundle: V3 with CPS_ENVIRONMENT_ID set to a third environment the label and id are the --url ones", () => {
  const third = "99999999-8888-7777-6666-555555555555";
  const r = runBundle(["publish", "--workspace", agentDir, "--url", urlOf(OTHER_ENV, AGENT)], { CPS_ENVIRONMENT_ID: third });
  assert.match(errorOf(r), new RegExp(`^publish refused: --url environment ${OTHER_ENV} `));
});

test("bundle: V3 --environment-id still beats --url, and a --url of the workspace's own environment is fine", () => {
  const r = runBundle(["push", "--workspace", agentDir, "--url", urlOf(ENV, AGENT), "--environment-id", OTHER_ENV]);
  assert.match(errorOf(r), new RegExp(`^push refused: --environment-id environment ${OTHER_ENV}`));
  const ok = runBundle(["validate", "--workspace", agentDir, "--url", urlOf(ENV, AGENT)], { CPS_ENVIRONMENT_ID: OTHER_ENV });
  assert.match(errorOf(ok), /No \.mcs\/botdefinition\.json found/);
});

test("bundle: CPS_TENANT_ID loses to conn.json and the warning names it", () => {
  const r = runBundle(["validate", "--workspace", agentDir], { CPS_TENANT_ID: "contoso.onmicrosoft.com" });
  assert.match(r.stderr, /\[WARN\] CPS_TENANT_ID \(contoso\.onmicrosoft\.com\) differs from AccountInfo\.TenantId/);
  assert.match(r.stderr, new RegExp(`tenant ${TENANT}`));
});

test("bundle: an --agent-id that differs gives no warning for validate", () => {
  const r = runBundle(["validate", "--workspace", agentDir, "--agent-id", "other"]);
  assert.doesNotMatch(r.stderr, /differs from the agent/);
});

test("bundle: without conn.json the old error and the clone-again hint", () => {
  const r = runBundle(["validate", "--workspace", emptyWs]);
  assert.strictEqual(r.status, 1);
  assert.match(errorOf(r), /--tenant-id \(or CPS_TENANT_ID\) is required/);
  assert.match(r.stderr, /\[WARN\] No \.mcs\/conn\.json found under .*Clone the agent again/);
});

test("bundle: publish without conn.json names the flags publish needs", () => {
  const r = runBundle(["publish", "--workspace", emptyWs]);
  assert.match(r.stderr, /publish then needs --tenant-id, --environment-url and --agent-id/);
  assert.match(errorOf(r), /--tenant-id/);
});

Promise.all(pending).then(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.rmSync(home, { recursive: true, force: true });
  console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
});
