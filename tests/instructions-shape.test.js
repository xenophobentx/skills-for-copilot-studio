/**
 * Tests for the instructions check of a classic agent.mcs.yml:
 *  - findInstructionsShapeErrors (what manage-agent validate adds to the
 *    language server's diagnostics, because the server reads an object or a
 *    list under instructions as empty and reports nothing)
 *  - the same rule in `schema-lookup.bundle.js validate`
 *
 * Needs js-yaml from scripts/node_modules (run `npm ci` in scripts/). Without
 * it the test prints a SKIP line and exits 0, or exits 1 when CI is set.
 * Run: node tests/instructions-shape.test.js
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

let yaml;
try {
  yaml = require(path.join(__dirname, "..", "scripts", "node_modules", "js-yaml"));
} catch {
  console.log("SKIP: js-yaml not installed. Run `npm ci` in scripts/ first.");
  process.exit(process.env.CI ? 1 : 0);
}

const ROOT = path.join(__dirname, "..");

// The checks live in the manage-agent source, which runs main() on load.
// Extract the real code (findMcsYmlFiles .. findLocalErrors) and eval it.
const src = fs.readFileSync(path.join(ROOT, "scripts", "src", "manage-agent.js"), "utf8");
const start = src.indexOf("function findMcsYmlFiles(");
const end = src.indexOf("function openFilesForDiagnostics(");
if (start === -1 || end === -1 || end < start) {
  console.error("Could not locate the checks in scripts/src/manage-agent.js");
  process.exit(1);
}
eval(src.slice(start, end));

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

function assertTrue(cond, label) {
  assertEqual(!!cond, true, label);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "instr-shape-"));
let n = 0;

function shape(files) {
  const dir = path.join(tmp, `case${n++}`);
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, ...rel.split("/"));
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return findInstructionsShapeErrors(dir).map(({ file, line }) => ({ file, line }));
}

const classic = (block) => ({
  "agent.mcs.yml": "kind: GptComponentMetadata\n" + block + "aISettings:\n  model:\n    modelNameHint: GPT55Chat\n",
});

try {
  // -------------------------------------------------------------------------
  // Shapes that pass
  // -------------------------------------------------------------------------
  const ok = (files, label) => assertEqual(shape(files), [], label);

  ok(classic("instructions: |\n  You are a helper.\n"), "block string");
  ok(classic("instructions: Be brief.\n"), "one-line string");
  ok(classic("instructions: |+\n  Keep the trailing newline.\n\n"), "block string, keep chomping");
  ok(classic("instructions:\n"), "empty instructions, as a new agent has it");
  ok(classic("instructions: ''\n"), "empty string");
  ok(classic(""), "no instructions key");
  // Plain scalars are text for the language server (TemplateLineNoKind), so they pass.
  ok(classic("instructions: 42\n"), "number");
  ok(classic("instructions: true\n"), "boolean");
  ok(classic("instructions: 2024-05-01\n"), "date");
  ok(classic("instructions: 1.5\n"), "float");
  ok({ "agent.mcs.yml": "kind: AgentDialog\ninstructions:\n  segments: []\n" }, "other kinds are not checked");
  ok({ "agents/Child/agent.mcs.yml": "kind: GptComponentMetadata\ninstructions:\n  segments: []\n" }, "only the agent.mcs.yml in the root is checked");
  ok({ "settings.mcs.yml": "configuration:\n  agentSettings:\n    instructions:\n      segments: []\n" }, "settings.mcs.yml is not checked");

  // -------------------------------------------------------------------------
  // Shapes that fail
  // -------------------------------------------------------------------------
  const bad = (block, label) => assertEqual(shape(classic(block)), [{ file: "agent.mcs.yml", line: 2 }], label);

  bad("instructions:\n  segments:\n    - kind: StaticSegment\n      value: Be brief.\n", "segments object (issue 175)");
  bad("instructions:\n  text: Be brief.\n", "object with text");
  bad("instructions:\n  - a\n  - b\n", "list");
  bad("instructions: {}\n", "empty flow mapping");
  bad("instructions: []\n", "empty flow list");

  // -------------------------------------------------------------------------
  // Files that cannot be judged
  // -------------------------------------------------------------------------
  ok({ "agent.mcs.yml": "kind: GptComponentMetadata\ninstructions: [\n" }, "does not parse: the syntax check reports it");
  ok(
    { "agent.mcs.yml": "kind: GptComponentMetadata\n<<<<<<< HEAD\ninstructions:\n  segments: []\n=======\ninstructions: x\n>>>>>>> y\n" },
    "merge markers: the marker check reports it"
  );
  ok({ "agent.mcs.yml": "" }, "empty file");
  assertEqual(findInstructionsShapeErrors(path.join(tmp, "does-not-exist")), [], "missing directory");

  // BOM and CRLF as the language server writes them.
  const crlf = "﻿kind: GptComponentMetadata\ninstructions:\n  segments: []\n".replace(/\n/g, "\r\n");
  assertEqual(shape({ "agent.mcs.yml": crlf }), [{ file: "agent.mcs.yml", line: 2 }], "BOM and CRLF, line of the key");

  // The fixtures shipped with the repo must pass.
  const fixtures = path.join(ROOT, "evals", "fixtures");
  for (const d of fs.readdirSync(fixtures)) {
    const dir = path.join(fixtures, d);
    if (fs.statSync(dir).isDirectory()) assertEqual(findInstructionsShapeErrors(dir), [], `fixture ${d}`);
  }

  // findLocalErrors reports it with its own source.
  const dirLocal = path.join(tmp, "local");
  fs.mkdirSync(dirLocal);
  fs.writeFileSync(path.join(dirLocal, "agent.mcs.yml"), "kind: GptComponentMetadata\ninstructions:\n  text: Be brief.\n");
  assertEqual(
    findLocalErrors(dirLocal).map(({ file, source, column }) => ({ file, source, column })),
    [{ file: "agent.mcs.yml", source: "instructions-shape", column: 1 }],
    "findLocalErrors source"
  );

  // -------------------------------------------------------------------------
  // schema-lookup.bundle.js validate
  // -------------------------------------------------------------------------
  const bundle = path.join(ROOT, "scripts", "schema-lookup.bundle.js");
  function validateAgent(block) {
    const f = path.join(tmp, `agent${n++}.mcs.yml`);
    fs.writeFileSync(f, "kind: GptComponentMetadata\ndisplayName: A\n" + block);
    const r = spawnSync(process.execPath, [bundle, "validate", f], { encoding: "utf8", timeout: 30000 });
    return { code: r.status, out: (r.stdout || "") + (r.stderr || "") };
  }

  for (const [block, label] of [
    ["instructions: |\n  You are a helper.\n", "string"],
    ["instructions: 42\n", "number"],
    ["instructions: true\n", "boolean"],
    ["instructions: 2024-05-01\n", "date"],
  ]) {
    const v = validateAgent(block);
    assertTrue(!/\[FAIL\]/.test(v.out), `schema-lookup validate: ${label} instructions has no FAIL`);
    assertTrue(/\[PASS\] Required 'instructions' property present/.test(v.out), `schema-lookup validate: ${label} instructions is present`);
  }

  for (const [block, label] of [
    ["instructions:\n  segments:\n    - kind: StaticSegment\n      value: x\n", "object"],
    ["instructions:\n  - a\n", "list"],
  ]) {
    const v = validateAgent(block);
    assertTrue(/\[FAIL\] 'instructions' must be a string/.test(v.out), `schema-lookup validate: ${label} instructions fails`);
    assertTrue(v.code !== 0, `schema-lookup validate: ${label} instructions exits non-zero`);
    assertTrue(!/\[PASS\] Required 'instructions' property present/.test(v.out), `schema-lookup validate: no PASS line after the FAIL (${label})`);
    assertTrue(!/settings\.mcs\.yml|CLI/.test(v.out.split("[FAIL]")[1] || ""), `schema-lookup validate: message does not point at another file (${label})`);
  }

  // The message of the manage-agent check does not point at another file either.
  const msgDir = path.join(tmp, "msg");
  fs.mkdirSync(msgDir);
  fs.writeFileSync(path.join(msgDir, "agent.mcs.yml"), "kind: GptComponentMetadata\ninstructions:\n  text: x\n");
  const msg = findInstructionsShapeErrors(msgDir)[0].message;
  assertTrue(!/settings\.mcs\.yml|CLI/.test(msg), "manage-agent message does not point at another file");
  assertTrue(msg.endsWith("(instructions: |)."), "manage-agent message ends with the fix");
} finally {
  // Only the folder this test created.
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
