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
// Not package.json: installs that upstream left broken (a matching package.json
// without keytar.node) get reinstalled once.
const dst = p.join(d, 'native-deps.json');
const log = p.join(d, 'install.log');
const rm = { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }; // EPERM/EBUSY on Windows

// The manifest copy is written last, after the modules were installed, loaded and
// moved into place, so it matches the manifest only when the install is complete.
function installed() {
  try {
    return fs.readFileSync(src, 'utf8') === fs.readFileSync(dst, 'utf8') && fs.existsSync(p.join(d, 'node_modules'));
  } catch {
    return false;
  }
}

// Installs into a staging directory and swaps it in. Runs detached from the hook
// (node setup.js --install), so a slow or hanging registry never blocks the
// session start; the next session start joins or retries.
function install() {
  // Each installer stages under its own pid, so other sessions can tell a running
  // install from one that was killed, and never touch a directory that is in use.
  for (const n of fs.readdirSync(d)) {
    if (!n.startsWith('.install-') && !n.startsWith('.old-')) continue;
    if (n.startsWith('.install-') && alive(Number(n.slice(9)))) return console.log('another session is installing (' + n + ')');
    try {
      fs.rmSync(p.join(d, n), rm);
    } catch {}
  }
  if (installed()) return;
  const stage = p.join(d, '.install-' + process.pid);
  fs.mkdirSync(stage);
  fs.copyFileSync(src, p.join(stage, 'package.json'));
  cp.execSync('npm install --no-audit --no-fund --fetch-retries=0', { cwd: stage, stdio: 'inherit', windowsHide: true });
  // Load every module the way the scripts will; a package extracted without its
  // native binary (killed install, failed build) fails here, not at first use.
  const deps = Object.keys(JSON.parse(fs.readFileSync(src, 'utf8')).dependencies);
  cp.execFileSync(process.execPath, ['-e', 'process.argv.slice(1).forEach(function (n) { require(require("path").resolve("node_modules", n)); })', ...deps], {
    cwd: stage,
    stdio: 'inherit',
    windowsHide: true,
  });
  // Move the old tree aside instead of deleting it: a running script keeps using
  // the moved tree, and if Windows refuses the rename, the old tree stays intact.
  const old = p.join(d, '.old-' + process.pid);
  try {
    fs.renameSync(p.join(d, 'node_modules'), old);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  fs.rmSync(dst, { force: true });
  try {
    fs.renameSync(p.join(stage, 'node_modules'), p.join(d, 'node_modules'));
  } catch (err) {
    // Another installer swapped in its tree first; it was built from the same manifest.
    if (!fs.existsSync(p.join(d, 'node_modules'))) throw err;
  }
  fs.renameSync(p.join(stage, 'package.json'), dst);
  fs.rmSync(stage, rm);
  try {
    fs.rmSync(old, rm);
  } catch {}
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

if (process.argv[2] === '--install') {
  console.log('== ' + new Date().toISOString() + ' pid ' + process.pid);
  install();
  return;
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

if (!installed()) {
  fs.mkdirSync(d, { recursive: true });
  const out = fs.openSync(log, 'a');
  const child = cp.spawn(process.execPath, [__filename, '--install'], {
    cwd: d,
    detached: true,
    stdio: ['ignore', out, out],
    windowsHide: true,
  });
  child.unref();
  fs.closeSync(out);
  // Wait for a normal install (a few seconds), but not for a slow network: the
  // installer keeps running after the hook returns.
  const timer = setTimeout(() => {
    child.removeAllListeners('exit');
    fs.writeSync(2, 'copilot-studio: native dependencies are still installing in the background, see ' + log + '\n');
  }, 20000);
  child.on('exit', (code) => {
    clearTimeout(timer);
    if (code === 0) return;
    process.exitCode = 1;
    fs.writeSync(2, 'copilot-studio: installing the native dependencies failed, see ' + log + '. It is retried at the next session start.\n');
  });
}
