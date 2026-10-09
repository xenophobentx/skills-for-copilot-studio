/**
 * Tests for the sign-in flow selection and the browser sign-in timeout in
 * scripts/src/shared-auth.js: resolveAuthMode picks device code or the browser
 * from the environment, withSignInTimeout stops waiting for a browser that
 * never finishes, and acquireTokenSignIn / getOrAcquireToken really take the
 * flow that was picked.
 *
 * Needs no npm packages: @azure/msal-node and ./msal-cache are replaced by stubs while the module
 * loads, so nothing here reads or writes a token cache or the OS credential store.
 *
 * Run: node tests/shared-auth-mode.test.js
 */

const assert = require("node:assert/strict");
const path = require("node:path");

// A fake MSAL app that records which sign-in flow was used.
const calls = [];
let deviceError = null;
class FakePublicClientApplication {
  getTokenCache() {
    return { getAllAccounts: async () => [] };
  }
  async acquireTokenByDeviceCode(request) {
    calls.push("device");
    request.deviceCodeCallback({ message: "enter the code", userCode: "CODE", verificationUri: "https://example.invalid/device", expiresIn: 900 });
    if (deviceError) throw deviceError;
    return { accessToken: "x", scopes: request.scopes };
  }
  async acquireTokenInteractive(request) {
    calls.push("interactive");
    if (process.env.FAKE_INTERACTIVE_HANGS) return new Promise(() => {});
    return { accessToken: "x", scopes: request.scopes };
  }
}

const Module = require("node:module");
const load = Module._load;
Module._load = function (request, ...rest) {
  if (request === "@azure/msal-node") return { PublicClientApplication: FakePublicClientApplication };
  if (request === "./msal-cache") return { createCachePlugin: async () => ({}) };
  return load.call(this, request, ...rest);
};

// die() normally prints JSON and exits; here it throws so a test can read the message
const utils = require(path.join(__dirname, "..", "scripts", "src", "shared-utils.js"));
utils.die = (msg) => {
  throw new Error(msg);
};
utils.log = () => {};

const {
  resolveAuthMode, setAuthModeOverride, interactiveTimeoutMs, withSignInTimeout,
  acquireTokenSignIn, getOrAcquireToken,
} = require(path.join(__dirname, "..", "scripts", "src", "shared-auth.js"));

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

  await test("--auth-mode sets CPS_AUTH_MODE and wins over the existing value", () => {
    const env = { CPS_AUTH_MODE: "interactive" };
    setAuthModeOverride("device", env);
    assert.equal(env.CPS_AUTH_MODE, "device");
    assert.equal(mode(env, "darwin"), "device");
  });
  await test("--auth-mode rejects an unknown or missing value", () => {
    assert.throws(() => setAuthModeOverride("magic", {}), /Unknown auth mode "magic"/);
    assert.throws(() => setAuthModeOverride(undefined, {}), /needs a value/);
  });
  await test("CPS_AUTH_MODE=device wins on a desktop", () => {
    assert.equal(mode({ CPS_AUTH_MODE: "device" }, "darwin"), "device");
    assert.equal(mode({ CPS_AUTH_MODE: "DEVICE-CODE" }, "win32"), "device");
  });
  await test("CPS_AUTH_MODE=interactive wins over SSH and a missing display", () => {
    assert.equal(mode({ CPS_AUTH_MODE: "interactive", SSH_CONNECTION: "x" }, "linux"), "interactive");
  });
  await test("an unknown CPS_AUTH_MODE is an error", () => {
    assert.throws(() => resolveAuthMode({ CPS_AUTH_MODE: "magic" }, "linux"), /Unknown auth mode "magic"/);
  });

  // -------------------------------------------------------------------------
  // Timeout
  // -------------------------------------------------------------------------

  await test("the default browser wait is 5 minutes", () => {
    assert.equal(interactiveTimeoutMs({}), 300000);
    assert.equal(interactiveTimeoutMs({ CPS_AUTH_TIMEOUT_SECONDS: "" }), 300000);
  });
  await test("CPS_AUTH_TIMEOUT_SECONDS overrides the wait within 1 to 3600 seconds", () => {
    assert.equal(interactiveTimeoutMs({ CPS_AUTH_TIMEOUT_SECONDS: "20" }), 20000);
    assert.equal(interactiveTimeoutMs({ CPS_AUTH_TIMEOUT_SECONDS: "1" }), 1000);
    assert.equal(interactiveTimeoutMs({ CPS_AUTH_TIMEOUT_SECONDS: "3600" }), 3600000);
  });
  await test("a bad CPS_AUTH_TIMEOUT_SECONDS is an error, not an instant timeout", () => {
    for (const bad of ["abc", "0", "-5", "Infinity", "NaN", "3601", "99999999"]) {
      assert.throws(() => interactiveTimeoutMs({ CPS_AUTH_TIMEOUT_SECONDS: bad }), /between 1 and 3600/, bad);
    }
  });
  await test("a sign-in that never finishes fails with a message that says to run again", async () => {
    const never = new Promise(() => {});
    await assert.rejects(withSignInTimeout(never, 30), (e) => {
      assert.match(e.message, /did not finish within \d+ seconds/);
      assert.match(e.message, /Run the command again/);
      assert.match(e.message, /--auth-mode device/);
      assert.doesNotMatch(e.message, /printed URL/);
      return true;
    });
  });
  await test("a sign-in that finishes in time returns its result", async () => {
    assert.equal(await withSignInTimeout(Promise.resolve("token"), 1000), "token");
  });
  await test("a sign-in that fails in time keeps its own error", async () => {
    await assert.rejects(withSignInTimeout(Promise.reject(new Error("AADSTS50020")), 1000), /AADSTS50020/);
  });

  // -------------------------------------------------------------------------
  // The flow that was picked is the flow that runs (fake MSAL app)
  // -------------------------------------------------------------------------

  const quietStdout = async (fn) => {
    const write = process.stdout.write;
    const written = [];
    process.stdout.write = (chunk) => (written.push(String(chunk)), true);
    try {
      return { result: await fn(), written };
    } finally {
      process.stdout.write = write;
    }
  };
  const withEnv = async (vars, fn) => {
    const saved = {};
    for (const k of Object.keys(vars)) saved[k] = process.env[k];
    Object.assign(process.env, vars);
    calls.length = 0;
    try {
      return await fn();
    } finally {
      for (const k of Object.keys(vars)) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
      deviceError = null;
    }
  };
  const scopes = ["https://example.invalid/.default"];

  await test("mode device runs the device code flow and prints the device_code line", async () => {
    await withEnv({ CPS_AUTH_MODE: "device" }, async () => {
      const { written } = await quietStdout(() => acquireTokenSignIn("tenant", "client", scopes, "slot-a"));
      assert.deepEqual(calls, ["device"]);
      const line = JSON.parse(written.join("").trim().split("\n")[0]);
      assert.equal(line.status, "device_code");
      assert.equal(line.userCode, "CODE");
    });
  });
  await test("mode interactive runs the browser flow", async () => {
    await withEnv({ CPS_AUTH_MODE: "interactive" }, async () => {
      await acquireTokenSignIn("tenant", "client", scopes, "slot-b");
      assert.deepEqual(calls, ["interactive"]);
    });
  });
  await test("getOrAcquireToken without a cached token follows the picked mode", async () => {
    await withEnv({ CPS_AUTH_MODE: "device" }, async () => {
      await quietStdout(() => getOrAcquireToken("tenant", "client", scopes, "label", "slot-c"));
      assert.deepEqual(calls, ["device"]);
    });
    await withEnv({ CPS_AUTH_MODE: "interactive" }, async () => {
      await getOrAcquireToken("tenant", "client", scopes, "label", "slot-d");
      assert.deepEqual(calls, ["interactive"]);
    });
  });
  await test("SSH_CONNECTION without an override takes the device code flow", async () => {
    await withEnv({ CPS_AUTH_MODE: "", SSH_CONNECTION: "1.2.3.4 5 6.7.8.9 22" }, async () => {
      await quietStdout(() => acquireTokenSignIn("tenant", "client", scopes, "slot-e"));
      assert.deepEqual(calls, ["device"]);
    });
  });
  await test("the browser flow times out with the new message", async () => {
    await withEnv({ CPS_AUTH_MODE: "interactive", CPS_AUTH_TIMEOUT_SECONDS: "1", FAKE_INTERACTIVE_HANGS: "1" }, async () => {
      await assert.rejects(acquireTokenSignIn("tenant", "client", scopes, "slot-f"), /did not finish within 1 seconds/);
    });
  });
  await test("a bad CPS_AUTH_TIMEOUT_SECONDS fails before the browser flow starts", async () => {
    await withEnv({ CPS_AUTH_MODE: "interactive", CPS_AUTH_TIMEOUT_SECONDS: "Infinity" }, async () => {
      await assert.rejects(acquireTokenSignIn("tenant", "client", scopes, "slot-h"), /between 1 and 3600/);
      assert.deepEqual(calls, []);
    });
  });
  await test("a Conditional Access block on device code points to --auth-mode interactive", async () => {
    await withEnv({ CPS_AUTH_MODE: "device" }, async () => {
      deviceError = new Error("AADSTS53003: Access has been blocked by Conditional Access policies.");
      await quietStdout(async () => {
        await assert.rejects(acquireTokenSignIn("tenant", "client", scopes, "slot-g"), /--auth-mode interactive/);
      });
    });
  });

  console.log(`${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})();
