/**
 * Tests for the sign-in flow selection and the browser sign-in timeout in
 * scripts/src/shared-auth.js: resolveAuthMode picks device code or the browser
 * from the environment, and withSignInTimeout stops waiting for a browser that
 * never finishes.
 *
 * Needs no npm packages: @azure/msal-node-extensions is replaced by an empty stub while the module
 * loads, and nothing here reads or writes a token cache.
 *
 * Run: node tests/shared-auth-mode.test.js
 */

const assert = require("node:assert/strict");
const path = require("node:path");

// Make require("@azure/msal-node-extensions") resolve to an empty object (loaded by msal-cache.js).
const Module = require("node:module");
const load = Module._load;
Module._load = function (request, ...rest) {
  if (request === "@azure/msal-node-extensions") return {};
  return load.call(this, request, ...rest);
};

const { resolveAuthMode, interactiveTimeoutMs, withSignInTimeout } = require(
  path.join(__dirname, "..", "scripts", "src", "shared-auth.js")
);

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed++;
  } catch (e) {
    failed++;
    console.error(`FAIL: ${name}\n  ${e.message}`);
  }
}

const mode = (env, platform) => resolveAuthMode(env, platform).mode;

(async () => {
  // -------------------------------------------------------------------------
  // Automatic selection
  // -------------------------------------------------------------------------

  await test("macOS desktop uses the browser", () => {
    assert.equal(mode({}, "darwin"), "interactive");
  });
  await test("Windows desktop uses the browser", () => {
    assert.equal(mode({}, "win32"), "interactive");
  });
  await test("Linux with DISPLAY uses the browser", () => {
    assert.equal(mode({ DISPLAY: ":0" }, "linux"), "interactive");
  });
  await test("Linux with WAYLAND_DISPLAY uses the browser", () => {
    assert.equal(mode({ WAYLAND_DISPLAY: "wayland-0" }, "linux"), "interactive");
  });
  await test("Linux without a display uses device code", () => {
    const r = resolveAuthMode({}, "linux");
    assert.equal(r.mode, "device");
    assert.match(r.reason, /no display/);
  });
  await test("SSH_CONNECTION uses device code on every platform", () => {
    for (const platform of ["darwin", "win32", "linux"]) {
      assert.equal(mode({ SSH_CONNECTION: "1.2.3.4 5 6.7.8.9 22", DISPLAY: ":0" }, platform), "device", platform);
    }
  });
  await test("SSH_TTY uses device code", () => {
    assert.equal(mode({ SSH_TTY: "/dev/pts/0" }, "darwin"), "device");
  });
  await test("an empty CPS_AUTH_MODE or auto means automatic selection", () => {
    assert.equal(mode({ CPS_AUTH_MODE: "" }, "darwin"), "interactive");
    assert.equal(mode({ CPS_AUTH_MODE: "auto" }, "linux"), "device");
  });

  // -------------------------------------------------------------------------
  // CPS_AUTH_MODE override
  // -------------------------------------------------------------------------

  await test("CPS_AUTH_MODE=device wins on a desktop", () => {
    assert.equal(mode({ CPS_AUTH_MODE: "device" }, "darwin"), "device");
    assert.equal(mode({ CPS_AUTH_MODE: "DEVICE-CODE" }, "win32"), "device");
  });
  await test("CPS_AUTH_MODE=interactive wins over SSH and a missing display", () => {
    assert.equal(mode({ CPS_AUTH_MODE: "interactive", SSH_CONNECTION: "x" }, "linux"), "interactive");
  });
  await test("an unknown CPS_AUTH_MODE is an error", () => {
    assert.throws(() => resolveAuthMode({ CPS_AUTH_MODE: "magic" }, "linux"), /Unknown CPS_AUTH_MODE "magic"/);
  });

  // -------------------------------------------------------------------------
  // Timeout
  // -------------------------------------------------------------------------

  await test("the default browser wait is 5 minutes", () => {
    assert.equal(interactiveTimeoutMs({}), 300000);
  });
  await test("CPS_AUTH_TIMEOUT_SECONDS overrides the wait, bad values fall back", () => {
    assert.equal(interactiveTimeoutMs({ CPS_AUTH_TIMEOUT_SECONDS: "20" }), 20000);
    assert.equal(interactiveTimeoutMs({ CPS_AUTH_TIMEOUT_SECONDS: "abc" }), 300000);
    assert.equal(interactiveTimeoutMs({ CPS_AUTH_TIMEOUT_SECONDS: "0" }), 300000);
  });
  await test("a sign-in that never finishes fails with a message that names device code", async () => {
    const never = new Promise(() => {});
    await assert.rejects(withSignInTimeout(never, 30), (e) => {
      assert.match(e.message, /did not finish within \d+ seconds/);
      assert.match(e.message, /CPS_AUTH_MODE=device/);
      return true;
    });
  });
  await test("a sign-in that finishes in time returns its result", async () => {
    assert.equal(await withSignInTimeout(Promise.resolve("token"), 1000), "token");
  });
  await test("a sign-in that fails in time keeps its own error", async () => {
    await assert.rejects(withSignInTimeout(Promise.reject(new Error("AADSTS50020")), 1000), /AADSTS50020/);
  });

  console.log(`${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})();
