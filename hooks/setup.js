const fs = require('fs');
const cp = require('child_process');
const p = require('path');
const os = require('os');

// __dirname is the hooks/ directory; the plugin root is one level up
const r = p.resolve(__dirname, '..');
const d = process.env.CLAUDE_PLUGIN_DATA || process.env.COPILOT_PLUGIN_DATA;
const e = process.env.CLAUDE_ENV_FILE;

if (!r || !d) {
  process.exit(0);
}

const src = p.join(r, 'scripts', 'native-deps.json');
const dst = p.join(d, 'package.json');
// Written only after a successful `npm install`, so a failed install is retried
// on the next session instead of being masked by an already-copied package.json.
const marker = p.join(d, '.native-deps-installed.json');

function installed() {
  try {
    const manifest = fs.readFileSync(src, 'utf8');
    if (manifest !== fs.readFileSync(marker, 'utf8')) return false;
    return Object.keys(JSON.parse(manifest).dependencies).every((n) =>
      fs.existsSync(p.join(d, 'node_modules', n, 'package.json'))
    );
  } catch {
    return false;
  }
}

let installFailed = false;
if (!installed()) {
  fs.mkdirSync(d, { recursive: true });
  fs.rmSync(marker, { force: true });
  fs.copyFileSync(src, dst);
  try {
    // Claude Code adds a hook's stdout to the session context, so npm's stdout
    // goes to stderr along with its errors.
    cp.execSync('npm install --no-audit --no-fund', { cwd: d, stdio: ['ignore', 2, 2] });
    fs.copyFileSync(src, marker);
  } catch (err) {
    // Keep going so plugin-paths.json and the env export below are still written;
    // the scripts then fail with a clear missing-module error, and the install is
    // retried at the next session start.
    installFailed = true;
    console.error(
      'copilot-studio: installing the native dependencies failed (' +
        String(err.message).split('\n')[0] +
        '). It is retried at every session start; until it succeeds the scripts fail with a missing-module error.'
    );
  }
}

var pd = p.join(os.homedir(), '.copilot-studio-cli');
fs.mkdirSync(pd, { recursive: true });
fs.writeFileSync(
  p.join(pd, 'plugin-paths.json'),
  JSON.stringify({ pluginData: d, pluginRoot: r })
);

if (e) {
  fs.appendFileSync(
    e,
    'export CLAUDE_PLUGIN_DATA="' + d + '"\nexport CLAUDE_PLUGIN_ROOT="' + r + '"\n'
  );
}

if (installFailed) process.exitCode = 1;
