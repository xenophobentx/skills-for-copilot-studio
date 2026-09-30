/**
 * Tests for findConflictMarkers — detects raw git-style merge markers that
 * `manage-agent pull` can write into .mcs.yml files.
 *
 * Run: node tests/conflict-markers.test.js
 */

// The scanner lives in the manage-agent source, which runs main() on load.
// Extract the real code (findMcsYmlFiles .. findConflictMarkers) and eval it.
const fs = require("fs");
const os = require("os");
const path = require("path");

const src = fs.readFileSync(
  path.join(__dirname, "..", "scripts", "src", "manage-agent.js"),
  "utf8"
);
const start = src.indexOf("function findMcsYmlFiles(");
const end = src.indexOf("function openFilesForDiagnostics(");
if (start === -1 || end === -1 || end < start) {
  console.error("Could not locate the scanner in scripts/src/manage-agent.js");
  process.exit(1);
}
eval(src.slice(start, end));

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

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

const root = fs.mkdtempSync(path.join(os.tmpdir(), "conflict-markers-"));
let n = 0;

// Write files (relative path -> content) into a fresh agent dir and scan it.
function scan(files) {
  const dir = path.join(root, `case${n++}`);
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, ...rel.split("/"));
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return findConflictMarkers(dir);
}

try {
  // -------------------------------------------------------------------------
  // Real markers
  // -------------------------------------------------------------------------

  assertEqual(
    scan({ "topics/A.mcs.yml": "a: 1\n<<<<<<< \nb: 2\n=======\nb: 3\n>>>>>>> \nc: 4\n" }),
    [{ file: "topics/A.mcs.yml", lines: [2, 4, 6] }],
    "markers, opener and closer with a trailing space, separator without"
  );

  assertEqual(
    scan({ "topics/A.mcs.yml": "<<<<<<<\nb: 2\n=======\nb: 3\n>>>>>>>" }),
    [{ file: "topics/A.mcs.yml", lines: [1, 3, 5] }],
    "markers without trailing space, no final newline"
  );

  assertEqual(
    scan({ "topics/A.mcs.yml": "a: 1\r\n<<<<<<< \r\nb: 2\r\n=======\r\nb: 3\r\n>>>>>>> \r\n" }),
    [{ file: "topics/A.mcs.yml", lines: [2, 4, 6] }],
    "CRLF line endings"
  );

  assertEqual(
    scan({ "topics/A.mcs.yml": "<<<<<<<\r\nx\r\n=======\r\ny\r\n>>>>>>>\r\n" }),
    [{ file: "topics/A.mcs.yml", lines: [1, 3, 5] }],
    "CRLF markers without trailing space"
  );

  assertEqual(
    scan({ "topics/A.mcs.yml": "﻿<<<<<<< HEAD\nx\n=======\ny\n>>>>>>> branch-name\n" }),
    [{ file: "topics/A.mcs.yml", lines: [1, 3, 5] }],
    "UTF-8 BOM before the first marker, git-style labels after the space"
  );

  // -------------------------------------------------------------------------
  // Look-alikes that must NOT match
  // -------------------------------------------------------------------------

  assertEqual(
    scan({
      "topics/A.mcs.yml": [
        'text: "a ======= b"',
        "  =======",            // indented
        "======",              // 6 chars
        "========",            // 8 chars
        "<<<<<<<x",            // no space after 7
        ">>>>>>>>",            // 8 chars
        "=======\t",           // tab is not a space
        "- =======",
        "key: <<<<<<<",
        "",
      ].join("\n"),
    }),
    [],
    "marker-like text inside strings, indented, wrong length or glued text"
  );

  assertEqual(scan({ "topics/A.mcs.yml": "" }), [], "empty file");
  assertEqual(scan({ "topics/A.mcs.yml": "kind: Dialog\n" }), [], "clean file");

  // -------------------------------------------------------------------------
  // File selection, nesting, ordering
  // -------------------------------------------------------------------------

  assertEqual(
    scan({
      "topics/B.mcs.yml": "=======\n",
      "topics/sub/deeper/C.mcs.yml": "ok: 1\n>>>>>>> \n",
      "agent.mcs.yml": "<<<<<<<\n",
      "topics/Clean.mcs.yml": "ok: 1\n",
    }),
    [
      { file: "agent.mcs.yml", lines: [1] },
      { file: "topics/B.mcs.yml", lines: [1] },
      { file: "topics/sub/deeper/C.mcs.yml", lines: [2] },
    ],
    "nested folders, relative forward-slash paths, sorted"
  );

  assertEqual(
    scan({
      ".mcs/state.mcs.yml": "<<<<<<<\n",
      "topics/notes.txt": "<<<<<<<\n",
      "topics/A.yml": "<<<<<<<\n",
      "topics/A.mcs.yml": "ok: 1\n",
    }),
    [],
    "skips .mcs/ and files that are not *.mcs.yml"
  );

  assertEqual(scan({}), [], "agent dir with no files");
  assertEqual(
    findConflictMarkers(path.join(root, "does-not-exist")),
    [],
    "missing directory"
  );
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
