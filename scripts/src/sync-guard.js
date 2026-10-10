/**
 * sync-guard.js: Helpers that make pull and push safer:
 *   - a backup of the agent folder before every pull,
 *   - a preview of what a pull would change (remote-changes),
 *   - a comparison of the local folder with a fresh clone after a push.
 *
 * No LSP and no network in here. manage-agent.js does the calls and passes the data in.
 */

const fs = require("fs");
const path = require("path");
const yaml = require("js-yaml");

// Never copied, never compared: every dot folder (.mcs holds sync state and the
// backups themselves) and node_modules.
function skipDir(name) {
  return name.startsWith(".") || name === "node_modules";
}

const BACKUP_SUBDIR = path.join(".mcs", "backups");
const BACKUP_NAME_RE = /^(\d{8}-\d{6})(?:-(\d+))?$/;
const DEFAULT_KEEP_BACKUPS = 5;

const CHANGE_NAMES = { 0: "added", 1: "modified", 2: "deleted" };

function toPosix(p) {
  return p.split(path.sep).join("/");
}

// Relative posix paths of all files under dir, skipping SKIP_DIRS.
function listFiles(dir, rel = "") {
  let entries;
  try { entries = fs.readdirSync(path.join(dir, rel), { withFileTypes: true }); }
  catch { return []; }
  const files = [];
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (skipDir(entry.name)) continue;
      files.push(...listFiles(dir, rel ? `${rel}/${entry.name}` : entry.name));
    } else if (entry.isFile()) {
      files.push(rel ? `${rel}/${entry.name}` : entry.name);
    }
  }
  return files.sort();
}

function pad(n, width = 2) {
  return String(n).padStart(width, "0");
}

function backupStamp(d) {
  return (
    `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}-` +
    `${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`
  );
}

// "20261010-070509-10" sorts after "20261010-070509-2": stamp first, then the number.
function backupOrder(a, b) {
  const [sa, na] = BACKUP_NAME_RE.exec(a).slice(1);
  const [sb, nb] = BACKUP_NAME_RE.exec(b).slice(1);
  return sa < sb ? -1 : sa > sb ? 1 : Number(na || 1) - Number(nb || 1);
}

/**
 * Copy the agent folder (without .mcs and .git) to <agentDir>/.mcs/backups/<stamp>
 * and delete the oldest backups beyond `keep`. .mcs/.gitignore ignores everything,
 * so git does not see the backups. Returns { path, files, removed, restore }.
 */
function backupAgent(agentDir, { keep = DEFAULT_KEEP_BACKUPS, now = new Date() } = {}) {
  const root = path.join(agentDir, BACKUP_SUBDIR);
  fs.mkdirSync(root, { recursive: true });

  // Two backups in one second: the second gets -2, the third -3 (above every earlier one,
  // so pruning the oldest never makes a new name sort below a newer backup).
  const stamp = backupStamp(now);
  let name = stamp;
  const same = fs.readdirSync(root).map((n) => BACKUP_NAME_RE.exec(n)).filter((m) => m && m[1] === stamp);
  if (same.length > 0) name = `${stamp}-${Math.max(...same.map((m) => Number(m[2] || 1))) + 1}`;
  const dest = path.join(root, name);

  const files = listFiles(agentDir);
  for (const rel of files) {
    const target = path.join(dest, ...rel.split("/"));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(agentDir, ...rel.split("/")), target);
  }
  // An agent folder with no files still gets its (empty) backup folder.
  fs.mkdirSync(dest, { recursive: true });

  // Only folders that look like ours are ever deleted.
  const removed = [];
  const old = fs.readdirSync(root).filter((n) => BACKUP_NAME_RE.test(n)).sort(backupOrder);
  while (old.length > Math.max(keep, 1)) {
    const victim = old.shift();
    fs.rmSync(path.join(root, victim), { recursive: true, force: true });
    removed.push(victim);
  }

  return { path: dest, files: files.length, removed, restore: restoreText(dest, agentDir) };
}

// How to go back. The pull also moved the sync baseline in .mcs, so the old files
// come back as local edits: a push afterwards sends them and undoes the pull.
function restoreText(backupPath, agentDir, platform = process.platform) {
  const command =
    platform === "win32"
      ? `Copy-Item -Path "${backupPath}\\*" -Destination "${agentDir}" -Recurse -Force`
      : `cp -R "${backupPath}/." "${agentDir}"`;
  return (
    `To go back to the state before the pull, run: ${command} ` +
    "This overwrites what the pull brought in. A push after that sends your old version " +
    "and overwrites the server changes. Topics the server deleted come back and the push creates them again. " +
    "Files the pull added stay; delete them by hand."
  );
}

/**
 * backupAgent that never throws: a backup that cannot be made must not stop the pull.
 * keep 0 means no backup. Returns { backup, warning }.
 */
function tryBackup(agentDir, { keep = DEFAULT_KEEP_BACKUPS, now } = {}) {
  if (keep === 0) return { backup: null, warning: null };
  try {
    return { backup: backupAgent(agentDir, { keep, now }), warning: null };
  } catch (e) {
    return {
      backup: null,
      warning: `No backup was made (${e.message}). The pull went ahead without one. Use --keep-backups 0 to turn the backup off.`,
    };
  }
}

// How YAML text is read when two files are compared. manage-agent installs the
// validator's lenient reading, which takes an unquoted `a: b: c` that the service
// keeps and returns quoted.
let loadYaml = (text) => yaml.load(text, { json: true });
function useYamlLoader(fn) {
  loadYaml = fn;
}

function normalizeText(text) {
  return String(text).replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
}

/**
 * True when two files hold the same content. Line endings and a BOM do not count.
 * When the text differs, both sides are parsed as YAML and compared as data, so a
 * server that rewrites quoting or key spacing is not reported as a difference.
 */
function sameContent(a, b) {
  const x = normalizeText(a);
  const y = normalizeText(b);
  if (x === y) return true;
  try {
    const left = loadYaml(x);
    const right = loadYaml(y);
    return JSON.stringify(sortKeys(left)) === JSON.stringify(sortKeys(right));
  } catch {
    return false;
  }
}

function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    const out = {};
    for (const k of Object.keys(value).sort()) out[k] = sortKeys(value[k]);
    return out;
  }
  return value;
}

/**
 * The changed block between two texts, found by trimming the common lines at the start
 * and the end. Returns null when equal, else { line, local, remote, truncated }, with
 * `line` the 1-based line of the first difference.
 */
function lineDiff(localText, remoteText, maxLines = 20) {
  const a = normalizeText(localText).split("\n");
  const b = normalizeText(remoteText).split("\n");
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  if (start === endA && start === endB) return null;
  const local = a.slice(start, endA);
  const remote = b.slice(start, endB);
  return {
    line: start + 1,
    local: local.slice(0, maxLines),
    remote: remote.slice(0, maxLines),
    truncated: local.length > maxLines || remote.length > maxLines,
  };
}

const TEXT_EXT = /\.(ya?ml|json)$/i;
const NOT_CLONED = /^(testcases|evaluations)\/|\.eval\.mcs\.yml$/;

/**
 * Compare the agent folder with a fresh clone of the server (serverDir).
 * Returns { checked, differs: [{file, diff}], localOnly: [file], serverOnly: [file] }.
 * differs and localOnly mean the server does not hold what is on disk. Only
 * .mcs.yml files count as localOnly, and not the evaluation files.
 * serverOnly can be a file someone else added, so it is only reported.
 */
function compareTrees(localDir, serverDir) {
  const local = listFiles(localDir);
  const server = new Set(listFiles(serverDir));
  const localSet = new Set(local);
  const differs = [];
  const localOnly = [];
  let checked = 0;
  for (const rel of local) {
    if (!server.has(rel)) {
      // Notes or scripts a user keeps in the folder are not agent files. Evaluation
      // files are pushed as test cases, which a clone does not return (measured
      // with extension 1.9.14), so they would always look missing.
      if (rel.endsWith(".mcs.yml") && !NOT_CLONED.test(rel)) localOnly.push(rel);
      continue;
    }
    checked++;
    const mine = fs.readFileSync(path.join(localDir, ...rel.split("/")));
    const theirs = fs.readFileSync(path.join(serverDir, ...rel.split("/")));
    if (TEXT_EXT.test(rel)) {
      const text = mine.toString("utf8");
      const remoteText = theirs.toString("utf8");
      if (!sameContent(text, remoteText)) {
        differs.push({ file: rel, diff: lineDiff(text, remoteText) });
      }
    } else if (!mine.equals(theirs)) {
      differs.push({ file: rel, diff: null });
    }
  }
  const serverOnly = [...server].filter((rel) => !localSet.has(rel)).sort();
  return { checked, differs, localOnly, serverOnly };
}

const MAX_LCS_CELLS = 4000000;

/**
 * The line ranges of `base` that `other` changed, as [{ start, end, lines }] (end
 * exclusive, base line numbers from 0, `lines` what `other` has there). Uses a longest common subsequence; a file too large for
 * that gets one range from the first to the last changed line.
 */
function changedRanges(baseLines, otherLines) {
  const n = baseLines.length;
  const m = otherLines.length;
  let pre = 0;
  while (pre < n && pre < m && baseLines[pre] === otherLines[pre]) pre++;
  let post = 0;
  while (post < n - pre && post < m - pre && baseLines[n - 1 - post] === otherLines[m - 1 - post]) post++;
  const bn = n - pre - post;
  const om = m - pre - post;
  if (bn === 0 && om === 0) return [];
  if ((bn + 1) * (om + 1) > MAX_LCS_CELLS) {
    return [{ start: pre, end: n - post, lines: otherLines.slice(pre, m - post) }];
  }

  // lcs[i][j]: length of the common subsequence of the tails from i and j.
  const w = om + 1;
  const lcs = new Int32Array((bn + 1) * w);
  for (let i = bn - 1; i >= 0; i--) {
    for (let j = om - 1; j >= 0; j--) {
      lcs[i * w + j] =
        baseLines[pre + i] === otherLines[pre + j]
          ? lcs[(i + 1) * w + j + 1] + 1
          : Math.max(lcs[(i + 1) * w + j], lcs[i * w + j + 1]);
    }
  }
  const ranges = [];
  let i = 0;
  let j = 0;
  let open = null;
  while (i < bn || j < om) {
    if (i < bn && j < om && baseLines[pre + i] === otherLines[pre + j]) {
      if (open) { ranges.push(open); open = null; }
      i++; j++;
    } else {
      if (!open) open = { start: pre + i, end: pre + i, lines: [] };
      if (j < om && (i >= bn || lcs[i * w + j + 1] >= lcs[(i + 1) * w + j])) {
        open.lines.push(otherLines[pre + j]);
        j++;
      } else {
        i++;
        open.end = pre + i;
      }
    }
  }
  if (open) ranges.push(open);
  return ranges;
}

/**
 * Would a three-way merge of local and server against their common base need a
 * human? True when the two sides changed lines that overlap or touch.
 */
function mergeConflicts(baseText, localText, serverText) {
  const base = normalizeText(baseText).split("\n");
  const mine = changedRanges(base, normalizeText(localText).split("\n"));
  const theirs = changedRanges(base, normalizeText(serverText).split("\n"));
  const sameEdit = (a, b) =>
    a.start === b.start && a.end === b.end && a.lines.length === b.lines.length && a.lines.every((l, k) => l === b.lines[k]);
  // Both sides made the very same change there: nothing to merge by hand.
  return mine.some((a) => theirs.some((b) => a.start <= b.end && b.start <= a.end && !sameEdit(a, b)));
}

/**
 * What a pull would do, from the LSP's getLocalChanges and getRemoteChanges results.
 * fetchRemote(change) resolves to the server's text for that change, or null.
 * fetchBase(change) resolves to the text the last sync started from (getCachedFile),
 * or null when it is not available.
 * Each server change has `bothSides` (also changed here, with different content) and
 * `merge`: "clean" (different lines), "conflict" (same lines, a pull writes markers),
 * "same" (identical content), "unknown" (no base, may or may not merge cleanly), or
 * null (not changed here).
 * Returns { remote, localOnly, bothSides: [file], conflicts: [file], workflows, aiPrompts }.
 */
async function buildPullPreview({ localChanges, remoteChanges, agentDir, fetchRemote, fetchBase }) {
  const localList = (localChanges && localChanges.localChanges) || [];
  const remoteList = (remoteChanges && remoteChanges.localChanges) || [];
  const localByFile = new Map(localList.map((c) => [c.uri, c]));
  const remoteFiles = new Set(remoteList.map((c) => c.uri));

  const remote = [];
  const bothSides = [];
  const conflicts = [];
  for (const change of remoteList) {
    const mine = localByFile.get(change.uri);
    const entry = {
      file: change.uri,
      server: CHANGE_NAMES[change.changeType] || String(change.changeType),
      local: mine ? CHANGE_NAMES[mine.changeType] || String(mine.changeType) : null,
      bothSides: false,
      merge: null,
    };

    let localText = null;
    try { localText = fs.readFileSync(path.join(agentDir, ...change.uri.split("/")), "utf8"); }
    catch { /* not on disk */ }

    if (mine && change.changeType !== 2) {
      let serverText = null;
      try { serverText = await fetchRemote(change); }
      catch (e) { entry.error = `could not read the server copy: ${e.message}`; }
      if (serverText === null || serverText === undefined) {
        // Nothing to compare with: it may merge cleanly or not.
        entry.bothSides = true;
        entry.merge = "unknown";
        if (!entry.error) entry.error = "could not read the server copy";
      } else if (localText !== null) {
        entry.diff = lineDiff(localText, serverText);
        if (sameContent(localText, serverText)) {
          entry.merge = "same";
        } else {
          entry.bothSides = true;
          let baseText = null;
          if (fetchBase) {
            try { baseText = await fetchBase(change); } catch { /* unknown */ }
          }
          entry.merge = baseText === null || baseText === undefined
            ? "unknown"
            : mergeConflicts(baseText, localText, serverText) ? "conflict" : "clean";
        }
      } else {
        // Changed here and deleted locally, the server changed it: a pull has to ask.
        entry.bothSides = true;
        entry.merge = "conflict";
      }
    } else if (mine) {
      // Deleted on the server, changed or deleted here.
      entry.bothSides = mine.changeType !== 2;
      entry.merge = mine.changeType !== 2 ? "conflict" : "same";
    }
    if (entry.bothSides) bothSides.push(change.uri);
    if (entry.merge === "conflict") conflicts.push(change.uri);
    remote.push(entry);
  }

  const localOnly = localList
    .filter((c) => !remoteFiles.has(c.uri))
    .map((c) => ({ file: c.uri, local: CHANGE_NAMES[c.changeType] || String(c.changeType) }));

  return {
    remote,
    localOnly,
    bothSides,
    conflicts,
    workflows: ((remoteChanges && remoteChanges.workflowResponse) || []).length,
    aiPrompts: ((remoteChanges && remoteChanges.aiPromptResponse) || []).length,
  };
}

/**
 * The result of a push once the language server accepted it. A check after the push
 * never changes the push result: a mismatch or a failed check is a warning, exit 0.
 * Only `strict` (push --verify) turns a mismatch into "unverified", exit 1.
 * Returns { output, exitCode }.
 */
function pushOutcome(result, verification, { strict = false } = {}) {
  const output = { status: "ok", method: "powerplatformls/syncPush", result };
  let exitCode = 0;
  if (verification) {
    output.verification = verification;
    if (verification.status === "mismatch") {
      output.warnings = [
        "The push went through, but the server copy of some files differs from yours. " +
          "Tell the user which files differ. Do not push again without asking. " +
          verification.message,
      ];
      if (strict) {
        output.status = "unverified";
        exitCode = 1;
      }
    } else if (verification.status === "error") {
      output.warnings = [
        `The push went through. The check after it failed: ${verification.error}. ` +
          "Do not push again. Run verify later to compare the folder with the server.",
      ];
    }
  }
  return { output, exitCode };
}

// Flags that only make sense for some commands. Returns an error text or null.
const FLAG_COMMANDS = {
  "--dry-run": ["pull"],
  "--no-verify": ["push"],
  "--verify": ["push"],
  "--keep-backups": ["pull"],
};

function flagError(command, flagsSeen) {
  const seen = new Set(flagsSeen);
  if (seen.has("--verify") && seen.has("--no-verify")) {
    return "--verify and --no-verify contradict each other. Nothing was run. Use one of them.";
  }
  for (const flag of seen) {
    const allowed = FLAG_COMMANDS[flag];
    if (allowed && !allowed.includes(command)) {
      return (
        `${flag} only works with ${allowed.join(" or ")}, not with ${command}. ` +
        `Nothing was run.${flag === "--dry-run" ? " Use remote-changes or pull --dry-run to look before a pull; push has no dry run." : ""}`
      );
    }
  }
  return null;
}

module.exports = {
  backupAgent,
  buildPullPreview,
  changedRanges,
  compareTrees,
  flagError,
  lineDiff,
  listFiles,
  mergeConflicts,
  pushOutcome,
  restoreText,
  sameContent,
  tryBackup,
  useYamlLoader,
  DEFAULT_KEEP_BACKUPS,
  BACKUP_SUBDIR,
};
