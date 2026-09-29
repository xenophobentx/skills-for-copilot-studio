/**
 * msal-cache.js — Shared MSAL cache plugin using OS-native secure storage.
 *
 * Uses @azure/msal-node-extensions to persist MSAL's token cache via the
 * platform's credential manager (Keychain on macOS, DPAPI on Windows,
 * libsecret on Linux).
 *
 * The cache file lives at ~/.copilot-studio-cli/<account>.cache.json.
 */

const { PersistenceCreator, PersistenceCachePlugin, DataProtectionScope } = require("@azure/msal-node-extensions");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const os = require("os");

const CACHE_DIR = path.join(os.homedir(), ".copilot-studio-cli");
const SERVICE_NAME = "copilot-studio-cli";

const LOCK_STALE_MS = 30000;
const LOCK_WAIT_MS = 10000;
const LOCK_POLL_MS = 50;

// "No secret-service/D-Bus session at all" failures on Linux, which a later attempt cannot fix.
const LINUX_SECRET_SERVICE_UNAVAILABLE_PATTERNS = [
  /org\.freedesktop\.secrets was not provided/i,
  /cannot autolaunch d-bus/i,
  /no such interface[\s\S]*secret/i,
];

function isSecretServiceUnavailableError(e) {
  const message = e && e.message ? String(e.message) : "";
  return LINUX_SECRET_SERVICE_UNAVAILABLE_PATTERNS.some((re) => re.test(message));
}

// A CachePersistenceError wraps the text of the underlying error, so messages are matched. Only
// failures caused by processes racing on the shared validation entry look transient: file races
// (ENOENT/EPERM/EBUSY/EACCES, mostly Windows), the entry deleted between save and load, and the
// same race in the macOS keychain (item already exists / gone). Anything else is not retried,
// notably a denied or cancelled Keychain prompt, which a retry would only show again.
const TRANSIENT_PERSISTENCE_ERROR_PATTERNS = [
  /\b(?:ENOENT|EPERM|EBUSY|EACCES)\b/,
  /could not be read/i,
  /is different\s+from data read/i,
  /already exists in the keychain/i,
  /could not be found in the keychain/i,
  /may have been deleted from the keychain/i,
];

function isTransientPersistenceError(e) {
  const message = e && e.message ? String(e.message) : "";
  return TRANSIENT_PERSISTENCE_ERROR_PATTERNS.some((re) => re.test(message));
}

// True only when `pid` names a process that is definitely gone (ESRCH from `kill(pid, 0)`).
// EPERM means the process exists but we can't signal it (different user); that holder is alive
// as far as we know, so it must not be treated as dead.
function isPidDead(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return false;
  } catch (e) {
    return e.code === "ESRCH";
  }
}

// Puts a lock we renamed away by mistake back at `lockPath`, never replacing one created since.
// A hard link keeps the original file; where hard links are unsupported (some SMB/FAT home
// directories) the lock is recreated exclusively with the same contents instead.
function restoreStolenLock(takeoverPath, lockPath, contents) {
  try {
    fs.linkSync(takeoverPath, lockPath);
  } catch (linkErr) {
    if (linkErr.code === "EEXIST") return;
    try {
      fs.writeFileSync(lockPath, contents, { flag: "wx", mode: 0o600 });
    } catch {
      // someone else holds the slot now, or it cannot be written; the caller retries
    }
  }
}

/**
 * Runs `fn` while holding an exclusive cross-process lock file, so only one process at a time runs
 * PersistenceCreator.createPersistence(): its check writes, reads and deletes a validation entry
 * shared by every process, so concurrent runs race each other even with retries.
 *
 * The lock file holds `pid:random`, and release only removes a lock we still own. A lock whose
 * holder is dead, or that is older than `staleMs`, is taken over by renaming it away first, so only
 * one contender clears the slot. Waiting is bounded by `waitMs`; after that, or if the lock cannot
 * be attempted at all (for example a read-only directory), `fn` runs unlocked and `warn` is told.
 *
 * @param {string} lockPath
 * @param {() => Promise<T>} fn
 */
async function withPersistenceLock(
  lockPath,
  fn,
  {
    waitMs = LOCK_WAIT_MS,
    staleMs = LOCK_STALE_MS,
    pollMs = LOCK_POLL_MS,
    platform = process.platform,
    warn,
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  } = {}
) {
  const deadline = Date.now() + waitMs;
  const token = `${process.pid}:${crypto.randomBytes(8).toString("hex")}`;
  // EEXIST means the lock is held only when it comes from opening the lock file (mkdirSync can
  // also throw it when a file sits at the cache-dir path). On win32 an in-use lock can surface as
  // EBUSY, or as EPERM/EACCES, which count only once the lock file is confirmed to be there.
  const isContention = (e) => {
    if (e.code === "EEXIST") return e.syscall === "open";
    if (platform === "win32" && e.code === "EBUSY") return true;
    if (platform === "win32" && (e.code === "EPERM" || e.code === "EACCES")) {
      try {
        fs.statSync(lockPath);
        return true;
      } catch (statErr) {
        return statErr.code === "EPERM";
      }
    }
    return false;
  };

  let fd;
  let holdingLock = false;
  for (;;) {
    try {
      fs.mkdirSync(path.dirname(lockPath), { recursive: true, mode: 0o700 });
      fd = fs.openSync(lockPath, "wx", 0o600);
      try {
        fs.writeSync(fd, token);
      } catch (writeErr) {
        try {
          fs.closeSync(fd);
        } catch {
          // already closed
        }
        fd = undefined;
        try {
          // Don't leave an empty lock behind for the others to wait on.
          fs.unlinkSync(lockPath);
        } catch {
          // already gone
        }
        throw writeErr;
      }
      holdingLock = true;
      break;
    } catch (e) {
      if (!isContention(e)) {
        // Not lock contention (e.g. a read-only cache dir): report it and run unlocked instead of
        // failing createCachePlugin because of the lock.
        if (typeof warn === "function") {
          warn(
            `Could not acquire the persistence lock at ${lockPath} (${
              e.code || e.message
            }); continuing without it.`
          );
        }
        fd = undefined;
        break;
      }
      try {
        const lockContents = fs.readFileSync(lockPath, "utf-8");
        const holderPid = Number((/^(\d+):/.exec(lockContents) || [])[1]);
        // A dead holder is stale right away: no heartbeat is coming.
        const stale = isPidDead(holderPid) || Date.now() - fs.statSync(lockPath).mtimeMs > staleMs;
        if (stale) {
          // Only the process whose rename succeeds clears the slot. If the file we renamed away
          // is not the one we read, a live process took the lock in between and we stole its
          // fresh one, so it is put back for its owner.
          const takeoverPath = `${lockPath}.stale-${process.pid}-${crypto
            .randomBytes(4)
            .toString("hex")}`;
          try {
            fs.renameSync(lockPath, takeoverPath);
            try {
              let movedContents;
              try {
                movedContents = fs.readFileSync(takeoverPath, "utf-8");
              } catch {
                movedContents = undefined;
              }
              if (movedContents !== undefined && movedContents !== lockContents) {
                restoreStolenLock(takeoverPath, lockPath, movedContents);
              }
            } finally {
              try {
                fs.unlinkSync(takeoverPath);
              } catch {
                // already gone; harmless, the slot is still clear
              }
            }
          } catch {
            // someone else's rename won the race, or the lock is already gone; retry below
          }
        }
      } catch {
        // lock file vanished between the failed open and the read/stat; retry below
      }
    }
    if (Date.now() >= deadline) {
      fd = undefined; // give up waiting; run unlocked rather than hang
      if (typeof warn === "function") {
        warn(`Waited ${waitMs} ms for the persistence lock at ${lockPath}; continuing without it.`);
      }
      break;
    }
    await sleep(pollMs + Math.random() * pollMs);
  }
  // Refresh the lock's mtime while we hold it, so a slow check (for example a keyring prompt)
  // is not mistaken for a stale lock and taken over.
  const heartbeat = holdingLock
    ? setInterval(
        () => {
          try {
            const now = new Date();
            fs.utimesSync(lockPath, now, now);
          } catch {
            // lock gone or replaced; the token check on release handles it
          }
        },
        Math.max(50, Math.floor(staleMs / 3))
      )
    : null;
  if (heartbeat && heartbeat.unref) heartbeat.unref();
  try {
    return await fn();
  } finally {
    if (heartbeat) clearInterval(heartbeat);
    if (holdingLock && fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // already closed
      }
      try {
        // Only unlink it if it's still ours: a stale-takeover elsewhere may have replaced it.
        if (fs.readFileSync(lockPath, "utf-8") === token) fs.unlinkSync(lockPath);
      } catch {
        // already gone, or held by someone else now; leave it alone
      }
    }
  }
}

/**
 * createPersistence() checks the store by writing, reading and deleting one validation entry shared
 * by every process, so scripts that start together can fail that check although the store works.
 * A failed check (CachePersistenceError) is retried with jitter, but only when it looks transient
 * (see isTransientPersistenceError); other errors are thrown right away.
 *
 * On Linux, createPersistence() falls back to a plaintext file by itself when the check fails and
 * usePlaintextFileOnLinux is set, so the encrypted attempts run with it off and the plaintext file
 * is allowed after them (its check is retried too). An encrypted attempt that fails for a reason
 * a retry cannot fix (no secret service/D-Bus, or a non-transient error) skips the remaining
 * encrypted attempts.
 */
async function createPersistenceWithRetry(
  creator,
  options,
  {
    attempts = 4,
    plaintextAttempts = 3,
    delayMs = 100,
    platform = process.platform,
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  } = {}
) {
  const allowPlaintext = platform === "linux" && Boolean(options.usePlaintextFileOnLinux);
  const total = attempts + (allowPlaintext ? plaintextAttempts : 0);
  for (let attempt = 1; ; attempt++) {
    try {
      return await creator.createPersistence({
        ...options,
        usePlaintextFileOnLinux: allowPlaintext && attempt > attempts,
      });
    } catch (e) {
      if (!e || e.errorCode !== "CachePersistenceError" || attempt >= total) throw e;
      const transient = isTransientPersistenceError(e);
      const encryptedStageOnLinux = platform === "linux" && attempt <= attempts;
      if (encryptedStageOnLinux && (!transient || isSecretServiceUnavailableError(e))) {
        if (!allowPlaintext) throw e;
        // Retrying the encrypted store cannot help: go straight to the plaintext stage.
        attempt = attempts;
        continue;
      }
      if (!transient) throw e;
      // The delay grows within each stage and starts over at the switch to the plaintext file.
      const step = attempt >= attempts ? attempt - attempts + 1 : attempt;
      await sleep(delayMs * step + Math.random() * delayMs);
    }
  }
}

/**
 * Encrypted cache plugin via @azure/msal-node-extensions. Throws if the store fails its check
 * (after retries), as before. Messages go to stderr (`warn`), never stdout, which carries the
 * scripts' JSON output.
 *
 * @param {string} accountName
 * @param {object} [options] Test hooks: `extensions` replaces the module, `warn` the stderr
 *   logger, `cachePath`/`lockPath` relocate the files; the rest goes to the lock and the retry.
 */
async function createCachePlugin(
  accountName,
  {
    extensions,
    warn = (msg) => process.stderr.write(msg + "\n"),
    lockPath,
    cachePath,
    ...retry
  } = {}
) {
  const extensionsModule = extensions || {
    PersistenceCreator,
    PersistenceCachePlugin,
    DataProtectionScope,
    // Only needed to detect the Linux fallback below.
    FilePersistence: require("@azure/msal-node-extensions").FilePersistence,
  };

  if (!cachePath) cachePath = path.join(CACHE_DIR, `${accountName}.cache.json`);
  if (!lockPath) lockPath = path.join(path.dirname(cachePath), ".persistence.lock");
  const persistence = await withPersistenceLock(
    lockPath,
    () =>
      createPersistenceWithRetry(
        extensionsModule.PersistenceCreator,
        {
          cachePath,
          dataProtectionScope: extensionsModule.DataProtectionScope.CurrentUser,
          serviceName: SERVICE_NAME,
          accountName,
          usePlaintextFileOnLinux: true,
        },
        retry
      ),
    { ...retry, warn }
  );
  // On Linux createPersistence() can switch to a plaintext file without throwing, so detect that
  // here: instanceof the library's FilePersistence, or its constructor name if it isn't exported.
  const isPlaintextFallback = extensionsModule.FilePersistence
    ? persistence instanceof extensionsModule.FilePersistence
    : Boolean(
        persistence && persistence.constructor && persistence.constructor.name === "FilePersistence"
      );
  if (isPlaintextFallback) {
    tightenPlaintextPermissions(cachePath);
    warn(
      `Encrypted token storage is unavailable on this machine (no usable keyring/libsecret). ` +
        `Falling back to a plaintext token cache at ${cachePath}; tokens are stored unencrypted.`
    );
  }
  return new extensionsModule.PersistenceCachePlugin(persistence);
}

/** Restricts a plaintext cache file and its directory to the owner (0600 / 0700), best effort. */
function tightenPlaintextPermissions(cachePath) {
  try {
    fs.chmodSync(path.dirname(cachePath), 0o700);
  } catch {
    // best effort
  }
  try {
    if (fs.existsSync(cachePath)) fs.chmodSync(cachePath, 0o600);
  } catch {
    // best effort
  }
}

module.exports = {
  createCachePlugin,
  createPersistenceWithRetry,
  isTransientPersistenceError,
  withPersistenceLock,
  tightenPlaintextPermissions,
};
