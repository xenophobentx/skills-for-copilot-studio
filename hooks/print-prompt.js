const path = require('path');
const fs = require('fs');
const os = require('os');

// Inject the full Copilot Studio system prompt only when the session folder
// looks like a Copilot Studio project: a .mcs folder or a *.mcs.yml file
// (agent.mcs.yml, settings.mcs.yml) in the folder itself or in one of its
// direct subfolders. CLI agent workspaces have settings.mcs.yml but no
// agent.mcs.yml, and they need the prompt for its read-only rule.
//
// A SessionStart hook runs before the first user message, so the project files
// are the only signal we have. Without this check the prompt lands in every
// session, also in unrelated work.
//
// In any other folder (also an empty one where the user is about to clone an
// agent) we only inject a short pointer to the prompt file. Agents that sit
// deeper than one level are not found, the pointer covers that case too.
//
// The check is shallow on purpose and is skipped for the home folder and for
// filesystem roots, so the hook never walks big trees such as ~/Library.
function isMarker(ent) {
  return (ent.isFile() && ent.name.endsWith('.mcs.yml')) || (ent.isDirectory() && ent.name === '.mcs');
}

function entries(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

function real(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

// Windows paths are case-insensitive (drive letter and folder names).
function sameFolder(a, b, platform) {
  return platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function hasCopilotStudioProject(cwd) {
  const resolved = real(cwd);
  if (
    sameFolder(resolved, path.parse(resolved).root, process.platform) ||
    sameFolder(resolved, real(os.homedir()), process.platform)
  ) {
    return false;
  }
  const top = entries(resolved);
  if (top.some(isMarker)) return true;
  const skip = new Set(['node_modules', '.git']);
  return top
    .filter((e) => e.isDirectory() && !skip.has(e.name))
    .slice(0, 200)
    .some((e) => entries(path.join(resolved, e.name)).some(isMarker));
}

const promptFile = path.join(__dirname, 'system-prompt.md');

function output(cwd) {
  const text = hasCopilotStudioProject(cwd)
    ? fs.readFileSync(promptFile, 'utf8')
    : 'The Copilot Studio plugin is installed, but this folder is not a Copilot Studio agent project. ' +
      'Ignore this note unless the user asks about Microsoft Copilot Studio, for example to clone an agent, ' +
      'or the folder gets .mcs/ or *.mcs.yml files. Then read ' + promptFile +
      ' first and follow it. To clone an agent, use the Manage sub-agent.';

  // Copilot CLI (v1.0.11+) injects additionalContext from JSON output.
  // Claude Code captures raw stdout as context.
  // Detect runtime and output the appropriate format.
  if (process.env.COPILOT_CLI) {
    process.stdout.write(JSON.stringify({ additionalContext: text }));
  } else {
    process.stdout.write(text);
  }
}

// Both CLIs send the session folder as "cwd" in a JSON object on stdin.
// Without stdin data (or without a cwd field) use the process folder.
let done = false;
function finish(raw) {
  if (done) return;
  done = true;
  let cwd = process.cwd();
  try {
    const j = JSON.parse(raw);
    if (j && typeof j.cwd === 'string' && j.cwd) cwd = j.cwd;
  } catch {}
  output(cwd);
  process.stdin.destroy();
}

if (process.stdin.isTTY) {
  finish('');
} else {
  let buf = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (c) => (buf += c));
  process.stdin.on('end', () => finish(buf));
  process.stdin.on('error', () => finish(buf));
  setTimeout(() => finish(buf), 500).unref();
}
