/**
 * Tests for how chat-with-agent reads the message: one positional argument, or
 * --message-file. Windows PowerShell 5.1 splits an argument with embedded double
 * quotes into several, so more than one message argument must be an error that
 * points to --message-file instead of sending only a fragment.
 *
 * Run: node tests/chat-message-args.test.js
 */

// parseArgs lives in the chat-with-agent source, which runs main() on load, so
// pull the functions out of the source text instead of requiring it.
const fs = require("fs");
const os = require("os");
const path = require("path");

const src = fs.readFileSync(path.join(__dirname, "..", "scripts", "src", "chat-with-agent.js"), "utf8");

function extract(name) {
  const start = src.search(new RegExp(`^(?:async )?function ${name}\\(`, "m"));
  if (start === -1) throw new Error(`function ${name} not found in chat-with-agent.js`);
  const end = src.indexOf("\n}\n", start);
  return src.slice(start, end + 3);
}

// die() normally prints JSON and exits; here it throws so a test can read the message
function die(msg) {
  throw new Error(msg);
}
eval(["splitMessageError", "readMessageFile", "parseArgs"].map(extract).join("\n"));

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

function assertThrows(fn, pattern, label) {
  try {
    fn();
  } catch (e) {
    if (pattern.test(e.message)) {
      passed++;
    } else {
      failed++;
      console.error(`FAIL: ${label}\n  message did not match ${pattern}: ${e.message}`);
    }
    return;
  }
  failed++;
  console.error(`FAIL: ${label}\n  did not throw`);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "chat-msg-"));
function write(name, bytes) {
  const file = path.join(tmp, name);
  fs.writeFileSync(file, bytes);
  return file;
}

// ---------------------------------------------------------------------------
// One positional message
// ---------------------------------------------------------------------------

assertEqual(parseArgs(["hello world"]).utterance, "hello world", "single positional message");
assertEqual(parseArgs(['Mi a "kedvenc" szine?']).utterance, 'Mi a "kedvenc" szine?', "message with embedded quotes");
{
  const p = parseArgs(["hi", "--client-id", "abc", "--conversation-id", "c1"]);
  assertEqual([p.utterance, p.clientId, p.conversationId], ["hi", "abc", "c1"], "flag values are not taken for the message");
}
assertEqual(parseArgs(["--client-id", "abc", "hi"]).utterance, "hi", "message after flags");
assertEqual(parseArgs(["--detect-only"]).detectOnly, true, "--detect-only needs no message");
assertThrows(() => parseArgs([]), /Missing utterance/, "no message");

// ---------------------------------------------------------------------------
// Split message (what Windows PowerShell 5.1 hands over)
// ---------------------------------------------------------------------------

assertThrows(() => parseArgs(["Say hello", "world to me"]), /2 separate message arguments/, "two message arguments");
assertThrows(() => parseArgs(["Say hello", "world to me"]), /--message-file <path>/, "split error suggests --message-file");
assertThrows(() => parseArgs(["a", "--client-id", "x", "b"]), /2 separate message arguments/, "split around a flag");

// ---------------------------------------------------------------------------
// --message-file
// ---------------------------------------------------------------------------

const quoted = 'Mi a "kedvenc szine" van? árvíztűrő tükörfúrógép';
assertEqual(parseArgs(["--message-file", write("plain.txt", quoted)]).utterance, quoted, "reads UTF-8 with quotes and accents");
assertEqual(parseArgs(["--message-file", write("bom.txt", "﻿" + quoted)]).utterance, quoted, "strips a UTF-8 BOM");
assertEqual(parseArgs(["--message-file", write("crlf.txt", quoted + "\r\n")]).utterance, quoted, "strips one trailing newline");
assertEqual(parseArgs(["--message-file", write("multi.txt", "line 1\nline 2\n")]).utterance, "line 1\nline 2", "keeps inner newlines");
assertEqual(parseArgs(["--message-file", write("p.txt", "hi"), "--client-id", "abc"]).clientId, "abc", "--message-file with other flags");
assertThrows(() => parseArgs(["--message-file", path.join(tmp, "missing.txt")]), /Cannot read --message-file/, "missing file");
assertThrows(() => parseArgs(["--message-file", write("empty.txt", "﻿\n")]), /is empty/, "empty file");
assertThrows(() => parseArgs(["--message-file"]), /needs a path/, "--message-file without a path");
assertThrows(() => parseArgs(["hi", "--message-file", write("q.txt", "x")]), /either as an argument or with --message-file/, "both argument and file");

fs.rmSync(tmp, { recursive: true, force: true });

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

console.log(`${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
