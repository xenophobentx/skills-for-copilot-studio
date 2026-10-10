/**
 * Tests for the cluster category of `manage-agent clone` in
 * scripts/src/shared-auth.js: parseClusterCategory (the --cluster-category
 * value), clusterCategoryFromUrl (the category an agent URL host implies),
 * resolveClusterCategory (which source wins) and getBapHost. Also what the built
 * manage-agent bundle prints for a bad value, for a command that ignores the
 * option and for a category that has no environment lookup.
 *
 * Needs no npm packages and no sign-in: @azure/msal-node and ./msal-cache are
 * replaced by stubs while shared-auth loads, and the bundle stops before any
 * network or token cache access.
 *
 * Run: node tests/cluster-category.test.js
 */

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const Module = require("node:module");
const load = Module._load;
Module._load = function (request, ...rest) {
  if (request === "@azure/msal-node") return { PublicClientApplication: class {} };
  if (request === "./msal-cache") return { createCachePlugin: async () => ({}) };
  return load.call(this, request, ...rest);
};

const {
  ISLAND_RESOURCE_IDS, DEFAULT_CLUSTER_CATEGORY, parseClusterCategory, clusterCategoryFromUrl,
  getBapHost, resolveClusterCategory,
} = require(path.join(__dirname, "..", "scripts", "src", "shared-auth.js"));

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
  } catch (e) {
    failed++;
    console.error(`FAIL: ${name}\n  ${e.message}`);
  }
}

const AGENT = "/environments/5428dd9c-bae7-eb70-9855-4a7f49b23f4b/bots/6352728b-c4bc-f111-aaaf-000d3ab656c6/overview";

// ---------------------------------------------------------------------------
// parseClusterCategory
// ---------------------------------------------------------------------------

test("default is 5 (Prod)", () => {
  assert.equal(DEFAULT_CLUSTER_CATEGORY, 5);
});

test("every known category is accepted, as a string or a number", () => {
  for (const key of Object.keys(ISLAND_RESOURCE_IDS)) {
    assert.equal(parseClusterCategory(key), Number(key));
    assert.equal(parseClusterCategory(Number(key)), Number(key));
  }
});

test("surrounding spaces are ignored", () => {
  assert.equal(parseClusterCategory(" 4 "), 4);
});

for (const bad of ["abc", "", "   ", "9", "-1", "5.5", "05", "1e1", "5x", "0x5", "NaN", "Infinity", "constructor", "__proto__"]) {
  test(`rejects ${JSON.stringify(bad)}`, () => {
    assert.throws(() => parseClusterCategory(bad), /Invalid --cluster-category/);
  });
}

test("rejects a missing value", () => {
  assert.throws(() => parseClusterCategory(undefined), /Invalid --cluster-category \(missing value\)/);
});

test("the message lists the accepted values", () => {
  assert.throws(
    () => parseClusterCategory("abc"),
    (e) => e.message.includes('"abc"') && e.message.includes("0, 1, 2, 3, 4, 5, 6, 7, 8") && e.message.includes("5 is Prod")
  );
});

// ---------------------------------------------------------------------------
// clusterCategoryFromUrl
// ---------------------------------------------------------------------------

test("plain host is 5", () => {
  assert.equal(clusterCategoryFromUrl("https://copilotstudio.microsoft.com" + AGENT), 5);
});
test("preview host is 4", () => {
  assert.equal(clusterCategoryFromUrl("https://copilotstudio.preview.microsoft.com" + AGENT), 4);
});
test("preprod host is 3", () => {
  assert.equal(clusterCategoryFromUrl("https://copilotstudio.preprod.microsoft.com" + AGENT), 3);
});
test("test host is 2", () => {
  assert.equal(clusterCategoryFromUrl("https://copilotstudio.test.microsoft.com" + AGENT), 2);
});
test("host case does not matter", () => {
  assert.equal(clusterCategoryFromUrl("https://CopilotStudio.Preview.Microsoft.com" + AGENT), 4);
});
test("query and fragment do not matter", () => {
  assert.equal(clusterCategoryFromUrl("https://copilotstudio.test.microsoft.com" + AGENT + "?tab=topics#x"), 2);
});
test("other hosts give null", () => {
  assert.equal(clusterCategoryFromUrl("https://example.com" + AGENT), null);
  assert.equal(clusterCategoryFromUrl("https://copilotstudio.dev.microsoft.com" + AGENT), null);
  assert.equal(clusterCategoryFromUrl("https://copilotstudio.test.microsoft.com.evil.example" + AGENT), null);
  assert.equal(clusterCategoryFromUrl("https://evil.example/copilotstudio.test.microsoft.com" + AGENT), null);
});
test("junk gives null", () => {
  assert.equal(clusterCategoryFromUrl("not a url"), null);
  assert.equal(clusterCategoryFromUrl(""), null);
  assert.equal(clusterCategoryFromUrl(undefined), null);
});

// ---------------------------------------------------------------------------
// resolveClusterCategory: option > stored > URL host > default
// ---------------------------------------------------------------------------

const TEST_URL = "https://copilotstudio.test.microsoft.com" + AGENT;
const PREVIEW_URL = "https://copilotstudio.preview.microsoft.com" + AGENT;
const PROD_URL = "https://copilotstudio.microsoft.com" + AGENT;

test("nothing given: default 5, no conflict", () => {
  assert.deepEqual(resolveClusterCategory({}), { category: 5, source: "default", urlCategory: null, conflict: false });
  assert.deepEqual(resolveClusterCategory(), { category: 5, source: "default", urlCategory: null, conflict: false });
});
test("URL host alone decides", () => {
  assert.deepEqual(resolveClusterCategory({ url: PREVIEW_URL }), { category: 4, source: "url", urlCategory: 4, conflict: false });
  assert.deepEqual(resolveClusterCategory({ url: TEST_URL }), { category: 2, source: "url", urlCategory: 2, conflict: false });
  assert.equal(resolveClusterCategory({ url: PROD_URL }).category, 5);
});
test("a URL that is not a Copilot Studio URL falls back to the default", () => {
  assert.deepEqual(resolveClusterCategory({ url: "https://example.com" + AGENT }), { category: 5, source: "default", urlCategory: null, conflict: false });
});
test("the option beats the URL host and flags the conflict", () => {
  assert.deepEqual(resolveClusterCategory({ option: 5, url: PREVIEW_URL }), { category: 5, source: "option", urlCategory: 4, conflict: true });
  assert.deepEqual(resolveClusterCategory({ option: 4, url: PROD_URL }), { category: 4, source: "option", urlCategory: 5, conflict: true });
});
test("the option equal to the URL host is no conflict", () => {
  assert.equal(resolveClusterCategory({ option: 4, url: PREVIEW_URL }).conflict, false);
});
test("option 0 counts as given", () => {
  assert.deepEqual(resolveClusterCategory({ option: 0, url: PROD_URL }), { category: 0, source: "option", urlCategory: 5, conflict: true });
});
test("the stored value beats the URL host", () => {
  assert.deepEqual(resolveClusterCategory({ stored: 4, url: PROD_URL }), { category: 4, source: "stored", urlCategory: 5, conflict: true });
  assert.equal(resolveClusterCategory({ stored: 0 }).category, 0);
});
test("the option beats the stored value", () => {
  assert.deepEqual(resolveClusterCategory({ option: 3, stored: 4, url: PROD_URL }).source, "option");
  assert.equal(resolveClusterCategory({ option: 3, stored: 4 }).category, 3);
});
test("null counts as not given", () => {
  assert.deepEqual(resolveClusterCategory({ option: null, stored: null, url: null }), { category: 5, source: "default", urlCategory: null, conflict: false });
});

// ---------------------------------------------------------------------------
// getBapHost: same hosts as the VS Code extension 1.9.14
// ---------------------------------------------------------------------------

test("BAP host by category", () => {
  for (const c of [0, 1, 2]) assert.equal(getBapHost(c), "test.api.bap.microsoft.com");
  assert.equal(getBapHost(3), "preprod.api.bap.microsoft.com");
  assert.equal(getBapHost(4), "api.bap.microsoft.com");
  assert.equal(getBapHost(5), "api.bap.microsoft.com");
  assert.equal(getBapHost(DEFAULT_CLUSTER_CATEGORY), "api.bap.microsoft.com");
});
test("no BAP host for the government clouds, with a message that says what to pass", () => {
  for (const c of [6, 7, 8, 9, undefined]) {
    assert.throws(() => getBapHost(c), /categories 0 to 5 only.*Government clouds \(6 to 8\) are not supported/);
  }
});

// ---------------------------------------------------------------------------
// The built bundle: a bad value stops with a clear JSON error and exit code 1.
// ---------------------------------------------------------------------------

const bundle = path.join(__dirname, "..", "scripts", "manage-agent.bundle.js");
const home = fs.mkdtempSync(path.join(os.tmpdir(), "zzt-cluster-category-"));

function runEnv() {
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  for (const k of ["CLAUDE_PLUGIN_DATA", "CLAUDE_PLUGIN_ROOT", "SFCS_PLUGIN_DATA", "PLUGIN_DATA", "CPS_TENANT_ID"]) delete env[k];
  return env;
}

function runBundle(args) {
  return spawnSync(process.execPath, [bundle, "clone", ...args], { env: runEnv(), encoding: "utf8", timeout: 30000 });
}

for (const [label, args] of [
  ["non-number", ["--cluster-category", "abc"]],
  ["unknown number", ["--cluster-category", "9"]],
  ["decimal", ["--cluster-category", "5.5"]],
  ["missing value", ["--cluster-category"]],
]) {
  test(`bundle: ${label} stops with a clear error`, () => {
    const r = runBundle(args);
    assert.equal(r.status, 1, r.stderr);
    const out = JSON.parse(r.stdout.trim());
    assert.equal(out.status, "error");
    assert.match(out.error, /Invalid --cluster-category/);
    assert.match(out.error, /Use one of 0, 1, 2, 3, 4, 5, 6, 7, 8/);
  });
}

test("bundle: other commands warn that --cluster-category is ignored", () => {
  const r = spawnSync(process.execPath, [bundle, "push", "--cluster-category", "3"], {
    env: runEnv(), encoding: "utf8", timeout: 30000,
  });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /\[WARN\] --cluster-category only applies to clone, so push ignores it\. Other commands use the value stored in \.mcs\/conn\.json\./);
  assert.match(JSON.parse(r.stdout.trim()).error, /--workspace is required/);
});

test("bundle: clone does not warn about --cluster-category", () => {
  const r = runBundle(["--cluster-category", "4"]);
  assert.doesNotMatch(r.stderr, /only applies to clone/);
});

test("bundle: a government category with no --environment-url stops before any lookup or sign-in", () => {
  const r = runBundle(["--workspace", path.join(home, "gov"), "--tenant-id", "00000000-0000-0000-0000-000000000000",
    "--url", PROD_URL, "--cluster-category", "7"]);
  assert.equal(r.status, 1, r.stderr);
  const out = JSON.parse(r.stdout.trim());
  assert.match(out.error, /categories 0 to 5 only, not 7\. Government clouds \(6 to 8\) are not supported/);
  assert.doesNotMatch(r.stderr, /Resolving environment details for/);
});

test("bundle: a good value gets past argument parsing (stops at the missing --workspace)", () => {
  const r = runBundle(["--cluster-category", "4"]);
  assert.equal(r.status, 1, r.stderr);
  assert.match(JSON.parse(r.stdout.trim()).error, /--workspace is required/);
});

fs.rmSync(home, { recursive: true, force: true });

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
