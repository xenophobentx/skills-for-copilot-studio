/**
 * Tests for findYamlSyntaxErrors: the offline YAML parse that validate and
 * push run, because the language server accepts files that do not parse.
 *
 * Needs js-yaml from scripts/node_modules (run `npm ci` in scripts/). Without
 * it the test prints a SKIP line and exits 0, or exits 1 when CI is set.
 * Run: node tests/yaml-syntax.test.js
 */

// The scanner lives in the manage-agent source, which runs main() on load.
// Extract the real code (findMcsYmlFiles .. findYamlSyntaxErrors) and eval it.
const fs = require("fs");
const os = require("os");
const path = require("path");

let yaml;
try {
  yaml = require(path.join(__dirname, "..", "scripts", "node_modules", "js-yaml"));
} catch {
  console.log("SKIP: js-yaml not installed. Run `npm ci` in scripts/ first.");
  process.exit(process.env.CI ? 1 : 0);
}

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

const root = fs.mkdtempSync(path.join(os.tmpdir(), "yaml-syntax-"));
let n = 0;

// Write files (relative path -> content) into a fresh agent dir and scan it.
// Returns [{ file, line, column }] (the message text is js-yaml's).
function scan(files) {
  const dir = path.join(root, `case${n++}`);
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, ...rel.split("/"));
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return findYamlSyntaxErrors(dir).map(({ file, line, column }) => ({ file, line, column }));
}

try {
  // -------------------------------------------------------------------------
  // Files that do not parse
  // -------------------------------------------------------------------------

  assertEqual(
    scan({ "topics/A.mcs.yml": 'kind: Dialog\nname: "unclosed\nnext: 1\n' }),
    [{ file: "topics/A.mcs.yml", line: 4, column: 1 }],
    "unclosed double quote, reported where the parser gave up"
  );

  assertEqual(
    scan({ "topics/A.mcs.yml": "name: 'unclosed\n" }),
    [{ file: "topics/A.mcs.yml", line: 2, column: 1 }],
    "unclosed single quote"
  );

  assertEqual(
    scan({ "topics/A.mcs.yml": "a:\n  b: 1\n c: 2\n" }),
    [{ file: "topics/A.mcs.yml", line: 3, column: 2 }],
    "bad indentation"
  );

  assertEqual(
    scan({ "topics/A.mcs.yml": "a:\n\tb: 1\n" }),
    [{ file: "topics/A.mcs.yml", line: 2, column: 1 }],
    "tab indentation"
  );

  assertEqual(
    scan({ "topics/A.mcs.yml": "a: [1, 2\nb: 3\n" }),
    [{ file: "topics/A.mcs.yml", line: 2, column: 1 }],
    "unclosed flow sequence"
  );

  assertEqual(
    scan({ "topics/A.mcs.yml": "a: 1\r\nb: \"open\r\nc: 3\r\n" }),
    [{ file: "topics/A.mcs.yml", line: 4, column: 1 }],
    "CRLF line endings, unclosed quote"
  );

  assertEqual(
    scan({ "topics/A.mcs.yml": "\uFEFFa: 1\nb: [\n" }),
    [{ file: "topics/A.mcs.yml", line: 3, column: 1 }],
    "BOM does not shift line or column"
  );

  assertEqual(
    scan({ "topics/A.mcs.yml": "a: 1\n<<<<<<< HEAD\nb: 2\n=======\nb: 3\n>>>>>>> x\n" }),
    [],
    "a file with merge markers is not parsed, the marker scan reports it"
  );

  // -------------------------------------------------------------------------
  // Files that must pass
  // -------------------------------------------------------------------------

  assertEqual(scan({ "topics/A.mcs.yml": "" }), [], "empty file");
  assertEqual(scan({ "topics/A.mcs.yml": "kind: Dialog\n" }), [], "clean file");
  assertEqual(scan({ "topics/A.mcs.yml": "\uFEFFkind: Dialog\r\nname: x\r\n" }), [], "BOM and CRLF, clean");

  assertEqual(
    scan({ "topics/A.mcs.yml": "kind: Dialog\nkind: AdaptiveDialog\n" }),
    [],
    "duplicate key is left to the language server, which reports it itself"
  );

  assertEqual(
    scan({
      "topics/A.mcs.yml": [
        "# comment",
        'text: "a: b # not a comment"',
        "value: =If(Global.x = 1, \"a\", \"b\")",
        "multi: |",
        "  line one",
        "  line two",
        "list:",
        "  - a: 1",
        "    b: 2",
        "",
      ].join("\n"),
    }),
    [],
    "comments, Power Fx values, block scalars, nested lists"
  );

  // The real fixtures shipped with the repo must all parse.
  const fixtures = path.join(__dirname, "..", "evals", "fixtures");
  const count = findMcsYmlFiles(fixtures).length;
  assertEqual(count > 0, true, "evals/fixtures contains .mcs.yml files");
  assertEqual(findYamlSyntaxErrors(fixtures), [], "every .mcs.yml in evals/fixtures parses");

  // -------------------------------------------------------------------------
  // File selection, nesting, ordering
  // -------------------------------------------------------------------------

  assertEqual(
    scan({
      "topics/B.mcs.yml": "a: [\n",
      "topics/sub/deeper/C.mcs.yml": "ok: 1\nb: [\n",
      "agent.mcs.yml": "a: [\n",
      "topics/Clean.mcs.yml": "ok: 1\n",
    }),
    [
      { file: "agent.mcs.yml", line: 2, column: 1 },
      { file: "topics/B.mcs.yml", line: 2, column: 1 },
      { file: "topics/sub/deeper/C.mcs.yml", line: 3, column: 1 },
    ],
    "nested folders, relative forward-slash paths, sorted"
  );

  assertEqual(
    scan({
      ".mcs/state.mcs.yml": "a: [\n",
      "topics/notes.txt": "a: [\n",
      "topics/A.yml": "a: [\n",
      "topics/A.mcs.yml": "ok: 1\n",
    }),
    [],
    "skips .mcs/ and files that are not *.mcs.yml"
  );

  assertEqual(scan({}), [], "agent dir with no files");
  assertEqual(
    findYamlSyntaxErrors(path.join(root, "does-not-exist")),
    [],
    "missing directory"
  );

  // -------------------------------------------------------------------------
  // findLocalErrors: what validate adds to the LSP diagnostics
  // -------------------------------------------------------------------------

  function local(files) {
    const dir = path.join(root, `case${n++}`);
    for (const [rel, content] of Object.entries(files)) {
      const full = path.join(dir, ...rel.split("/"));
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, content);
    }
    return findLocalErrors(dir).map(({ file, line, column, source }) => ({ file, line, column, source }));
  }

  assertEqual(
    local({
      "topics/Conflict.mcs.yml": "a: 1\n<<<<<<< \nb: 2\n=======\nb: 3\n>>>>>>> \nc: [\n",
      "topics/Broken.mcs.yml": "a: [\n",
      "topics/Clean.mcs.yml": "ok: 1\n",
    }),
    [
      { file: "topics/Conflict.mcs.yml", line: 2, column: 1, source: "conflict-markers" },
      { file: "topics/Broken.mcs.yml", line: 2, column: 1, source: "yaml-syntax" },
    ],
    "markers first, one entry per file at the first marker, no parse error for the file with markers"
  );

  assertEqual(local({ "topics/Clean.mcs.yml": "ok: 1\n" }), [], "clean agent has no local errors");

  assertEqual(
    findLocalErrors(path.join(root, `case${n - 2}`))[0].message.startsWith("Unresolved merge conflict markers at lines 2, 4, 6."),
    true,
    "marker message lists all marker lines"
  );

  // The message comes from js-yaml, without its code snippet.
  const dir = path.join(root, "msg");
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, "A.mcs.yml"), "a:\n\tb: 1\n");
  const [first] = findYamlSyntaxErrors(dir);
  assertEqual(/tab/.test(first.message) && !first.message.includes("\n"), true, "message is one line and mentions the tab");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
