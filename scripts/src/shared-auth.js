/**
 * shared-auth.js — Shared MSAL authentication for Copilot Studio CLI scripts.
 *
 * Provides token acquisition (silent, interactive browser, device code) using the
 * VS Code first-party client ID. Tokens are cached via OS-native credential storage
 * in the "manage-agent" MSAL cache slot by default.
 *
 * When no cached token exists, acquireTokenSignIn picks the sign-in flow: the browser
 * flow on a machine with a browser, the device code flow over SSH or without a display.
 * CPS_AUTH_MODE=device|interactive overrides that (the scripts also take --auth-mode, which
 * sets the same variable), and CPS_AUTH_TIMEOUT_SECONDS changes how long the browser flow
 * waits (default 300, at most 3600).
 *
 * An optional cacheSlot parameter allows scripts to use a different cache slot
 * (e.g., "chat" for the SDK chat path) without polluting the default singleton.
 */

const { log, die } = require("./shared-utils");
// msal-cache loads the native modules (keytar, msal-node-extensions) when it is
// required. Load it on first use, so `manage-agent doctor` still runs without them.
const createCachePlugin = (...args) => require("./msal-cache").createCachePlugin(...args);

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// VS Code's first-party client ID — pre-authorized with the Island API gateway
// and Dataverse. No separate app registration needed.
const VSCODE_CLIENT_ID = "51f81489-12ee-4a9e-aaae-a2591f45987d";

// Island API resource IDs by cluster category (from the VS Code extension).
const ISLAND_RESOURCE_IDS = {
  0: "a522f059-bb65-47c0-8934-7db6e5286414",
  1: "a522f059-bb65-47c0-8934-7db6e5286414",
  2: "a522f059-bb65-47c0-8934-7db6e5286414",
  3: "a522f059-bb65-47c0-8934-7db6e5286414",
  4: "96ff4394-9197-43aa-b393-6a41652e21f8",
  5: "96ff4394-9197-43aa-b393-6a41652e21f8",
  6: "9315aedd-209b-43b3-b149-2abff6a95d59",
  7: "69c6e40c-465f-4154-987d-da5cba10734e",
  8: "bd4a9f18-e349-4c74-a6b7-65dd465ea9ab",
};

function getIslandResourceId(clusterCategory) {
  const id = ISLAND_RESOURCE_IDS[clusterCategory];
  if (!id) throw new Error(`Unknown cluster category: ${clusterCategory}`);
  return id;
}

// Cluster category used when nothing says otherwise: Prod.
const DEFAULT_CLUSTER_CATEGORY = 5;

// The Copilot Studio web hosts the extension knows. The part between
// "copilotstudio." and ".microsoft.com" picks the cluster category: preview 4,
// preprod 3, test 2, anything else (the plain host) 5. Same table as the VS Code
// extension 1.9.14 uses when it reads an agent URL.
const COPILOT_STUDIO_HOST_RE = /^copilotstudio(?:\.(preview|preprod|test))?\.microsoft\.com$/i;
const CLUSTER_CATEGORY_BY_REALM = { preview: 4, preprod: 3, test: 2 };

/**
 * Check a --cluster-category value. Accepts only the plain digits of a category
 * in ISLAND_RESOURCE_IDS; throws an Error with a message for the user otherwise.
 */
function parseClusterCategory(value) {
  const text = value == null ? "" : String(value).trim();
  if (Object.prototype.hasOwnProperty.call(ISLAND_RESOURCE_IDS, text)) return Number(text);
  const known = Object.keys(ISLAND_RESOURCE_IDS).join(", ");
  throw new Error(
    `Invalid --cluster-category ${value == null ? "(missing value)" : JSON.stringify(String(value))}. ` +
      `Use one of ${known}. 5 is Prod and the default, 4 preview, 3 preprod, 2 test.`
  );
}

// BAP host that knows the environments of a cluster category, as the VS Code
// extension 1.9.14 picks it (test and preprod have their own hosts). The token
// scope is the same for all of them. Categories 6 to 8 are government clouds;
// their hosts also need another sign-in authority, which this plugin does not have.
const BAP_HOST_BY_CLUSTER = {
  0: "test.api.bap.microsoft.com",
  1: "test.api.bap.microsoft.com",
  2: "test.api.bap.microsoft.com",
  3: "preprod.api.bap.microsoft.com",
  4: "api.bap.microsoft.com",
  5: "api.bap.microsoft.com",
};

function getBapHost(clusterCategory) {
  const host = BAP_HOST_BY_CLUSTER[clusterCategory];
  if (!host) {
    throw new Error(
      `The environment lookup works for cluster categories 0 to 5 only, not ${clusterCategory}. ` +
        "Pass --environment-url and --agent-mgmt-url so no lookup is needed."
    );
  }
  return host;
}

/**
 * Pick the cluster category. Order: the --cluster-category option, then the value
 * stored in .mcs/conn.json, then the --url host, then Prod.
 * Returns { category, source, urlCategory, conflict }; source is "option", "stored",
 * "url" or "default", and conflict is true when the URL host implies another
 * category than the one chosen.
 */
function resolveClusterCategory({ option, stored, url } = {}) {
  const urlCategory = url ? clusterCategoryFromUrl(url) : null;
  let category, source;
  if (option != null) {
    category = option;
    source = "option";
  } else if (stored != null) {
    category = stored;
    source = "stored";
  } else if (urlCategory != null) {
    category = urlCategory;
    source = "url";
  } else {
    category = DEFAULT_CLUSTER_CATEGORY;
    source = "default";
  }
  return { category, source, urlCategory, conflict: urlCategory != null && urlCategory !== category };
}

/**
 * Cluster category implied by a Copilot Studio web URL, or null when the URL is
 * not one (no URL, not parseable, other host).
 */
function clusterCategoryFromUrl(url) {
  let host;
  try {
    host = new URL(url).hostname;
  } catch {
    return null;
  }
  const m = COPILOT_STUDIO_HOST_RE.exec(host);
  if (!m) return null;
  const realm = m[1] ? m[1].toLowerCase() : null;
  return realm ? CLUSTER_CATEGORY_BY_REALM[realm] : DEFAULT_CLUSTER_CATEGORY;
}

// ---------------------------------------------------------------------------
// MSAL app singleton — one instance per (tenantId, clientId) pair.
// Sharing the instance ensures all token acquisitions see the same
// in-memory cache, avoiding stale-cache issues across scopes.
// ---------------------------------------------------------------------------

let _cachePlugin = null;
const _msalApps = new Map();

async function getDefaultCachePlugin() {
  if (!_cachePlugin) {
    _cachePlugin = await createCachePlugin("manage-agent");
  }
  return _cachePlugin;
}

/**
 * Create or retrieve a cached MSAL PublicClientApplication.
 *
 * @param {string} tenantId - Azure AD tenant ID
 * @param {string} clientId - Application (client) ID
 * @param {string} [cacheSlot] - Optional cache slot name. When omitted, uses the
 *   default "manage-agent" singleton. When provided (e.g., "chat"), creates a
 *   separate non-singleton MSAL app with its own cache.
 */
async function createMsalApp(tenantId, clientId, cacheSlot) {
  const msal = require("@azure/msal-node");

  if (cacheSlot) {
    // Non-default slot: create a standalone app (not cached in the singleton map)
    const plugin = await createCachePlugin(cacheSlot);
    return new msal.PublicClientApplication({
      auth: {
        clientId,
        authority: `https://login.microsoftonline.com/${tenantId}`,
      },
      cache: { cachePlugin: plugin },
    });
  }

  // Default path — singleton keyed by tenantId:clientId
  const key = `${tenantId}:${clientId}`;
  if (_msalApps.has(key)) return _msalApps.get(key);

  const cachePlugin = await getDefaultCachePlugin();
  const app = new msal.PublicClientApplication({
    auth: {
      clientId,
      authority: `https://login.microsoftonline.com/${tenantId}`,
    },
    cache: { cachePlugin },
  });
  _msalApps.set(key, app);
  return app;
}

// ---------------------------------------------------------------------------
// Token result normalization
// ---------------------------------------------------------------------------

function buildTokenInfo(result) {
  return {
    accessToken: result.accessToken,
    expiresOn: result.expiresOn
      ? result.expiresOn.toISOString()
      : new Date(Date.now() + 3600 * 1000).toISOString(),
    scopes: result.scopes,
    account: result.account
      ? {
          homeAccountId: result.account.homeAccountId,
          environment: result.account.environment,
          tenantId: result.account.tenantId,
          username: result.account.username,
        }
      : undefined,
  };
}

// ---------------------------------------------------------------------------
// Token acquisition flows
// ---------------------------------------------------------------------------

async function acquireTokenDeviceCode(tenantId, clientId, scopes, cacheSlot) {
  const app = await createMsalApp(tenantId, clientId, cacheSlot);

  const result = await app.acquireTokenByDeviceCode({
    scopes,
    deviceCodeCallback: (response) => {
      log("");
      log(`  ${response.message}`);
      log("");
      // Also emit structured JSON so skills/Claude can parse it
      process.stdout.write(
        JSON.stringify({
          status: "device_code",
          userCode: response.userCode,
          verificationUri: response.verificationUri,
          message: response.message,
          expiresIn: response.expiresIn,
        }) + "\n"
      );
    },
  });

  if (!result) throw new Error("Device code flow returned no result");
  return buildTokenInfo(result);
}

const INTERACTIVE_TIMEOUT_SECONDS = 300;
const MAX_INTERACTIVE_TIMEOUT_SECONDS = 3600;

// Decide how to sign in when there is no cached token. Returns { mode, reason } with
// mode "device" or "interactive". env and platform are parameters so tests can inject them.
function resolveAuthMode(env = process.env, platform = process.platform) {
  const requested = String(env.CPS_AUTH_MODE || "").trim().toLowerCase();
  if (requested === "device" || requested === "device-code") {
    return { mode: "device", reason: "--auth-mode or CPS_AUTH_MODE asks for it" };
  }
  if (requested === "interactive") {
    return { mode: "interactive", reason: "--auth-mode or CPS_AUTH_MODE asks for it" };
  }
  if (requested && requested !== "auto") {
    throw new Error(`Unknown auth mode "${env.CPS_AUTH_MODE}". Use "device" or "interactive" (--auth-mode or CPS_AUTH_MODE).`);
  }
  if (env.SSH_CONNECTION || env.SSH_TTY) {
    return { mode: "device", reason: "this is an SSH session" };
  }
  if (platform === "linux" && !env.DISPLAY && !env.WAYLAND_DISPLAY) {
    return { mode: "device", reason: "there is no display (DISPLAY and WAYLAND_DISPLAY are not set)" };
  }
  return { mode: "interactive", reason: null };
}

// Called by the scripts for --auth-mode. The flag wins over an existing CPS_AUTH_MODE.
function setAuthModeOverride(value, env = process.env) {
  if (value === undefined || value === "") die("--auth-mode needs a value: device or interactive.");
  try {
    resolveAuthMode({ CPS_AUTH_MODE: value }, "linux");
  } catch (e) {
    die(e.message);
  }
  env.CPS_AUTH_MODE = value;
}

function interactiveTimeoutMs(env = process.env) {
  const raw = String(env.CPS_AUTH_TIMEOUT_SECONDS ?? "").trim();
  if (!raw) return INTERACTIVE_TIMEOUT_SECONDS * 1000;
  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || seconds < 1 || seconds > MAX_INTERACTIVE_TIMEOUT_SECONDS) {
    throw new Error(
      `CPS_AUTH_TIMEOUT_SECONDS must be a number of seconds between 1 and ${MAX_INTERACTIVE_TIMEOUT_SECONDS}, got "${raw}".`
    );
  }
  return seconds * 1000;
}

// msal-node does not notice a closed browser tab, so the wait needs its own limit. Its
// loopback server stays open after the limit, so the caller is expected to exit.
function withSignInTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(
        `Browser sign-in did not finish within ${Math.round(ms / 1000)} seconds. ` +
        "Run the command again and pick the right account. " +
        "If this machine has no usable browser, run it with --auth-mode device (or CPS_AUTH_MODE=device) to sign in with a device code."
      ));
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function acquireTokenInteractive(tenantId, clientId, scopes, cacheSlot) {
  const app = await createMsalApp(tenantId, clientId, cacheSlot);
  const timeoutMs = interactiveTimeoutMs(); // before the browser opens, so a bad value fails early

  const result = await withSignInTimeout(
    app.acquireTokenInteractive({
      scopes,
      openBrowser: async (url) => {
        log("");
        log(`  Open this URL to sign in: ${url}`);
        log("");
        const open = (await import("open")).default;
        await open(url);
      },
      successTemplate:
        "<html><body><h1>Login successful. You can close this tab.</h1></body></html>",
    }),
    timeoutMs
  );

  if (!result) throw new Error("Interactive flow returned no result");
  return buildTokenInfo(result);
}

/**
 * Sign in with the flow that suits this machine (see resolveAuthMode).
 */
async function acquireTokenSignIn(tenantId, clientId, scopes, cacheSlot) {
  const { mode, reason } = resolveAuthMode();
  if (mode === "device") {
    log(`Signing in with a device code (${reason}).`);
    try {
      return await acquireTokenDeviceCode(tenantId, clientId, scopes, cacheSlot);
    } catch (e) {
      if (/AADSTS(53003|530036)\b/.test(e.message)) {
        e.message += " Your tenant may block device code sign-in. On a machine with a browser, run again with --auth-mode interactive.";
      }
      throw e;
    }
  }
  log("Signing in with the browser...");
  return acquireTokenInteractive(tenantId, clientId, scopes, cacheSlot);
}

async function acquireTokenSilent(tenantId, clientId, scopes, cacheSlot) {
  const app = await createMsalApp(tenantId, clientId, cacheSlot);
  const allAccounts = await app.getTokenCache().getAllAccounts();
  // Filter to accounts matching this tenant to avoid cross-tenant errors
  const accounts = allAccounts.filter(a => a.tenantId === tenantId);
  if (accounts.length > 0) {
    try {
      const result = await app.acquireTokenSilent({
        scopes,
        account: accounts[0],
      });
      if (result) {
        const scopeKey = scopes[0];
        log(`${scopeKey}: silently refreshed (expires ${result.expiresOn?.toISOString()})`);
        return buildTokenInfo(result);
      }
    } catch (e) {
      log(`Silent refresh failed: ${e.message}`);
    }
  }
  return null;
}

/**
 * Get a token silently, falling back to a sign-in (browser or device code).
 */
async function getOrAcquireToken(tenantId, clientId, scopes, label, cacheSlot) {
  const silent = await acquireTokenSilent(tenantId, clientId, scopes, cacheSlot);
  if (silent) {
    log(`${label}: using cached token (expires ${silent.expiresOn})`);
    return silent;
  }
  log(`${label}: no cached token, signing in...`);
  return acquireTokenSignIn(tenantId, clientId, scopes, cacheSlot);
}

/**
 * Get a token for the Island API gateway using VSCODE_CLIENT_ID.
 */
async function getOrAcquireIslandToken(tenantId, clusterCategory, label) {
  const resourceId = getIslandResourceId(clusterCategory);
  return getOrAcquireToken(
    tenantId, VSCODE_CLIENT_ID,
    [`api://${resourceId}/.default`],
    label
  );
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  VSCODE_CLIENT_ID,
  ISLAND_RESOURCE_IDS,
  getIslandResourceId,
  DEFAULT_CLUSTER_CATEGORY,
  COPILOT_STUDIO_HOST_RE,
  parseClusterCategory,
  clusterCategoryFromUrl,
  getBapHost,
  resolveClusterCategory,
  createMsalApp,
  buildTokenInfo,
  acquireTokenDeviceCode,
  acquireTokenInteractive,
  acquireTokenSignIn,
  resolveAuthMode,
  setAuthModeOverride,
  interactiveTimeoutMs,
  withSignInTimeout,
  acquireTokenSilent,
  getOrAcquireToken,
  getOrAcquireIslandToken,
};
