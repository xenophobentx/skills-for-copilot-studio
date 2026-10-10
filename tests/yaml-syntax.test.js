/**
 * Tests for findYamlSyntaxErrors: the offline YAML parse that validate and
 * push run, because the language server accepts files that do not parse.
 * Unquoted values that the service writes itself and keeps (`description:
 * Text: more text`) are warnings, not errors; the corpus section at the end
 * lists every case with the measured behaviour of the language server.
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

  // -------------------------------------------------------------------------
  // Corpus: what a strict parser (js-yaml) says, what the language server 1.9.14
  // said, and what the check does. "lsp" and "roundTrip" record the live
  // measurements of 2026-10-10 on the throwaway agent (evidence/yaml-lenient).
  // -------------------------------------------------------------------------

  // A small topic. Each case changes one line.
  function topic(n, o = {}) {
    const desc = o.desc !== undefined ? o.desc : "Probe topic for the YAML corpus";
    const text = o.text !== undefined ? o.text : `ZZLMARK${n} reply`;
    const trig = o.trig !== undefined ? o.trig : `      - zzl${n} trigger phrase`;
    const idLine = o.idLine !== undefined ? o.idLine : "  id: main";
    const dn = o.dn !== undefined ? o.dn : `Zzl${n}`;
    return `mcs.metadata:
  componentName: Zzl${n}
  description: ${desc}
kind: AdaptiveDialog
beginDialog:
  kind: OnRecognizedIntent
${idLine}
  intent:
    displayName: ${dn}
    triggerQueries:
${trig}

  actions:
    - kind: SendActivity
      id: sendMessage_zz${n}
      activity:
        text:
          - ${text}
${o.extra || ""}`;
  }

  // expect: "ok" | { warn: [problem text] } | { error: [line, column] }
  // lsp: what validate reported for the file (none, or the error)
  // roundTrip: push and fresh clone: kept | requoted | comment stripped | emptied | corrupted | not pushed (LSP error) | stored as sent
  const corpus = [
    ["00", "valid topic", topic("00"), "ok", "none", "stored as sent"],
    ["01", "colon-space in plain value (metadata)", topic("01", { desc: "Text: more text" }), { warn: ['contains ": "'] }, "none", "kept, requoted"],
    ["02", "colon-space in a reply text list item (valid YAML, a mapping)", topic("02", { text: "ZZLMARK02 Hello: how are you" }), "ok", "none", "stored as sent"],
    ["03", "colon-space in a trigger phrase (valid YAML, a mapping)", topic("03", { trig: "      - zzl03 what is this: a question" }), "ok", "none", "stored as sent"],
    ["04", "space-hash after a value (a comment)", topic("04", { desc: "Use this # to comment" }), "ok", "warning: inline #", "comment stripped"],
    ["05", "hash glued to a word", topic("05", { desc: "Written in C#5 tracked" }), "ok", "none", "kept, requoted"],
    ["06", "unclosed double quote to the end of the file", topic("06", { desc: '"This topic is not closed' }), { error: [19, 1] }, "error: Unterminated quoted scalar", "not pushed (LSP error)"],
    ["07", "unclosed single quote to the end of the file", topic("07", { desc: "'This topic is not closed" }), { error: [19, 1] }, "error: Unterminated quoted scalar", "not pushed (LSP error)"],
    ["08", "key dedented by one space", topic("08", { idLine: "   id: main" }), { error: [7, 6] }, "error: Missing required property", "not pushed (LSP error)"],
    ["09", "tab as indentation", topic("09", { idLine: "\tid: main" }), { error: [7, 1] }, "error: Tabs are not allowed", "not pushed (LSP error)"],
    ["10", "tab after the colon", topic("10", { desc: "\tTab separated" }), "ok", "none", "kept, tab dropped"],
    ["11", "unclosed flow sequence in a trigger list", topic("11", { trig: "      [zzl11 one, zzl11 two" }), { error: [13, 3] }, "none", "stored as sent"],
    ["12", "duplicate key at the top level", topic("12", { extra: "kind: AdaptiveDialog\n" }), "ok", "error: Duplicate key", "not pushed (LSP error)"],
    ["13", "duplicate key in the metadata", topic("13", { desc: "first\n  description: second" }), "ok", "error: Duplicate key", "not pushed (LSP error)"],
    ["14", "unclosed flow mapping as a value (metadata)", topic("14", { desc: "{a: b" }), { error: [4, 1] }, "none", "kept as a string, requoted"],
    ["15", "value starting with @ (metadata)", topic("15", { desc: "@mention in description" }), { warn: ['starts with "@"'] }, "none", "kept, requoted"],
    ["16", "value starting with a backtick (metadata)", topic("16", { desc: "`code` in description" }), { warn: ['starts with "`"'] }, "none", "kept, requoted"],
    ["17", "value starting with * (undefined alias, metadata)", topic("17", { desc: "*undefined" }), { warn: ['starts with "*"'] }, "none", "kept, requoted"],
    ["18", "value starting with ! (unknown tag, metadata)", topic("18", { desc: "!foo bar" }), { warn: ['starts with "!"'] }, "none", "kept, requoted"],
    ["19", "text after a closing double quote (metadata)", topic("19", { desc: '"quoted" extra' }), { error: [3, 25] }, "none", "emptied (dialog lost, description cut)"],
    ["20", "apostrophe inside single quotes (metadata)", topic("20", { desc: "'it's broken'" }), { error: [3, 20] }, "none", "emptied (dialog lost, description cut)"],
    ["21", "invalid escape in double quotes (metadata)", topic("21", { desc: '"C:\\path\\file"' }), { error: [3, 20] }, "none", "kept literally"],
    ["22", "line without a colon inside a mapping", topic("22", { desc: "ok\n  just words here" }), { error: [4, 18] }, "none", "line dropped silently"],
    ["23", "second document after ---", topic("23", { extra: "---\nkind: Other\n" }), { error: [1, 1] }, "none", "stored as sent"],
    ["24", "trailing colon in a plain value (metadata)", topic("24", { desc: "Text:" }), { warn: ['ends with ":"'] }, "none", "kept, requoted"],
    ["25", "colon without a space (10:30)", topic("25", { desc: "Meeting at 10:30 today" }), "ok", "none", "stored as sent"],
    ["26", "value starting with % (metadata)", topic("26", { desc: "%value here" }), { warn: ['starts with "%"'] }, "none", "kept, requoted"],
    ["27", "block scalar with unindented content", topic("27", { desc: "|\nunindented line" }), { error: [5, 5] }, "none", "corrupted (description empty, dialog shifted)"],
    ["28", "colon-space and double quotes in a plain value", topic("28", { desc: 'He said: "hi"' }), { warn: ['contains ": "'] }, "none", "kept, requoted"],
    ["29", "value starting with dash-space (metadata)", topic("29", { desc: "- leading dash" }), { warn: ['starts with "- "'] }, "none", "kept, requoted"],
    ["30", "Power Fx braces at the start of a reply", topic("30", { text: "{Topic.UserName} ZZLMARK30 you said hi" }), { error: [18, 30] }, "error: Identifier not recognized", "not pushed (LSP error)"],
    ["31", "unclosed flow sequence as a value (metadata)", topic("31", { desc: "[not a list" }), { error: [4, 1] }, "none", "kept as a string, requoted"],
    ["32", "service style description with colon-space", topic("32", { desc: "Részletes leírás: mit tapasztal a felhasználó" }), { warn: ['contains ": "'] }, "none", "kept, requoted"],
    ["33", "unclosed double quote closed by a later quote", topic("33", { desc: '"Open here', text: 'ZZLMARK33 says "hi" now' }), { error: [18, 29] }, "none", "emptied"],
    ["34", "unclosed single quote closed by a later apostrophe", topic("34", { desc: "'Open here", text: "ZZLMARK34 it's fine" }), { error: [18, 26] }, "none", "emptied"],
    ["35", "apostrophe inside a plain value", topic("35", { desc: "It's a plain apostrophe" }), "ok", "none", "stored as sent"],
    ["36", "quoted value with colon-space", topic("36", { desc: '"Text: more text"' }), "ok", "none", "stored as sent"],
    // The same values in the dialog body (intent.displayName). The body is stored as sent.
    ["01b", "colon-space in plain value (body)", topic("01b", { dn: "Text: more text" }), { warn: ['contains ": "'] }, "none", "stored as sent"],
    ["06b", "unclosed double quote (body)", topic("06b", { dn: '"Open here' }), { error: [19, 1] }, "error: Unterminated quoted scalar", "not pushed (LSP error)"],
    ["07b", "unclosed single quote (body)", topic("07b", { dn: "'Open here" }), { error: [19, 1] }, "error: Unterminated quoted scalar", "not pushed (LSP error)"],
    ["14b", "unclosed flow mapping (body)", topic("14b", { dn: "{a: b" }), { error: [10, 5] }, "none", "stored as sent"],
    ["15b", "value starting with @ (body)", topic("15b", { dn: "@mention here" }), { warn: ['starts with "@"'] }, "none", "stored as sent"],
    ["16b", "value starting with a backtick (body)", topic("16b", { dn: "`code` here" }), { warn: ['starts with "`"'] }, "none", "stored as sent"],
    ["17b", "value starting with * (body)", topic("17b", { dn: "*undefined" }), { warn: ['starts with "*"'] }, "none", "stored as sent"],
    ["18b", "value starting with ! (body)", topic("18b", { dn: "!foo bar" }), { warn: ['starts with "!"'] }, "none", "stored as sent"],
    ["19b", "text after a closing double quote (body)", topic("19b", { dn: '"quoted" extra' }), { error: [9, 27] }, "none", "stored as sent"],
    ["20b", "apostrophe inside single quotes (body)", topic("20b", { dn: "'it's broken'" }), { error: [9, 22] }, "none", "stored as sent"],
    ["21b", "invalid escape in double quotes (body)", topic("21b", { dn: '"C:\\path\\file"' }), { error: [9, 22] }, "none", "stored as sent"],
    ["24b", "trailing colon (body)", topic("24b", { dn: "Text:" }), { warn: ['ends with ":"'] }, "none", "stored as sent"],
    ["26b", "value starting with % (body)", topic("26b", { dn: "%value here" }), { warn: ['starts with "%"'] }, "none", "stored as sent"],
    ["28b", "colon-space and double quotes (body)", topic("28b", { dn: 'He said: "hi"' }), { warn: ['contains ": "'] }, "none", "stored as sent"],
    ["29b", "value starting with dash-space (body)", topic("29b", { dn: "- leading dash" }), { warn: ['starts with "- "'] }, "none", "stored as sent"],
    ["31b", "unclosed flow sequence (body)", topic("31b", { dn: "[not a list" }), { error: [10, 5] }, "none", "stored as sent"],
  ];

  for (const [id, name, text, expect] of corpus) {
    const result = checkYamlText(text);
    const label = `corpus ${id}: ${name}`;
    let strictOk = true;
    try { yaml.load(text, { json: true }); } catch { strictOk = false; }
    if (expect === "ok") {
      assertEqual([result.error, result.warnings], [null, []], `${label} -> no error, no warning`);
    } else if (expect.warn) {
      assertEqual(strictOk, false, `${label} -> a strict parser rejects it`);
      assertEqual(result.error, null, `${label} -> no error`);
      assertEqual(
        result.warnings.map((w) => w.message.match(/^Unquoted value (.*?)\. /)[1]),
        expect.warn,
        `${label} -> one warning with the reason`
      );
    } else {
      assertEqual(strictOk, false, `${label} -> a strict parser rejects it`);
      assertEqual(result.error && [result.error.line, result.error.column], expect.error, `${label} -> error at line and column`);
      assertEqual(result.warnings, [], `${label} -> no warnings next to an error`);
    }
  }

  // Warnings: file, line and column are those of the value, forward slashes
  const warnDir = path.join(root, `warn${n++}`);
  fs.mkdirSync(path.join(warnDir, "capabilities", "tools"), { recursive: true });
  fs.writeFileSync(
    path.join(warnDir, "capabilities", "tools", "t.mcs.yml"),
    "kind: WorkflowTool\ntoolInputs:\n  - name: a\n    description: Részletes leírás: mit próbáltak már.\n  - name: b\n    description: \"Kategória: Identity\"\n  - name: c\n    description: Plain # comment: here\n"
  );
  assertEqual(findYamlSyntaxErrors(warnDir), [], "service-written tool file: no error");
  assertEqual(
    findYamlLenientWarnings(warnDir).map(({ file, line, column }) => ({ file, line, column })),
    [{ file: "capabilities/tools/t.mcs.yml", line: 4, column: 18 }],
    "service-written tool file: one warning at the value (a ': ' after a # comment is not a problem)"
  );
  assertEqual(
    findLocalWarnings(warnDir).map(({ line, source }) => ({ line, source })),
    [{ line: 4, source: "yaml-lenient" }],
    "findLocalWarnings: source yaml-lenient"
  );
  assertEqual(findLocalErrors(warnDir), [], "a warning is not a local error");
  assertEqual(findYamlLenientWarnings(warnDir).map((x) => x.reason), ['contains ": "'], "warning carries the short reason for the push log");

  // Several tolerated lines, CRLF and BOM keep their line numbers
  assertEqual(
    checkYamlText("\uFEFFa: x: 1\r\nb: ok\r\nc:\r\n  - d: y: 2\r\n").warnings.map((x) => x.line),
    [1, 4],
    "two unquoted values, CRLF and BOM"
  );
  // A tolerated line next to a real error: the error wins and is reported at its own line
  assertEqual(
    checkYamlText("a: x: 1\nb:\n  c: 1\n d: 2\n"),
    { error: { line: 4, column: 2, message: "bad indentation of a mapping entry" }, warnings: [] },
    "tolerated line plus bad indentation: error only"
  );
  // The line is not relaxed when the problem is the indentation, not the value
  assertEqual(checkYamlText("a:\n  b: 1\n c: x: 2\n").error.line, 3, "bad indentation is still an error when the value has a colon");
  // An unclosed quote anywhere in the file switches the leniency off
  assertEqual(
    checkYamlText('a: x: 1\nb: "open\nc: 3\n').error !== null,
    true,
    "unclosed quote and a tolerated line: still an error"
  );
  assertEqual(
    checkYamlText("a: x: 1\nb: 'open\nc: it's\n").error !== null,
    true,
    "unclosed single quote and a tolerated line: still an error"
  );
  // F1: an anchor or a tag before the opening quote must not hide the unclosed quote.
  // The relaxed line below would otherwise close the dangling quote.
  assertEqual(
    checkYamlText('a:\n  description: &x "Open here\n  b: c\nd:\n  - text: Note: he said "hi" now\n').error !== null,
    true,
    "anchor before an unclosed double quote: still an error"
  );
  assertEqual(
    checkYamlText('a:\n  description: !!str "Open here\n  b: c\nd:\n  - text: Note: he said "hi" now\n').error !== null,
    true,
    "tag before an unclosed double quote: still an error"
  );
  assertEqual(
    checkYamlText("a:\n  description: &x 'Open here\n  b: c\nd:\n  - text: Note: it's here\n").error !== null,
    true,
    "anchor before an unclosed single quote: still an error"
  );

  // F2: a block scalar header with nothing indented under it, followed by a
  // dedented line with two colons. The service takes the line as the block
  // content (corpus 27), so it stays an error as on main.
  assertEqual(
    checkYamlText("mcs.metadata:\n  description: |\nNote: see: x\nkind: AdaptiveDialog\n").error !== null,
    true,
    "empty block scalar then a dedented 'Note: see: x': error"
  );
  assertEqual(
    checkYamlText("mcs.metadata:\n  description: >-\nNote: see: x\nkind: AdaptiveDialog\n").error !== null,
    true,
    "empty folded block scalar then a dedented 'Note: see: x': error"
  );
  assertEqual(
    checkYamlText("a:\n  b: 1\n c: x: 2\n").error !== null,
    true,
    "two colons on a badly indented line: error"
  );
  // A block with content, ended by a normal key line, is not the empty-block case.
  assertEqual(
    checkYamlText("a:\n  text: |\n    line one\n  note: see: x\n").warnings.map((x) => x.line),
    [4],
    "block scalar with content, then a key line with a colon: warning"
  );

  // F3: a wrapped quote inside a block scalar is text and does not switch the leniency off.
  assertEqual(
    checkYamlText(
      [
        "kind: Settings",
        "instructions: |",
        '  Footer: "This article is wrapped and',
        '  continues here."',
        "  Don't forget the apostrophe.",
        "description: Text: more text",
        "",
      ].join("\n")
    ),
    {
      error: null,
      warnings: [{
        line: 6,
        column: 14,
        reason: 'contains ": "',
        message: 'Unquoted value contains ": ". The service keeps it as plain text, but a strict YAML parser rejects it. Put the value in quotes to make the file valid YAML.',
      }],
    },
    "wrapped quote inside a | block: only the warning"
  );
  assertEqual(
    checkYamlText("instructions: >\n  a 'quote that\n  wraps\nb: x\nd: 'open\ne: y: z\n").error !== null,
    true,
    "an unclosed quote after a block scalar still switches the leniency off"
  );

  // F4: the column points at the value, also with several spaces or a tab after the colon.
  assertEqual(checkYamlText("a:   x: 1\n").warnings.map((x) => x.column), [6], "column with three spaces");
  assertEqual(checkYamlText("a:\tx: 1\n").warnings.map((x) => x.column), [4], "column with a tab");
  assertEqual(checkYamlText("- a: x: 1\n").warnings.map((x) => x.column), [6], "column after a list dash");
  // F5: a trailing colon has its own reason.
  assertEqual(checkYamlText("a: Text:\n").warnings.map((x) => x.reason), ['ends with ":"'], "trailing colon reason");
  assertEqual(checkYamlText("a: x: y:\n").warnings.map((x) => x.reason), ['contains ": "'], "colon-space wins over trailing colon");

  // Quoted and block values are never relaxed
  assertEqual(checkYamlText('a: "x" y: 1\n').error !== null, true, "text after a closing quote is an error");
  assertEqual(checkYamlText("a: [x: 1\n").error !== null, true, "unclosed flow sequence with colon is an error");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
