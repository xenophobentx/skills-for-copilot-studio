/**
 * Tests for sync-guard.js: the backup before a pull, the pull preview and the
 * comparison with a fresh clone after a push.
 *
 * Needs js-yaml from scripts/node_modules (run `npm ci` in scripts/). Without
 * it the test prints a SKIP line and exits 0, or exits 1 when CI is set.
 * Run: node tests/sync-guard.test.js
 */

const fs = require("fs");
const os = require("os");
const path = require("path");

try {
  require(path.join(__dirname, "..", "scripts", "node_modules", "js-yaml"));
} catch {
  console.log("SKIP: js-yaml not installed. Run `npm ci` in scripts/ first.");
  process.exit(process.env.CI ? 1 : 0);
}
const sg = require("../scripts/src/sync-guard.js");

let passed = 0;
let failed = 0;

function assertEqual(actual, expected, label) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    passed++;
  } else {
    failed++;
    console.error(`FAIL: ${label}\n  expected: ${e}\n  actual:   ${a}`);
  }
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), "sync-guard-test-"));
let n = 0;

function makeDir(files) {
  const dir = path.join(root, `case${n++}`);
  fs.mkdirSync(dir, { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, ...rel.split("/"));
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return dir;
}

const read = (dir, rel) => fs.readFileSync(path.join(dir, ...rel.split("/")), "utf8");

(async () => {
  try {
    // -----------------------------------------------------------------------
    // backupAgent
    // -----------------------------------------------------------------------
    {
      const dir = makeDir({
        "agent.mcs.yml": "kind: GptComponentMetadata\n",
        "topics/Greeting.mcs.yml": "kind: AdaptiveDialog\n",
        ".mcs/conn.json": "{}",
        ".mcs/botdefinition.json": "{}",
      });
      const b = sg.backupAgent(dir, { now: new Date(Date.UTC(2026, 9, 10, 7, 5, 9)) });
      assertEqual(path.relative(dir, b.path).split(path.sep).join("/"), ".mcs/backups/20261010-070509", "backup path");
      assertEqual(b.files, 2, "backup counts the agent files");
      assertEqual(read(b.path, "topics/Greeting.mcs.yml"), "kind: AdaptiveDialog\n", "backup copies a topic");
      assertEqual(fs.existsSync(path.join(b.path, ".mcs")), false, "backup leaves .mcs out");
      assertEqual(b.restore.includes(b.path), true, "restore text names the backup");

      // A second backup in the same second gets its own folder and holds no backup of the first.
      const b2 = sg.backupAgent(dir, { now: new Date(Date.UTC(2026, 9, 10, 7, 5, 9)) });
      assertEqual(path.basename(b2.path), "20261010-070509-2", "same-second backup gets a suffix");
      assertEqual(fs.existsSync(path.join(b2.path, ".mcs")), false, "second backup does not contain the first");
    }

    // Keeps the newest N, deletes only folders named like ours.
    {
      const dir = makeDir({ "agent.mcs.yml": "x: 1\n", ".mcs/backups/keepme/file.txt": "mine" });
      for (let i = 1; i <= 5; i++) sg.backupAgent(dir, { keep: 3, now: new Date(Date.UTC(2026, 0, i, 10, 0, 0)) });
      const left = fs.readdirSync(path.join(dir, ".mcs", "backups")).sort();
      assertEqual(left, ["20260103-100000", "20260104-100000", "20260105-100000", "keepme"], "keeps the newest 3 and a foreign folder");
    }

    // Empty agent folder still gets a backup folder.
    {
      const dir = makeDir({ ".mcs/conn.json": "{}" });
      const b = sg.backupAgent(dir);
      assertEqual([fs.existsSync(b.path), b.files], [true, 0], "backup of an empty folder");
    }

    // Backups skip dot folders and node_modules, and sort -10 after -2.
    {
      const dir = makeDir({
        "agent.mcs.yml": "x: 1\n",
        "node_modules/pkg/index.js": "x",
        ".vscode/settings.json": "{}",
        "topics/T.mcs.yml": "y: 1\n",
      });
      const b = sg.backupAgent(dir);
      assertEqual(b.files, 2, "node_modules and dot folders are not backed up");
      const dir2 = makeDir({ "agent.mcs.yml": "x: 1\n" });
      const now = new Date(Date.UTC(2026, 5, 1, 12, 0, 0));
      for (let i = 0; i < 11; i++) sg.backupAgent(dir2, { keep: 3, now });
      assertEqual(
        fs.readdirSync(path.join(dir2, ".mcs", "backups")).sort(),
        ["20260601-120000-10", "20260601-120000-11", "20260601-120000-9"].sort().filter(Boolean),
        "keeps the three newest across the -9 / -10 boundary"
      );
    }

    // A failed backup is a warning, keep 0 makes none.
    {
      const dir = makeDir({ "agent.mcs.yml": "x: 1\n", ".mcs/backups": "this is a file, not a folder" });
      const r = sg.tryBackup(dir);
      assertEqual([r.backup, /No backup was made/.test(r.warning)], [null, true], "failed backup gives a warning and no throw");
      const dir2 = makeDir({ "agent.mcs.yml": "x: 1\n" });
      assertEqual(sg.tryBackup(dir2, { keep: 0 }), { backup: null, warning: null }, "keep 0: no backup, no warning");
      assertEqual(fs.existsSync(path.join(dir2, ".mcs")), false, "keep 0 writes nothing");
      assertEqual(sg.tryBackup(dir2).backup.files, 1, "default keeps a backup");
    }

    // Restore text: quoted paths, a command per platform, the push warning.
    {
      const unix = sg.restoreText("/a b/.mcs/backups/20260101-000000", "/a b/agent", "linux");
      assertEqual(unix.includes('cp -R "/a b/.mcs/backups/20260101-000000/." "/a b/agent"'), true, "unix restore command is quoted");
      const win = sg.restoreText("C:\\a b\\bk", "C:\\a b\\agent", "win32");
      assertEqual(win.includes('Copy-Item -Path "C:\\a b\\bk\\*" -Destination "C:\\a b\\agent" -Recurse -Force'), true, "Windows restore command is quoted");
      assertEqual(/overwrites the server changes/.test(unix) && /deleted come back/.test(unix), true, "restore text warns about a push and deleted topics");
    }

    // -----------------------------------------------------------------------
    // sameContent
    // -----------------------------------------------------------------------
    assertEqual(sg.sameContent("a: 1\n", "a: 1\n"), true, "identical text");
    assertEqual(sg.sameContent("a: 1\nb: 2\n", "a: 1\r\nb: 2\r\n"), true, "CRLF is not a difference");
    assertEqual(sg.sameContent("﻿a: 1\n", "a: 1\n"), true, "BOM is not a difference");
    assertEqual(sg.sameContent("a: 'x'\nb: 2\n", 'b: 2\na: "x"\n'), true, "quoting and key order are not differences");
    assertEqual(sg.sameContent("a: 1\n", "a: 2\n"), false, "different value");
    assertEqual(sg.sameContent("a: [1\n", "a: 1\n"), false, "unparsable text that differs");

    // -----------------------------------------------------------------------
    // lineDiff
    // -----------------------------------------------------------------------
    assertEqual(sg.lineDiff("a\nb\nc\n", "a\r\nb\r\nc\r\n"), null, "equal text has no diff");
    assertEqual(
      sg.lineDiff("a\nb\nc\nd\n", "a\nB\nc\nd\n"),
      { line: 2, local: ["b"], remote: ["B"], truncated: false },
      "one changed line"
    );
    assertEqual(
      sg.lineDiff("a\nc\n", "a\nb\nc\n"),
      { line: 2, local: [], remote: ["b"], truncated: false },
      "line added on the server"
    );
    {
      const many = Array.from({ length: 30 }, (_, i) => `l${i}`).join("\n");
      const d = sg.lineDiff("top\n" + many, "top\nother");
      assertEqual([d.local.length, d.truncated], [20, true], "long diff is cut");
    }

    // -----------------------------------------------------------------------
    // compareTrees
    // -----------------------------------------------------------------------
    {
      const local = makeDir({
        "agent.mcs.yml": "kind: A\n",
        "topics/Same.mcs.yml": "a: 1\n",
        "topics/Edited.mcs.yml": "msg: new text\n",
        "topics/Dropped.mcs.yml": "kind: AdaptiveDialog\n",
        "topics/Quoted.mcs.yml": "a: 'x'\n",
        "icon.png": "PNGDATA",
        "notes.md": "my own notes",
        "evaluations/graders.eval.mcs.yml": "kind: EvaluationSet\n",
        "testcases/T.mcs.yml": "kind: TestCaseComponent\n",
        ".mcs/conn.json": "{\"local\":true}",
      });
      const server = makeDir({
        "agent.mcs.yml": "kind: A\n",
        "topics/Same.mcs.yml": "a: 1\n",
        "topics/Edited.mcs.yml": "msg: old text\n",
        "topics/Quoted.mcs.yml": 'a: "x"\n',
        "topics/FromPortal.mcs.yml": "kind: AdaptiveDialog\n",
        "icon.png": "PNGDATA",
        ".mcs/conn.json": "{\"server\":true}",
      });
      const r = sg.compareTrees(local, server);
      assertEqual(r.checked, 5, "compared files");
      assertEqual(r.differs.map((d) => d.file), ["topics/Edited.mcs.yml"], "in-place edit that did not arrive");
      assertEqual(r.differs[0].diff.local, ["msg: new text"], "diff shows the local line");
      assertEqual(r.differs[0].diff.remote, ["msg: old text"], "diff shows the server line");
      assertEqual(r.localOnly, ["topics/Dropped.mcs.yml"], "agent file the server does not have; notes.md and evaluation files are ignored");
      assertEqual(r.serverOnly, ["topics/FromPortal.mcs.yml"], "file only the server has");
    }

    // A changed binary file is a difference without a diff.
    {
      const r = sg.compareTrees(makeDir({ "icon.png": "AAA" }), makeDir({ "icon.png": "BBB" }));
      assertEqual(r.differs, [{ file: "icon.png", diff: null }], "binary difference");
    }

    // Identical trees.
    {
      const files = { "agent.mcs.yml": "kind: A\n", "topics/T.mcs.yml": "a: 1\n" };
      const r = sg.compareTrees(makeDir(files), makeDir(files));
      assertEqual([r.differs, r.localOnly, r.serverOnly, r.checked], [[], [], [], 2], "identical trees");
    }

    // -----------------------------------------------------------------------
    // buildPullPreview
    // -----------------------------------------------------------------------
    {
      const dir = makeDir({
        "topics/Both.mcs.yml": "msg: mine\n",
        "topics/BothSame.mcs.yml": "msg: same\n",
        "topics/ServerOnly.mcs.yml": "msg: untouched\n",
        "topics/LocalOnly.mcs.yml": "msg: local\n",
        "topics/Gone.mcs.yml": "msg: gone\n",
      });
      const serverText = {
        "topics/Both.mcs.yml": "msg: theirs\n",
        "topics/BothSame.mcs.yml": "msg: same\r\n",
        "topics/ServerOnly.mcs.yml": "msg: changed on server\n",
      };
      const change = (uri, changeType) => ({ uri, changeType, schemaName: `s.${uri}` });
      const calls = [];
      const p = await sg.buildPullPreview({
        agentDir: dir,
        localChanges: {
          localChanges: [
            change("topics/Both.mcs.yml", 1),
            change("topics/BothSame.mcs.yml", 1),
            change("topics/LocalOnly.mcs.yml", 1),
            change("topics/Gone.mcs.yml", 1),
          ],
        },
        remoteChanges: {
          localChanges: [
            change("topics/Both.mcs.yml", 1),
            change("topics/BothSame.mcs.yml", 1),
            change("topics/ServerOnly.mcs.yml", 1),
            change("topics/NewOnServer.mcs.yml", 0),
            change("topics/Gone.mcs.yml", 2),
          ],
          workflowResponse: [{}, {}],
        },
        fetchRemote: async (c) => {
          calls.push(c.uri);
          return serverText[c.uri] ?? null;
        },
        fetchBase: async () => "msg: base\n",
      });
      const byFile = Object.fromEntries(p.remote.map((e) => [e.file, e]));
      assertEqual(p.conflicts, ["topics/Both.mcs.yml", "topics/Gone.mcs.yml"], "conflicts: edited both sides, and server delete of an edited file");
      assertEqual(byFile["topics/Both.mcs.yml"].diff, { line: 1, local: ["msg: mine"], remote: ["msg: theirs"], truncated: false }, "conflict diff");
      assertEqual([byFile["topics/BothSame.mcs.yml"].bothSides, byFile["topics/BothSame.mcs.yml"].merge], [false, "same"], "same content on both sides is no conflict");
      assertEqual(byFile["topics/ServerOnly.mcs.yml"], { file: "topics/ServerOnly.mcs.yml", server: "modified", local: null, bothSides: false, merge: null }, "server-only change");
      assertEqual(byFile["topics/NewOnServer.mcs.yml"].server, "added", "added on the server");
      assertEqual(calls.includes("topics/ServerOnly.mcs.yml"), false, "no server read for a file with no local change");
      assertEqual(p.localOnly, [{ file: "topics/LocalOnly.mcs.yml", local: "modified" }], "local change the pull does not touch");
      assertEqual(p.workflows, 2, "workflow count passed through");
    }

    // Server copy cannot be read: the file counts as a conflict and carries the error.
    {
      const dir = makeDir({ "topics/X.mcs.yml": "a: 1\n" });
      const c = { uri: "topics/X.mcs.yml", changeType: 1, schemaName: "s.X" };
      const p = await sg.buildPullPreview({
        agentDir: dir,
        localChanges: { localChanges: [c] },
        remoteChanges: { localChanges: [c] },
        fetchRemote: async () => { throw new Error("boom"); },
      });
      assertEqual([p.conflicts, p.remote[0].error], [["topics/X.mcs.yml"], "could not read the server copy: boom"], "unreadable server copy");
    }

    // Three-way: different lines merge cleanly, the same line conflicts, no base is unknown.
    {
      const base = "a: 1\nb: 2\nc: 3\nd: 4\ne: 5\n";
      const c = { uri: "topics/M.mcs.yml", changeType: 1, schemaName: "s.M" };
      const run = async (localText, serverText, fetchBase) => {
        const dir = makeDir({ "topics/M.mcs.yml": localText });
        return sg.buildPullPreview({
          agentDir: dir,
          localChanges: { localChanges: [c] },
          remoteChanges: { localChanges: [c] },
          fetchRemote: async () => serverText,
          fetchBase,
        });
      };
      const getBase = async () => base;
      let p = await run("a: 1\nb: 2\nc: 3\nd: 4\ne: local\n", "a: server\nb: 2\nc: 3\nd: 4\ne: 5\n", getBase);
      assertEqual([p.remote[0].merge, p.bothSides, p.conflicts], ["clean", ["topics/M.mcs.yml"], []], "different lines merge cleanly");
      p = await run("a: 1\nb: 2\nc: mine\nd: 4\ne: 5\n", "a: 1\nb: 2\nc: theirs\nd: 4\ne: 5\n", getBase);
      assertEqual([p.remote[0].merge, p.conflicts], ["conflict", ["topics/M.mcs.yml"]], "same line conflicts");
      p = await run("a: 1\nb: 2\nc: 3\nd: 4\ne: local\n", "a: server\nb: 2\nc: 3\nd: 4\ne: 5\n", async () => null);
      assertEqual([p.remote[0].merge, p.bothSides.length, p.conflicts], ["unknown", 1, []], "no base copy: may or may not merge");
      p = await run("a: 1\nb: 2\nc: 3\nd: 4\ne: local\n", "a: server\nb: 2\nc: 3\nd: 4\ne: 5\n", async () => { throw new Error("no"); });
      assertEqual(p.remote[0].merge, "unknown", "base copy request fails: unknown");
      p = await run("a: 1\nb: 2\nc: 3\nd: 4\ne: 5\n", "a: 1\nb: 2\nc: 3\nd: 4\ne: 5\n", getBase);
      assertEqual(p.remote[0].merge, "same", "identical content");
    }
    assertEqual(sg.changedRanges(["a", "b", "c"], ["a", "b", "c"]), [], "no change, no range");
    assertEqual(sg.changedRanges(["a", "b", "c", "d", "e"], ["a", "X", "c", "d", "Y"]), [{ start: 1, end: 2 }, { start: 4, end: 5 }], "two separate edits stay two ranges");
    assertEqual(sg.changedRanges(["a", "c"], ["a", "b", "c"]), [{ start: 1, end: 1 }], "insertion is an empty range");
    assertEqual(sg.mergeConflicts("a\nb\nc\n", "a\nb\nc\nlocal\n", "top\na\nb\nc\n"), false, "insert at the end and at the start merge");

    // Empty results.
    {
      const p = await sg.buildPullPreview({
        agentDir: makeDir({}),
        localChanges: { localChanges: [] },
        remoteChanges: { localChanges: [] },
        fetchRemote: async () => null,
      });
      assertEqual([p.remote, p.conflicts, p.localOnly], [[], [], []], "nothing to pull");
    }

    // -----------------------------------------------------------------------
    // pushOutcome: a check after the push never changes the push result
    // -----------------------------------------------------------------------
    {
      const mismatch = { status: "mismatch", message: "x differs", differs: [] };
      const failed = { status: "error", error: "HTTP 404", message: "m" };
      let o = sg.pushOutcome({ ok: 1 }, { status: "verified", checked: 3 });
      assertEqual([o.output.status, o.exitCode, o.output.warnings], ["ok", 0, undefined], "verified push");
      o = sg.pushOutcome({ ok: 1 }, null);
      assertEqual([o.output.status, o.exitCode, "verification" in o.output], ["ok", 0, false], "check skipped");
      o = sg.pushOutcome({ ok: 1 }, mismatch);
      assertEqual([o.output.status, o.exitCode], ["ok", 0], "mismatch is a warning by default");
      assertEqual(/Do not push again without asking/.test(o.output.warnings[0]), true, "mismatch warning says not to push again");
      o = sg.pushOutcome({ ok: 1 }, mismatch, { strict: true });
      assertEqual([o.output.status, o.exitCode], ["unverified", 1], "mismatch with --verify fails");
      o = sg.pushOutcome({ ok: 1 }, failed);
      assertEqual([o.output.status, o.exitCode], ["ok", 0], "failed check keeps the push result");
      assertEqual(/Do not push again/.test(o.output.warnings[0]) && /HTTP 404/.test(o.output.warnings[0]), true, "failed check warning");
      o = sg.pushOutcome({ ok: 1 }, failed, { strict: true });
      assertEqual([o.output.status, o.exitCode], ["ok", 0], "failed check keeps the push result even with --verify");
    }

    // -----------------------------------------------------------------------
    // Flags that belong to one command, and the command that pull --dry-run runs
    // -----------------------------------------------------------------------
    {
      assertEqual(sg.flagError("pull", ["--dry-run", "--keep-backups"]), null, "pull takes --dry-run and --keep-backups");
      assertEqual(sg.flagError("push", ["--no-verify", "--verify"]), null, "push takes --no-verify and --verify");
      assertEqual(/--dry-run only works with pull, not with push/.test(sg.flagError("push", ["--dry-run"])), true, "push --dry-run is refused");
      assertEqual(sg.flagError("remote-changes", ["--dry-run"]) !== null, true, "remote-changes --dry-run is refused");
      assertEqual(sg.flagError("validate", ["--dry-run"]) !== null, true, "validate --dry-run is refused");
      assertEqual(sg.flagError("pull", ["--no-verify"]) !== null, true, "pull --no-verify is refused");
      assertEqual(sg.flagError("push", ["--keep-backups"]) !== null, true, "push --keep-backups is refused");
      assertEqual(sg.flagError("push", []), null, "no flags, no problem");

      const src = fs.readFileSync(path.join(__dirname, "..", "scripts", "src", "manage-agent.js"), "utf8");
      const a = src.indexOf("function resolveCommand(");
      const b = src.indexOf("function cmdDoctor(");
      const resolveCommand = eval("(" + src.slice(a, b).trim().replace(/^function resolveCommand/, "function") + ")");
      assertEqual(resolveCommand({ command: "pull", dryRun: true }), "remote-changes", "pull --dry-run runs remote-changes");
      assertEqual(resolveCommand({ command: "pull", dryRun: false }), "pull", "pull runs pull");
      assertEqual(resolveCommand({ command: "push", dryRun: false }), "push", "push runs push");

      // The real thing, through the bundle: refused before any sign-in or network call.
      const { spawnSync } = require("child_process");
      const bundle = path.join(__dirname, "..", "scripts", "manage-agent.bundle.js");
      const run = (...args) => spawnSync(process.execPath, [bundle, ...args], { encoding: "utf8" });
      let r = run("push", "--dry-run", "--workspace", path.join(root, "nowhere"));
      let out = null;
      try { out = JSON.parse(r.stdout); } catch { /* checked below */ }
      assertEqual([r.status, out && out.status, out && /--dry-run only works with pull/.test(out.error)], [1, "error", true], "bundle: push --dry-run exits 1 with an error");
      r = run("changes", "--dry-run", "--workspace", path.join(root, "nowhere"));
      assertEqual(r.status, 1, "bundle: changes --dry-run exits 1");
      r = run("pull", "--dry-run", "--workspace", path.join(root, "nowhere"));
      out = null;
      try { out = JSON.parse(r.stdout); } catch { /* checked below */ }
      assertEqual(out && /--dry-run/.test(out.error || ""), false, "bundle: pull --dry-run is not refused for its flag");
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }

  console.log(`${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
