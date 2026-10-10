/**
 * Tests for `manage-agent pack-copy`: a copy of an agent folder with only the
 * entries `pac copilot pack` accepts (microsoft/skills-for-copilot-studio#185).
 *
 * Set PAC_TEST_PATH to a pac 2.13 or later binary to also run the real pack.
 *
 * Run: node tests/pack-copy.test.js
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const bundle = path.join(__dirname, "..", "scripts", "manage-agent.bundle.js");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "pack-copy-test-"));
const home = path.join(root, "home");
fs.mkdirSync(home);
let counter = 0;

let passed = 0;
let failed = 0;
function assertEqual(actual, expected, label) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) passed++;
  else {
    failed++;
    console.error(`FAIL: ${label}\n  expected: ${e}\n  actual:   ${a}`);
  }
}

function write(file, text = "x: 1\n") {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

function makeWorkspace({ settings = true } = {}) {
  const ws = path.join(root, `ws-${++counter}`);
  write(path.join(ws, "agent.mcs.yml"));
  if (settings) write(path.join(ws, "settings.mcs.yml"));
  write(path.join(ws, "icon.png"), "png");
  write(path.join(ws, "topics", "Greeting.mcs.yml"));
  write(path.join(ws, "topics", "notes.txt"), "hi");
  write(path.join(ws, ".mcs", "conn.json"), "{}");
  write(path.join(ws, ".mcs", "botdefinition.json"), "{}");
  write(path.join(ws, "workflows", "MyFlow-1", "workflow.json"), "{}");
  write(path.join(ws, "knowledge", "k.mcs.yml"));
  write(path.join(ws, "README.md"), "hi");
  return ws;
}

function run(args) {
  const res = spawnSync(process.execPath, [bundle, "pack-copy", ...args], {
    encoding: "utf8",
    env: { PATH: path.dirname(process.execPath), HOME: home, USERPROFILE: home, SystemRoot: process.env.SystemRoot },
  });
  let json = null;
  try {
    json = JSON.parse(res.stdout);
  } catch {}
  return { status: res.status, json, stderr: res.stderr };
}

function listAll(dir, base = dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...listAll(p, base));
    else out.push(path.relative(base, p).split(path.sep).join("/"));
  }
  return out.sort();
}

// The accepted entries are copied, everything else is listed as left out.
{
  const ws = makeWorkspace();
  const out = path.join(root, "out-1");
  const r = run(["--workspace", ws, "--out", out]);
  assertEqual(r.status, 0, "pack-copy exits 0");
  assertEqual(r.json && r.json.status, "ok", "status ok");
  assertEqual(
    listAll(out),
    [".mcs/botdefinition.json", ".mcs/conn.json", "agent.mcs.yml", "icon.png", "settings.mcs.yml", "topics/Greeting.mcs.yml"],
    "only the accepted files are in the copy"
  );
  assertEqual(
    r.json && r.json.skipped,
    ["README.md", "knowledge/", "topics/notes.txt", "workflows/"],
    "the left-out entries are listed"
  );
  assertEqual(/Left out: .*workflows\//.test((r.json && r.json.message) || ""), true, "the message names workflows/");
  assertEqual(fs.existsSync(path.join(ws, "workflows", "MyFlow-1", "workflow.json")), true, "the source is untouched");
}

// Real pac, when PAC_TEST_PATH points to one: the original folder fails, the copy packs.
{
  const pac = process.env.PAC_TEST_PATH;
  if (pac) {
    const env = { ...process.env, DOTNET_NOLOGO: "1" };
    const ws = path.join(root, "pac-ws");
    const init = spawnSync(pac, ["copilot", "init", "--name", "zzt pack copy", "--publisher-prefix", "zzt", "--project-dir", ws], { encoding: "utf8", env });
    assertEqual(init.status, 0, "pac init makes a workspace");
    write(path.join(ws, "workflows", "MyFlow-1", "workflow.json"), "{}");
    write(path.join(ws, "knowledge", "k.mcs.yml"));
    write(path.join(ws, "README.md"), "hi");
    const bad = spawnSync(pac, ["copilot", "pack", "-pp", "zzt", "-pd", ws, "-op", path.join(root, "zip-bad")], { encoding: "utf8", env });
    assertEqual(bad.status !== 0 && /Unsupported (directory|file)/.test(bad.stdout + bad.stderr), true, "pac rejects the original folder");
    const out = path.join(root, "pac-out");
    assertEqual(run(["--workspace", ws, "--out", out]).status, 0, "pack-copy works on the pac workspace");
    const good = spawnSync(pac, ["copilot", "pack", "-pp", "zzt", "-pd", out, "-op", path.join(root, "zip-good")], { encoding: "utf8", env });
    assertEqual(good.status, 0, "pac packs the copy");
  } else {
    console.log("SKIP: PAC_TEST_PATH not set, real pac pack not run");
  }
}

// A non-empty target folder is refused and nothing is written into it.
{
  const ws = makeWorkspace();
  const out = path.join(root, "out-2");
  write(path.join(out, "keep.txt"), "mine");
  const r = run(["--workspace", ws, "--out", out]);
  assertEqual(r.status, 1, "a non-empty --out is refused");
  assertEqual(listAll(out), ["keep.txt"], "nothing is written into the refused folder");
}

// --out inside the agent folder is refused.
{
  const ws = makeWorkspace();
  const r = run(["--workspace", ws, "--out", path.join(ws, "pack")]);
  assertEqual(r.status, 1, "--out inside the agent folder is refused");
  assertEqual(fs.existsSync(path.join(ws, "pack")), false, "no folder is created inside the agent folder");
}

// Missing arguments and a missing settings file.
{
  const ws = makeWorkspace({ settings: false });
  assertEqual(run(["--workspace", ws]).status, 1, "--out is required");
  const out = path.join(root, "out-3");
  const r = run(["--workspace", ws, "--out", out]);
  assertEqual(r.status, 1, "a folder without settings.mcs.yml is refused");
  assertEqual(fs.existsSync(out), false, "no output folder is created for a refused source");
}

fs.rmSync(root, { recursive: true, force: true });
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
