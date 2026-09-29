/**
 * msal-cache.js — Shared MSAL cache plugin using OS-native secure storage.
 *
 * Uses @azure/msal-node-extensions to persist MSAL's token cache via the
 * platform's credential manager (Keychain on macOS, DPAPI on Windows,
 * libsecret on Linux).
 *
 * The cache file lives at ~/.copilot-studio-cli/<account>.cache.json.
 */

const path = require("path");
const os = require("os");

/**
 * msal-node-extensions requires keytar at load time on every platform, but only
 * calls it on macOS and Linux — Windows uses DPAPI. If the native binding is
 * missing after install (reported on win32-arm64), on Windows we register a
 * stub in its place instead of crashing. Any keytar load failure is tolerated
 * there, since nothing on Windows calls it.
 */
function stubMissingKeytarOnWindows() {
  if (process.platform !== "win32") return;
  let keytarPath;
  try {
    const extDir = path.dirname(require.resolve("@azure/msal-node-extensions/package.json"));
    keytarPath = require.resolve("keytar", { paths: [extDir] });
    require(keytarPath);
    return; // native binding loads fine
  } catch {
    if (!keytarPath) return; // keytar not installed at all — let the real error surface
  }
  const unavailable = () => Promise.reject(new Error("keytar native binding is not available on this platform"));
  const Module = require("module");
  const stub = new Module(keytarPath);
  stub.filename = keytarPath;
  stub.loaded = true;
  stub.exports = {
    getPassword: unavailable,
    setPassword: unavailable,
    deletePassword: unavailable,
    findPassword: unavailable,
    findCredentials: unavailable,
  };
  require.cache[keytarPath] = stub;
}

stubMissingKeytarOnWindows();
const { PersistenceCreator, PersistenceCachePlugin, DataProtectionScope } = require("@azure/msal-node-extensions");

const CACHE_DIR = path.join(os.homedir(), ".copilot-studio-cli");
const SERVICE_NAME = "copilot-studio-cli";

async function createCachePlugin(accountName) {
  const cachePath = path.join(CACHE_DIR, `${accountName}.cache.json`);
  const persistence = await PersistenceCreator.createPersistence({
    cachePath,
    dataProtectionScope: DataProtectionScope.CurrentUser,
    serviceName: SERVICE_NAME,
    accountName,
    usePlaintextFileOnLinux: true,
  });
  return new PersistenceCachePlugin(persistence);
}

module.exports = { createCachePlugin };
