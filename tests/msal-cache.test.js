/**
 * Tests for scripts/src/msal-cache.js — the cross-process lock and retry around
 * PersistenceCreator.createPersistence(), and the Linux plaintext-fallback handling.
 *
 * Needs no npm packages: @azure/msal-node-extensions is replaced by an empty stub while the module
 * loads, and every test passes its own fake PersistenceCreator.
 *
 * Run: node tests/msal-cache.test.js
 */

const assert = require("node:assert/strict");
const { spawnSync, spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// Source of a preload that makes require("@azure/msal-node-extensions") resolve to an empty object.
const STUB_SOURCE = `
const Module = require("node:module");
const load = Module._load;
Module._load = function (request, ...rest) {
  if (request === "@azure/msal-node-extensions") return {};
  return load.call(this, request, ...rest);
};
`;
const stubDir = fs.mkdtempSync(path.join(os.tmpdir(), "msal-stub-"));
const stubPath = path.join(stubDir, "stub.js");
fs.writeFileSync(stubPath, STUB_SOURCE);
require(stubPath);

const MODULE_PATH = path.join(__dirname, "..", "scripts", "src", "msal-cache.js");
const {
  createCachePlugin,
  createPersistenceWithRetry,
  isTransientPersistenceError,
  withPersistenceLock,
} = require(MODULE_PATH);

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

const registered = [];

// Same call shapes as node:test: test(name, fn) and test(name, { skip }, fn). Tests run one after
// another because several of them replace functions on the fs module.
function test(name, optionsOrFn, maybeFn) {
  const options = typeof optionsOrFn === "function" ? {} : optionsOrFn;
  const fn = typeof optionsOrFn === "function" ? optionsOrFn : maybeFn;
  registered.push({ name, options, fn });
}


// A CachePersistenceError as msal-node-extensions builds it: BasePersistence.verifyPersistence()
// wraps whatever went wrong in "Verifing persistence failed with the error: ${e}".
function checkError(inner) {
  return Object.assign(
    new Error(`CachePersistenceError: Verifing persistence failed with the error: ${inner}`),
    { errorCode: "CachePersistenceError" }
  );
}

// The transient failure seen when processes race on the shared validation entry.
function checkFailed() {
  return checkError(
    "PersistenceError: CachePersistenceError: Persistence check failed. Data was written but it " +
      "could not be read."
  );
}

// A PersistenceCreator whose createPersistence() fails the given number of times.
function fakeCreator(failures, error = checkFailed) {
  const calls = [];
  return {
    calls,
    createPersistence: async (options) => {
      calls.push(options);
      if (calls.length <= failures) throw error(calls.length);
      return { options };
    },
  };
}

const OPTIONS = { accountName: "test-slot", usePlaintextFileOnLinux: true };

test("a failed persistence check is retried with a growing delay", async () => {
  const creator = fakeCreator(2);
  const delays = [];
  const persistence = await createPersistenceWithRetry(creator, OPTIONS, {
    platform: "darwin",
    sleep: async (ms) => delays.push(ms),
  });
  assert.equal(creator.calls.length, 3);
  assert.equal(delays.length, 2);
  assert.ok(delays[0] >= 100 && delays[0] < 200);
  assert.ok(delays[1] >= 200 && delays[1] < 300);
  assert.equal(persistence.options.usePlaintextFileOnLinux, false);
});

test("other errors are not retried", async () => {
  const creator = fakeCreator(1, () => new Error("keytar missing"));
  await assert.rejects(
    createPersistenceWithRetry(creator, OPTIONS, { sleep: async () => {} }),
    /keytar missing/
  );
  assert.equal(creator.calls.length, 1);
});

test("on Linux the plaintext file is allowed only after the encrypted attempts", async () => {
  const creator = fakeCreator(4);
  const persistence = await createPersistenceWithRetry(creator, OPTIONS, {
    platform: "linux",
    sleep: async () => {},
  });
  assert.deepEqual(
    creator.calls.map((c) => c.usePlaintextFileOnLinux),
    [false, false, false, false, true]
  );
  assert.equal(persistence.options.usePlaintextFileOnLinux, true);
});

test("on Linux a failed plaintext-file check is retried too", async () => {
  const creator = fakeCreator(5);
  const persistence = await createPersistenceWithRetry(creator, OPTIONS, {
    platform: "linux",
    sleep: async () => {},
  });
  assert.equal(creator.calls.length, 6);
  assert.equal(persistence.options.usePlaintextFileOnLinux, true);

  const broken = fakeCreator(Infinity);
  const delays = [];
  await assert.rejects(
    createPersistenceWithRetry(broken, OPTIONS, {
      platform: "linux",
      sleep: async (ms) => delays.push(Math.floor(ms / 100)),
    }),
    /Verifing persistence failed/
  );
  assert.deepEqual(delays, [1, 2, 3, 1, 2, 3]);
  assert.deepEqual(
    broken.calls.map((c) => c.usePlaintextFileOnLinux),
    [false, false, false, false, true, true, true]
  );
  // Without usePlaintextFileOnLinux there is no plaintext stage.
  const encryptedOnly = fakeCreator(Infinity);
  await assert.rejects(
    createPersistenceWithRetry(
      encryptedOnly,
      { ...OPTIONS, usePlaintextFileOnLinux: false },
      { platform: "linux", sleep: async () => {} }
    ),
    /Verifing persistence failed/
  );
  assert.equal(encryptedOnly.calls.length, 4);
  // Other errors are not retried in the plaintext stage either.
  let calls = 0;
  const other = {
    createPersistence: async () => {
      calls++;
      throw calls <= 4 ? checkFailed() : new Error("libsecret crashed");
    },
  };
  await assert.rejects(
    createPersistenceWithRetry(other, OPTIONS, { platform: "linux", sleep: async () => {} }),
    /libsecret crashed/
  );
  assert.equal(calls, 5);
});

test("on Linux a clear secret-service-unavailable error skips the rest of the encrypted retries", async () => {
  const dbusError = () =>
    Object.assign(
      new Error(
        "GDBus.Error:org.freedesktop.DBus.Error.ServiceUnknown: The name org.freedesktop." +
          "secrets was not provided by any .service files"
      ),
      { errorCode: "CachePersistenceError" }
    );
  // Only the encrypted attempt fails with D-Bus; the plaintext file then hits ordinary races.
  const creator = fakeCreator(3, (call) => (call === 1 ? dbusError() : checkFailed()));
  const persistence = await createPersistenceWithRetry(creator, OPTIONS, {
    platform: "linux",
    sleep: async () => {},
  });
  // One encrypted attempt (fails with the D-Bus pattern and jumps straight to plaintext), then
  // the usual plaintext retries, succeeding on the 4th call overall.
  assert.deepEqual(
    creator.calls.map((c) => c.usePlaintextFileOnLinux),
    [false, true, true, true]
  );
  assert.equal(persistence.options.usePlaintextFileOnLinux, true);
});

test("on Linux a secret-service-unavailable error with no plaintext fallback allowed fails right away", async () => {
  const dbusError = () =>
    Object.assign(new Error("Cannot autolaunch D-Bus without X11 $DISPLAY"), {
      errorCode: "CachePersistenceError",
    });
  const creator = fakeCreator(Infinity, dbusError);
  await assert.rejects(
    createPersistenceWithRetry(
      creator,
      { ...OPTIONS, usePlaintextFileOnLinux: false },
      { platform: "linux", sleep: async () => {} }
    ),
    /Cannot autolaunch D-Bus/
  );
  assert.equal(creator.calls.length, 1);
});

test("a transient persistence-check failure on Linux does not short-circuit the encrypted retries", async () => {
  const creator = fakeCreator(4);
  const persistence = await createPersistenceWithRetry(creator, OPTIONS, {
    platform: "linux",
    sleep: async () => {},
  });
  assert.deepEqual(
    creator.calls.map((c) => c.usePlaintextFileOnLinux),
    [false, false, false, false, true]
  );
  assert.equal(persistence.options.usePlaintextFileOnLinux, true);
});

test(
  "createCachePlugin tightens permissions and warns when the store silently falls back to plaintext on Linux",
  { skip: process.platform === "win32" },
  async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "msal-cache-"));
    const cachePath = path.join(dir, "test-slot.cache.json");
    fs.writeFileSync(cachePath, "{}", { mode: 0o644 });
    fs.chmodSync(dir, 0o755);

    class FilePersistence {}
    const persistence = new FilePersistence();
    const extensions = {
      PersistenceCreator: { createPersistence: async () => persistence },
      PersistenceCachePlugin: class {
        constructor(p) {
          this.persistence = p;
        }
      },
      DataProtectionScope: { CurrentUser: "CurrentUser" },
    };
    const warnings = [];

    const plugin = await createCachePlugin("test-slot", {
      extensions,
      warn: (m) => warnings.push(m),
      cachePath,
      lockPath: path.join(dir, ".persistence.lock"),
      platform: "linux",
      sleep: async () => {},
    });
    assert.equal(plugin.persistence, persistence);
    assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
    assert.equal(fs.statSync(cachePath).mode & 0o777, 0o600);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /Encrypted token storage is unavailable/);
    assert.match(warnings[0], new RegExp(cachePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    fs.rmSync(dir, { recursive: true, force: true });
  }
);

test("createCachePlugin does not warn or touch permissions when encrypted storage works", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "msal-cache-"));
  const cachePath = path.join(dir, "test-slot.cache.json");

  class KeychainPersistence {}
  const persistence = new KeychainPersistence();
  const extensions = {
    PersistenceCreator: { createPersistence: async () => persistence },
    PersistenceCachePlugin: class {
      constructor(p) {
        this.persistence = p;
      }
    },
    DataProtectionScope: { CurrentUser: "CurrentUser" },
  };
  const warnings = [];
  const plugin = await createCachePlugin("test-slot", {
    extensions,
    warn: (m) => warnings.push(m),
    cachePath,
    lockPath: path.join(dir, ".persistence.lock"),
    platform: "darwin",
    sleep: async () => {},
  });
  assert.equal(plugin.persistence, persistence);
  assert.equal(warnings.length, 0);
  assert.equal(fs.existsSync(cachePath), false); // never touched
  fs.rmSync(dir, { recursive: true, force: true });
});

test("withPersistenceLock: acquire, run, release", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "msal-lock-"));
  const lockPath = path.join(dir, ".persistence.lock");
  let sawLockDuringRun = false;
  const result = await withPersistenceLock(lockPath, async () => {
    sawLockDuringRun = fs.existsSync(lockPath);
    return "ok";
  });
  assert.equal(result, "ok");
  assert.equal(sawLockDuringRun, true);
  assert.equal(fs.existsSync(lockPath), false); // released
  fs.rmSync(dir, { recursive: true, force: true });
});

test("withPersistenceLock releases on error too", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "msal-lock-"));
  const lockPath = path.join(dir, ".persistence.lock");
  await assert.rejects(
    withPersistenceLock(lockPath, async () => {
      throw new Error("boom");
    }),
    /boom/
  );
  assert.equal(fs.existsSync(lockPath), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("withPersistenceLock waits out a lock held by a live holder, then acquires it", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "msal-lock-"));
  const lockPath = path.join(dir, ".persistence.lock");
  const fd = fs.openSync(lockPath, "wx");
  fs.writeSync(fd, "999999");

  let polls = 0;
  const releaseAfter = 3;
  const promise = withPersistenceLock(lockPath, async () => "acquired", {
    waitMs: 5000,
    staleMs: 999999, // not stale; must wait, not take over
    pollMs: 1,
    sleep: async () => {
      polls++;
      if (polls === releaseAfter) {
        fs.closeSync(fd);
        fs.unlinkSync(lockPath);
      }
    },
  });
  assert.equal(await promise, "acquired");
  assert.ok(polls >= releaseAfter);
  assert.equal(fs.existsSync(lockPath), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("withPersistenceLock takes over a stale lock (holder presumed dead)", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "msal-lock-"));
  const lockPath = path.join(dir, ".persistence.lock");
  fs.writeFileSync(lockPath, "123");
  const old = Date.now() / 1000 - 60; // 60s in the past
  fs.utimesSync(lockPath, old, old);

  const result = await withPersistenceLock(lockPath, async () => "took over", {
    staleMs: 30000,
    sleep: async () => {},
  });
  assert.equal(result, "took over");
  assert.equal(fs.existsSync(lockPath), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("withPersistenceLock: a lock held by a dead pid is taken over immediately, not after staleMs", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "msal-lock-"));
  const lockPath = path.join(dir, ".persistence.lock");
  // A pid guaranteed to be exited: spawnSync only returns once the child has already exited.
  const dead = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
  fs.writeFileSync(lockPath, `${dead.pid}:deadbeefdeadbeef`); // fresh mtime, not stale by time

  let slept = 0;
  const start = Date.now();
  const result = await withPersistenceLock(lockPath, async () => "took over", {
    staleMs: 30000, // would otherwise require the lock to look 30s old
    waitMs: 10000,
    sleep: async () => {
      slept++;
    },
  });
  assert.equal(result, "took over");
  // The dead pid made the lock stale on the very first check, not after staleMs or waitMs: at
  // most one poll (the retry after clearing the slot), never the handful it'd take to reach a
  // 10s bound.
  assert.ok(slept <= 1);
  assert.ok(Date.now() - start < 2000);
  assert.equal(fs.existsSync(lockPath), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("withPersistenceLock: a takeover that races a fresh acquisition puts the live lock back", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "msal-lock-"));
  const lockPath = path.join(dir, ".persistence.lock");
  fs.writeFileSync(lockPath, "dead-owner:aaaaaaaaaaaaaaaa");
  const old = Date.now() / 1000 - 60;
  fs.utimesSync(lockPath, old, old); // stale by mtime

  const freshContents = `${process.pid}:bbbbbbbbbbbbbbbb`;
  const realRenameSync = fs.renameSync;
  let renamed = false;
  fs.renameSync = (from, to) => {
    if (from === lockPath && !renamed) {
      renamed = true;
      // Simulate a live process replacing the dead lock with its own fresh one right before our
      // rename wins the race, so the rename actually moves the fresh lock, not the dead one.
      fs.writeFileSync(lockPath, freshContents);
    }
    return realRenameSync(from, to);
  };

  let ran = false;
  try {
    const result = await withPersistenceLock(
      lockPath,
      async () => {
        ran = true;
        return "ran anyway";
      },
      { staleMs: 30000, waitMs: 60, pollMs: 5, sleep: async () => {} }
    );
    // We never actually took the lock: the fresh one was live (our own pid) and not stale, so we
    // waited out the (short) deadline and ran unlocked, same as any other contended lock.
    assert.equal(result, "ran anyway");
    assert.equal(ran, true);
  } finally {
    fs.renameSync = realRenameSync;
  }
  // The live lock we stole by accident must be put back exactly as it was, not left renamed
  // away or deleted.
  assert.equal(fs.readFileSync(lockPath, "utf-8"), freshContents);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("withPersistenceLock gives up waiting after the timeout and still runs, unlocked", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "msal-lock-"));
  const lockPath = path.join(dir, ".persistence.lock");
  const fd = fs.openSync(lockPath, "wx");
  fs.writeSync(fd, "999999"); // never released, never stale within the test window

  let ran = false;
  const result = await withPersistenceLock(
    lockPath,
    async () => {
      ran = true;
      return "ran anyway";
    },
    {
      waitMs: 30, // small bound so the test stays fast
      staleMs: 999999,
      pollMs: 5,
      sleep: async (ms) => new Promise((r) => setTimeout(r, ms)),
    }
  );
  assert.equal(result, "ran anyway");
  assert.equal(ran, true);
  // the original holder's lock file is untouched — we never took ownership of it
  assert.equal(fs.readFileSync(lockPath, "utf-8"), "999999");
  fs.closeSync(fd);
  fs.rmSync(dir, { recursive: true, force: true });
});

test(
  "withPersistenceLock: a stale lock that cannot be removed (read-only dir) still returns within the bound, unlocked",
  { skip: process.platform === "win32" || (process.getuid && process.getuid() === 0) },
  async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "msal-lock-"));
    const lockPath = path.join(dir, ".persistence.lock");
    fs.writeFileSync(lockPath, "111111");
    const old = Date.now() / 1000 - 60;
    fs.utimesSync(lockPath, old, old); // stale by any staleMs we use below

    fs.chmodSync(dir, 0o500); // read + execute only: rename/unlink/create all fail with EACCES
    let ran = false;
    const start = Date.now();
    try {
      const result = await withPersistenceLock(
        lockPath,
        async () => {
          ran = true;
          return "ran anyway";
        },
        {
          waitMs: 80,
          staleMs: 0,
          pollMs: 5,
          sleep: async (ms) => new Promise((r) => setTimeout(r, ms)),
        }
      );
      assert.equal(result, "ran anyway");
      assert.equal(ran, true);
    } finally {
      fs.chmodSync(dir, 0o700); // restore so cleanup can remove the dir
    }
    assert.ok(Date.now() - start < 1000); // well within the bound; no busy spin
    fs.rmSync(dir, { recursive: true, force: true });
  }
);

test("withPersistenceLock: release only removes the lock if it still holds our token", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "msal-lock-"));
  const lockPath = path.join(dir, ".persistence.lock");
  await withPersistenceLock(lockPath, async () => {
    // Simulate the lock having been taken over by someone else while we (incorrectly) still
    // thought we held it — release must not delete a lock that isn't ours any more.
    fs.writeFileSync(lockPath, "someone-else:deadbeef");
  });
  assert.equal(fs.readFileSync(lockPath, "utf-8"), "someone-else:deadbeef");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("withPersistenceLock: two contenders racing a stale takeover never run fn concurrently", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "msal-lock-"));
  const lockPath = path.join(dir, ".persistence.lock");
  fs.writeFileSync(lockPath, "dead-owner");
  const old = Date.now() / 1000 - 60;
  fs.utimesSync(lockPath, old, old);

  let concurrent = 0;
  let maxConcurrent = 0;
  const run = () =>
    withPersistenceLock(
      lockPath,
      async () => {
        concurrent++;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        await new Promise((r) => setImmediate(r));
        concurrent--;
        return "ok";
      },
      { staleMs: 30000, pollMs: 1, sleep: async () => new Promise((r) => setImmediate(r)) }
    );

  const results = await Promise.all([run(), run()]);
  assert.deepEqual(results, ["ok", "ok"]);
  assert.equal(maxConcurrent, 1);
  assert.equal(fs.existsSync(lockPath), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("withPersistenceLock: a win32 EBUSY from openSync is treated as contention, not thrown", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "msal-lock-"));
  const lockPath = path.join(dir, ".persistence.lock");
  const realOpenSync = fs.openSync;
  let calls = 0;
  fs.openSync = (p, flags, mode) => {
    if (p === lockPath) {
      calls++;
      if (calls === 1) {
        throw Object.assign(new Error("resource busy or locked"), { code: "EBUSY" });
      }
    }
    return realOpenSync(p, flags, mode);
  };
  try {
    const result = await withPersistenceLock(lockPath, async () => "ok", {
      platform: "win32",
      pollMs: 1,
      sleep: async () => {},
    });
    assert.equal(result, "ok");
    assert.ok(calls >= 2);
  } finally {
    fs.openSync = realOpenSync;
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

test("withPersistenceLock: the same EBUSY on non-Windows is not contention; it degrades to unlocked with a warning", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "msal-lock-"));
  const lockPath = path.join(dir, ".persistence.lock");
  const realOpenSync = fs.openSync;
  fs.openSync = () => {
    throw Object.assign(new Error("resource busy or locked"), { code: "EBUSY" });
  };
  const warnings = [];
  let ran = false;
  try {
    const result = await withPersistenceLock(
      lockPath,
      async () => {
        ran = true;
        return "ok";
      },
      { platform: "darwin", warn: (m) => warnings.push(m), sleep: async () => {} }
    );
    assert.equal(result, "ok");
    assert.equal(ran, true);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /Could not acquire the persistence lock/);
  } finally {
    fs.openSync = realOpenSync;
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

test("withPersistenceLock: an EEXIST from mkdirSync (syscall 'mkdir') is not contention", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "msal-lock-"));
  const lockPath = path.join(dir, "sub", ".persistence.lock");
  const realMkdirSync = fs.mkdirSync;
  fs.mkdirSync = (p, opts) => {
    if (p === path.dirname(lockPath)) {
      // What mkdirSync throws when a file (not a directory) already sits at the cache-dir path.
      throw Object.assign(new Error("EEXIST: file already exists, mkdir"), {
        code: "EEXIST",
        syscall: "mkdir",
      });
    }
    return realMkdirSync(p, opts);
  };
  const warnings = [];
  let ran = false;
  try {
    const result = await withPersistenceLock(
      lockPath,
      async () => {
        ran = true;
        return "ran anyway";
      },
      { warn: (m) => warnings.push(m), sleep: async () => {} }
    );
    assert.equal(result, "ran anyway");
    assert.equal(ran, true);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /Could not acquire the persistence lock/);
  } finally {
    fs.mkdirSync = realMkdirSync;
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

test("withPersistenceLock: a win32 EACCES on open is contention while the lock file is actually there", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "msal-lock-"));
  const lockPath = path.join(dir, ".persistence.lock");
  fs.writeFileSync(lockPath, "999999:aaaaaaaaaaaaaaaa"); // a real lock file is present
  const realOpenSync = fs.openSync;
  let attempts = 0;
  fs.openSync = (p, flags, mode) => {
    if (p === lockPath) {
      attempts++;
      if (attempts <= 2) {
        throw Object.assign(new Error("access is denied"), { code: "EACCES" });
      }
    }
    return realOpenSync(p, flags, mode);
  };
  let polls = 0;
  try {
    const result = await withPersistenceLock(lockPath, async () => "ok", {
      platform: "win32",
      pollMs: 1,
      staleMs: 999999,
      sleep: async () => {
        polls++;
        if (polls === 2) fs.unlinkSync(lockPath); // release, so the next open can succeed
      },
    });
    assert.equal(result, "ok");
    assert.ok(attempts >= 2); // kept retrying rather than bailing on the first EACCES
  } finally {
    fs.openSync = realOpenSync;
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

test("withPersistenceLock: a win32 EACCES on open with no lock file present is not contention", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "msal-lock-"));
  const lockPath = path.join(dir, ".persistence.lock"); // never created
  const realOpenSync = fs.openSync;
  fs.openSync = (p, flags, mode) => {
    if (p === lockPath) {
      throw Object.assign(new Error("access is denied"), { code: "EACCES" });
    }
    return realOpenSync(p, flags, mode);
  };
  const warnings = [];
  let ran = false;
  try {
    const result = await withPersistenceLock(
      lockPath,
      async () => {
        ran = true;
        return "ok";
      },
      { platform: "win32", warn: (m) => warnings.push(m), sleep: async () => {} }
    );
    assert.equal(result, "ok");
    assert.equal(ran, true);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /Could not acquire the persistence lock/);
  } finally {
    fs.openSync = realOpenSync;
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

test("withPersistenceLock: a win32 EACCES on open with a stat that also fails EPERM stays contention", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "msal-lock-"));
  const lockPath = path.join(dir, ".persistence.lock");
  const realOpenSync = fs.openSync;
  const realStatSync = fs.statSync;
  let opens = 0;
  fs.openSync = (p, flags, mode) => {
    if (p === lockPath) {
      opens++;
      throw Object.assign(new Error("access is denied"), { code: "EACCES" });
    }
    return realOpenSync(p, flags, mode);
  };
  fs.statSync = (p, opts) => {
    if (p === lockPath) throw Object.assign(new Error("access is denied"), { code: "EPERM" });
    return realStatSync(p, opts);
  };
  try {
    const result = await withPersistenceLock(lockPath, async () => "ran anyway", {
      platform: "win32",
      waitMs: 30,
      pollMs: 5,
      sleep: async (ms) => new Promise((r) => setTimeout(r, ms)),
    });
    assert.equal(result, "ran anyway");
    assert.ok(opens >= 2); // kept retrying rather than bailing on the first EACCES
  } finally {
    fs.openSync = realOpenSync;
    fs.statSync = realStatSync;
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

test("withPersistenceLock: closes the fd if writeSync fails, and does not hang", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "msal-lock-"));
  const lockPath = path.join(dir, ".persistence.lock");
  const realWriteSync = fs.writeSync;
  const realCloseSync = fs.closeSync;
  const closedFds = [];
  fs.closeSync = (fd) => {
    closedFds.push(fd);
    return realCloseSync(fd);
  };
  fs.writeSync = () => {
    fs.writeSync = realWriteSync; // only fail the first attempt
    throw new Error("write failed");
  };
  try {
    const result = await withPersistenceLock(lockPath, async () => "ok", {
      pollMs: 1,
      sleep: async () => {},
    });
    assert.equal(result, "ok");
    assert.ok(closedFds.length >= 1);
    // No empty lock file is left behind for other processes to wait on.
    assert.equal(fs.existsSync(lockPath), false);
  } finally {
    fs.writeSync = realWriteSync;
    fs.closeSync = realCloseSync;
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

test("withPersistenceLock: refreshes the lock mtime while held, so a slow holder is not stale", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "msal-lock-"));
  const lockPath = path.join(dir, ".persistence.lock");
  let before;
  let after;
  await withPersistenceLock(
    lockPath,
    async () => {
      const old = new Date(Date.now() - 60000);
      fs.utimesSync(lockPath, old, old);
      before = fs.statSync(lockPath).mtimeMs;
      await new Promise((r) => setTimeout(r, 200));
      after = fs.statSync(lockPath).mtimeMs;
    },
    { staleMs: 150 }
  );
  assert.ok(after > before + 30000);
  assert.equal(fs.existsSync(lockPath), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("withPersistenceLock: warns when it gives up waiting and runs unlocked", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "msal-lock-"));
  const lockPath = path.join(dir, ".persistence.lock");
  fs.writeFileSync(lockPath, "someone-else");
  const warnings = [];
  const result = await withPersistenceLock(lockPath, async () => "ran", {
    waitMs: 30,
    pollMs: 5,
    warn: (m) => warnings.push(m),
  });
  assert.equal(result, "ran");
  assert.ok(warnings.some((w) => /continuing without it/.test(w)));
  assert.equal(fs.readFileSync(lockPath, "utf-8"), "someone-else");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("createCachePlugin: a lock-directory failure only warns about the lock and still succeeds", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "msal-cache-"));
  const cachePath = path.join(dir, "test-slot.cache.json");
  const blocker = path.join(dir, "not-a-dir");
  fs.writeFileSync(blocker, ""); // a file where a directory is expected
  const lockPath = path.join(blocker, "sub", ".persistence.lock"); // mkdirSync(dirname) -> ENOTDIR

  class KeychainPersistence {}
  const persistence = new KeychainPersistence();
  const extensions = {
    PersistenceCreator: { createPersistence: async () => persistence },
    PersistenceCachePlugin: class {
      constructor(p) {
        this.persistence = p;
      }
    },
    DataProtectionScope: { CurrentUser: "CurrentUser" },
  };
  const warnings = [];
  const plugin = await createCachePlugin("test-slot", {
    extensions,
    warn: (m) => warnings.push(m),
    cachePath,
    lockPath,
    platform: "darwin",
    sleep: async () => {},
  });
  assert.equal(plugin.persistence, persistence);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /Could not acquire the persistence lock/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("createCachePlugin: with FilePersistence exported, detects the plaintext fallback via instanceof, not the class name", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "msal-cache-"));
  const cachePath = path.join(dir, "test-slot.cache.json");
  fs.writeFileSync(cachePath, "{}", { mode: 0o644 });
  fs.chmodSync(dir, 0o755);

  class FilePersistence {} // the library's own export
  class Minified extends FilePersistence {} // instance's runtime class name differs
  const persistence = new Minified();
  const extensions = {
    FilePersistence,
    PersistenceCreator: { createPersistence: async () => persistence },
    PersistenceCachePlugin: class {
      constructor(p) {
        this.persistence = p;
      }
    },
    DataProtectionScope: { CurrentUser: "CurrentUser" },
  };
  const warnings = [];
  await createCachePlugin("test-slot", {
    extensions,
    warn: (m) => warnings.push(m),
    cachePath,
    lockPath: path.join(dir, ".persistence.lock"),
    platform: "linux",
    sleep: async () => {},
  });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /Encrypted token storage is unavailable/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("createCachePlugin: with FilePersistence exported, a same-named-but-unrelated class is not mistaken for it", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "msal-cache-"));
  const cachePath = path.join(dir, "test-slot.cache.json");

  class FilePersistence {} // the library's real export
  class LookalikePersistence {}
  Object.defineProperty(LookalikePersistence, "name", { value: "FilePersistence" });
  const persistence = new LookalikePersistence();
  const extensions = {
    FilePersistence,
    PersistenceCreator: { createPersistence: async () => persistence },
    PersistenceCachePlugin: class {
      constructor(p) {
        this.persistence = p;
      }
    },
    DataProtectionScope: { CurrentUser: "CurrentUser" },
  };
  const warnings = [];
  await createCachePlugin("test-slot", {
    extensions,
    warn: (m) => warnings.push(m),
    cachePath,
    lockPath: path.join(dir, ".persistence.lock"),
    platform: "darwin",
    sleep: async () => {},
  });
  assert.equal(warnings.length, 0);
  assert.equal(fs.existsSync(cachePath), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("withPersistenceLock: the lock file holds a token prefixed with the holder's pid", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "msal-lock-"));
  const lockPath = path.join(dir, ".persistence.lock");
  let seen;
  await withPersistenceLock(lockPath, async () => {
    seen = fs.readFileSync(lockPath, "utf-8");
  });
  assert.match(seen, new RegExp(`^${process.pid}:[0-9a-f]{16}$`));
  fs.rmSync(dir, { recursive: true, force: true });
});

test("withPersistenceLock: separate processes never hold the lock at the same time", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "msal-lock-"));
  const lockPath = path.join(dir, ".persistence.lock");
  const marker = path.join(dir, "inside");
  // Each child takes the lock, then creates `marker` exclusively; if the lock ever let two
  // children in together, the second create fails and that child exits non-zero.
  const childCode = `
    const fs = require("fs");
    const { withPersistenceLock } = require(${JSON.stringify(MODULE_PATH)});
    withPersistenceLock(${JSON.stringify(lockPath)}, async () => {
      fs.closeSync(fs.openSync(${JSON.stringify(marker)}, "wx"));
      await new Promise((r) => setTimeout(r, 60));
      fs.unlinkSync(${JSON.stringify(marker)});
    }, { warn: (m) => { console.error(m); process.exitCode = 3; } }).catch((e) => {
      console.error(e);
      process.exit(2);
    });
  `;
  const codes = await Promise.all(
    Array.from(
      { length: 6 },
      () =>
        new Promise((resolve) => {
          const child = spawn(process.execPath, ["-r", stubPath, "-e", childCode], {
            stdio: "inherit",
          });
          child.on("exit", (code) => resolve(code));
        })
    )
  );
  assert.deepEqual(codes, [0, 0, 0, 0, 0, 0]);
  assert.equal(fs.existsSync(lockPath), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("isTransientPersistenceError: races on the shared validation entry are transient", () => {
  const transient = [
    "PersistenceError: CachePersistenceError: Persistence check failed. Data was written but it " +
      "could not be read. Possible cause: on Linux, LibSecret is installed but D-Bus isn't running",
    "PersistenceError: ENOENT: ENOENT: no such file or directory, open '/home/u/.copilot-studio-cli/test.cache'",
    "PersistenceError: EPERM: EPERM: operation not permitted, open 'C:\\Users\\u\\.copilot-studio-cli\\test.cache'",
    "PersistenceError: EBUSY: EBUSY: resource busy or locked, open 'C:\\x\\test.cache'",
    "PersistenceError: EACCES: EACCES: permission denied, open 'C:\\x\\test.cache'",
    "PersistenceError: CachePersistenceError: Persistence check failed. Data written dummy_data is " +
      "different                     from data read du",
    "PersistenceError: KeychainError: The specified item already exists in the keychain.",
    "PersistenceError: KeychainError: The specified item could not be found in the keychain.",
    "PersistenceError: KeychainError: The specified item is no longer valid. It may have been " +
      "deleted from the keychain.",
  ];
  for (const inner of transient) {
    assert.equal(isTransientPersistenceError(checkError(inner)), true, inner);
  }
});

test("isTransientPersistenceError: a declined or cancelled prompt and other errors are not transient", () => {
  const notTransient = [
    "PersistenceError: KeychainError: User canceled the operation.",
    "PersistenceError: KeychainError: The user name or passphrase you entered is not correct.",
    "PersistenceError: KeychainError: User interaction is not allowed.",
    "PersistenceError: GnomeKeyringError: Cannot get secret of a locked object",
    "PersistenceError: DPAPIEncryptedFileError: The parameter is incorrect.",
    "Error: something unexpected",
  ];
  for (const inner of notTransient) {
    assert.equal(isTransientPersistenceError(checkError(inner)), false, inner);
  }
  assert.equal(isTransientPersistenceError(undefined), false);
  assert.equal(isTransientPersistenceError(new Error("")), false);
});

test("on macOS a declined or cancelled Keychain prompt is not retried", async () => {
  const messages = [
    "User canceled the operation.",
    "The user name or passphrase you entered is not correct.",
    "User interaction is not allowed.",
  ];
  for (const message of messages) {
    const creator = fakeCreator(Infinity, () =>
      checkError(`PersistenceError: KeychainError: ${message}`)
    );
    const delays = [];
    await assert.rejects(
      createPersistenceWithRetry(creator, OPTIONS, {
        platform: "darwin",
        sleep: async (ms) => delays.push(ms),
      }),
      new RegExp(message.replace(/\./g, "\\."))
    );
    assert.equal(creator.calls.length, 1, message);
    assert.equal(delays.length, 0, message);
  }
});

test("on macOS a keychain race (item already exists) is still retried", async () => {
  const creator = fakeCreator(2, () =>
    checkError("PersistenceError: KeychainError: The specified item already exists in the keychain.")
  );
  await createPersistenceWithRetry(creator, OPTIONS, { platform: "darwin", sleep: async () => {} });
  assert.equal(creator.calls.length, 3);
});

test("on Windows only file races and unreadable entries are retried", async () => {
  const racy = fakeCreator(2, () =>
    checkError("PersistenceError: EPERM: EPERM: operation not permitted, open 'C:\\x\\test.cache'")
  );
  await createPersistenceWithRetry(racy, OPTIONS, { platform: "win32", sleep: async () => {} });
  assert.equal(racy.calls.length, 3);

  const other = fakeCreator(Infinity, () =>
    checkError("PersistenceError: DPAPIEncryptedFileError: The parameter is incorrect.")
  );
  await assert.rejects(
    createPersistenceWithRetry(other, OPTIONS, { platform: "win32", sleep: async () => {} }),
    /DPAPIEncryptedFileError/
  );
  assert.equal(other.calls.length, 1);
});

test("on Linux a non-transient encrypted failure goes straight to the plaintext stage", async () => {
  const locked = () =>
    checkError("PersistenceError: GnomeKeyringError: Cannot get secret of a locked object");
  const creator = fakeCreator(1, locked);
  const persistence = await createPersistenceWithRetry(creator, OPTIONS, {
    platform: "linux",
    sleep: async () => {},
  });
  assert.deepEqual(
    creator.calls.map((c) => c.usePlaintextFileOnLinux),
    [false, true]
  );
  assert.equal(persistence.options.usePlaintextFileOnLinux, true);

  // Without the plaintext option there is nothing to fall back to.
  const strict = fakeCreator(Infinity, locked);
  await assert.rejects(
    createPersistenceWithRetry(
      strict,
      { ...OPTIONS, usePlaintextFileOnLinux: false },
      { platform: "linux", sleep: async () => {} }
    ),
    /locked object/
  );
  assert.equal(strict.calls.length, 1);
});

// A live process took the lock between our read and our takeover rename, so the rename moved its
// fresh lock. Runs the takeover with `fs.linkSync` replaced by `linkSync`.
async function stolenLockScenario(linkSync) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "msal-lock-"));
  const lockPath = path.join(dir, ".persistence.lock");
  fs.writeFileSync(lockPath, "dead-owner:aaaaaaaaaaaaaaaa");
  const old = Date.now() / 1000 - 60;
  fs.utimesSync(lockPath, old, old); // stale by mtime

  const freshContents = `${process.pid}:bbbbbbbbbbbbbbbb`;
  const realRenameSync = fs.renameSync;
  const realLinkSync = fs.linkSync;
  let renamed = false;
  fs.renameSync = (from, to) => {
    if (from === lockPath && !renamed) {
      renamed = true;
      fs.writeFileSync(lockPath, freshContents);
    }
    return realRenameSync(from, to);
  };
  fs.linkSync = linkSync;
  let ran = false;
  try {
    await withPersistenceLock(
      lockPath,
      async () => {
        ran = true;
      },
      { staleMs: 30000, waitMs: 60, pollMs: 5, sleep: async () => {} }
    );
  } finally {
    fs.renameSync = realRenameSync;
    fs.linkSync = realLinkSync;
  }
  const result = {
    ran,
    lockContents: fs.existsSync(lockPath) ? fs.readFileSync(lockPath, "utf-8") : null,
    leftovers: fs.readdirSync(dir).filter((name) => name.includes(".stale-")),
    freshContents,
  };
  fs.rmSync(dir, { recursive: true, force: true });
  return result;
}

test("withPersistenceLock: without hard links a stolen live lock is restored and no .stale file is left", async () => {
  for (const code of ["EPERM", "ENOTSUP", "EXDEV", "ENOSYS"]) {
    const r = await stolenLockScenario(() => {
      throw Object.assign(new Error(`${code}: hard links not supported`), { code, syscall: "link" });
    });
    assert.equal(r.ran, true, code);
    assert.equal(r.lockContents, r.freshContents, code);
    assert.deepEqual(r.leftovers, [], code);
  }
});

test("withPersistenceLock: a failed restore of a stolen lock still leaves no .stale file", async () => {
  // Neither link nor an exclusive re-create can put the lock back (another process created one
  // meanwhile): its lock must stay untouched and our takeover file must be gone.
  let linkAttempted = false;
  const r = await stolenLockScenario((from, to) => {
    linkAttempted = true;
    fs.writeFileSync(to, "other-owner:cccccccccccccccc");
    throw Object.assign(new Error("EPERM: hard links not supported"), { code: "EPERM" });
  });
  assert.equal(linkAttempted, true);
  assert.equal(r.lockContents, "other-owner:cccccccccccccccc");
  assert.deepEqual(r.leftovers, []);
});

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

(async () => {
  let passed = 0;
  let failed = 0;
  let skipped = 0;
  for (const { name, options, fn } of registered) {
    if (options.skip) {
      skipped++;
      continue;
    }
    try {
      await fn();
      passed++;
    } catch (e) {
      failed++;
      console.error(`FAIL: ${name}\n  ${e && e.stack ? e.stack : e}`);
    }
  }
  fs.rmSync(stubDir, { recursive: true, force: true });
  console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed, ${skipped} skipped`);
  process.exit(failed > 0 ? 1 : 0);
})();
