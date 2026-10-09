const path = require('path');
const fs = require('fs');

// Inject the full Copilot Studio system prompt only when this session is a
// Copilot Studio project: a `.mcs` folder or a `*.mcs.yml` file (agent.mcs.yml,
// settings.mcs.yml, ...) in the working directory or a subdirectory. CLI agent
// workspaces have settings.mcs.yml but no agent.mcs.yml, and they need the
// prompt for its read-only rule.
//
// A SessionStart hook runs before any user message, so it cannot read user
// intent; the project marker is the only reliable signal. Without this gate the
// hook fires on every session and injects the ~11KB prompt into unrelated work.
//
// Everywhere else (also an empty folder where the user is about to clone an
// agent) only a short pointer is injected, so Copilot Studio requests still
// reach the sub-agents and the full prompt, but other work is left alone.
function hasCopilotStudioProject(root, maxDepth, maxDirs) {
  const skip = new Set([
    'node_modules', '.git', '.svn', '.hg', 'dist', 'build', 'out',
    '.next', '.cache', '.turbo', 'coverage', 'vendor', 'target',
  ]);
  const stack = [[root, 0]];
  let visited = 0;
  while (stack.length) {
    const [dir, depth] = stack.pop();
    if (++visited > maxDirs) return false; // bounded — never a long scan
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      if ((ent.isFile() && ent.name.endsWith('.mcs.yml')) || (ent.isDirectory() && ent.name === '.mcs')) return true;
      if (
        ent.isDirectory() &&
        depth < maxDepth &&
        !skip.has(ent.name) &&
        !ent.name.startsWith('.')
      ) {
        stack.push([path.join(dir, ent.name), depth + 1]);
      }
    }
  }
  return false;
}

const promptFile = path.join(__dirname, 'system-prompt.md');
const text = hasCopilotStudioProject(process.cwd(), 4, 2000)
  ? fs.readFileSync(promptFile, 'utf8')
  : 'The Copilot Studio plugin is installed, but this folder is not a Copilot Studio agent project. ' +
    'Ignore this note unless the user explicitly asks about Microsoft Copilot Studio (for example to clone, ' +
    'edit, test or publish an agent), or the folder gains Copilot Studio files such as .mcs/ or *.mcs.yml. ' +
    'In that case read ' + promptFile + ' first and follow it; it describes the Copilot Studio sub-agents ' +
    '(Manage clones the agent first).';

// Copilot CLI (v1.0.11+) injects additionalContext from JSON output.
// Claude Code captures raw stdout as context.
// Detect runtime and output the appropriate format.
if (process.env.COPILOT_CLI) {
  process.stdout.write(JSON.stringify({ additionalContext: text }));
} else {
  process.stdout.write(text);
}
