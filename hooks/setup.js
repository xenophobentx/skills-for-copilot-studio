const fs = require('fs');
const cp = require('child_process');
const p = require('path');
const os = require('os');

// __dirname is the hooks/ directory; the plugin root is one level up
const r = p.resolve(__dirname, '..');
// CLAUDE_PLUGIN_DATA is what the harness hands to this hook, so it is this plugin's
// own folder here. Other plugins use the same name in the session, so the scripts
// get SFCS_PLUGIN_DATA and sfcs-plugin-paths.json, and read CLAUDE_PLUGIN_DATA
// only when that folder holds our native-deps.json.
//
// `setup.js --ensure` is the way without a hook (Codex before the hook is trusted,
// `npx skills add`). It runs from a model's shell, so CLAUDE_PLUGIN_DATA and
// plugin-paths.json can name another plugin's folder (a shell started from a Claude
// Code session has them set) and are never used to pick an install folder. It installs
// into SFCS_PLUGIN_DATA, the folder in sfcs-plugin-paths.json (written by our hook, and
// only when its pluginRoot is this plugin copy, because the file is shared by every copy
// and the last session start wins), or ~/.copilot-studio-cli/sfcs-data, one folder per
// user. It waits for the install and writes no paths file.
const ensure = process.argv[2] === '--ensure';
const cli = p.join(os.homedir(), '.copilot-studio-cli');
const fallback = p.join(cli, 'sfcs-data');
const e = process.env.CLAUDE_ENV_FILE;

// The file is shared by every copy of the plugin and the last hook to run wins, so its
// folder is ours only if pluginRoot names this copy. Same check as in the bundle banner.
function sameDir(a, b) {
  try {
    const x = fs.realpathSync(a);
    const y = fs.realpathSync(b);
    return process.platform === 'win32' ? x.toLowerCase() === y.toLowerCase() : x === y;
  } catch {
    return false;
  }
}
function ownPathFileData() {
  try {
    const j = JSON.parse(fs.readFileSync(p.join(cli, 'sfcs-plugin-paths.json'), 'utf8').replace(/^\uFEFF/, ''));
    const v = j.pluginData;
    return typeof v === 'string' && fs.existsSync(v) && typeof j.pluginRoot === 'string' && sameDir(j.pluginRoot, r) ? v : undefined;
  } catch {}
}
// The banner in scripts/package.json and pluginData() in doctor.js look in this order:
// SFCS_PLUGIN_DATA, sfcs-plugin-paths.json (this copy only), the stable folder, then the
// shared names. tests/plugin-data.test.js checks that after --ensure all three pick its folder.
function lookup() {
  return process.env.SFCS_PLUGIN_DATA || ownPathFileData() || fallback;
}
const d = ensure ? lookup() : process.env.CLAUDE_PLUGIN_DATA || process.env.COPILOT_PLUGIN_DATA;

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
  // keytar fetches its native binary in an install script. npm 12 blocks install
  // scripts unless package.json lists the package in allowScripts (the manifest
  // does). npm 10 and 11 ignore the field or only warn about it. A user who turned
  // install scripts off keeps that setting; fetchKeytarBinary covers keytar then.
  cp.execSync('npm install --no-audit --no-fund --fetch-retries=0', { cwd: stage, stdio: 'inherit', windowsHide: true });
  fetchKeytarBinary(stage);
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

// If npm skipped keytar's install script anyway (the user turned install scripts
// off), get the binary the way that script would have. First `npm rebuild keytar
// --ignore-scripts=false`: for this one call only, it runs keytar's own script,
// which the manifest allows, and npm passes its config (proxy, mirror) on to the
// download. If that does not produce the binary, prebuild-install runs directly;
// it honours HTTP_PROXY and HTTPS_PROXY from the environment, but not settings
// that live only in .npmrc. Does nothing when the binary is there.
function fetchKeytarBinary(dir) {
  const kt = p.join(dir, 'node_modules', 'keytar');
  const have = () => fs.existsSync(p.join(kt, 'build', 'Release', 'keytar.node'));
  if (!fs.existsSync(kt) || have()) return;
  console.log('keytar has no native binary, running npm rebuild keytar');
  try {
    cp.execSync('npm rebuild keytar --ignore-scripts=false --no-audit --no-fund', { cwd: dir, stdio: 'inherit', windowsHide: true });
  } catch (err) {
    console.log('npm rebuild keytar failed: ' + err.message);
  }
  if (have()) return;
  let bin;
  try {
    bin = require.resolve('prebuild-install/bin.js', { paths: [kt] });
  } catch {
    return console.log('prebuild-install is not installed');
  }
  console.log('keytar still has no native binary, running prebuild-install');
  try {
    cp.execFileSync(process.execPath, [bin], { cwd: kt, stdio: 'inherit', windowsHide: true });
  } catch (err) {
    console.log('prebuild-install failed: ' + err.message);
  }
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

if (ensure) {
  const deadline = Date.now() + Number(process.env.SFCS_ENSURE_TIMEOUT_MS || 180000);
  fs.mkdirSync(d, { recursive: true });
  if (!installed()) {
    console.log('copilot-studio: installing the native dependencies into ' + d + ', this takes up to a minute');
    // One installer at a time (it stages under its own pid). If another session is
    // installing, the child returns at once and we wait for its result.
    while (!installed() && Date.now() < deadline) {
      const out = fs.openSync(log, 'a');
      const res = cp.spawnSync(process.execPath, [__filename, '--install'], {
        cwd: d,
        env: { ...process.env, CLAUDE_PLUGIN_DATA: d },
        stdio: ['ignore', out, out],
        windowsHide: true,
        timeout: Math.max(1000, deadline - Date.now()),
      });
      fs.closeSync(out);
      if (res.status !== 0) break;
      if (!installed()) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);
    }
  }
  if (!installed()) {
    fs.writeSync(2, 'copilot-studio: the native dependencies are not installed in ' + d + ', see ' + log + '\n');
    process.exit(1);
  }
  console.log('copilot-studio: native dependencies ready in ' + d);
  return;
}

var pd = cli;
fs.mkdirSync(pd, { recursive: true });
fs.writeFileSync(
  p.join(pd, 'sfcs-plugin-paths.json'),
  JSON.stringify({ pluginData: d, pluginRoot: r })
);

if (e) {
  // Double quotes with \, ", $ and ` escaped: bash and zsh read that back
  // unchanged, and Claude Code's PowerShell tool only accepts quoted values of
  // this kind (a '\'' escape makes it drop every plugin's variables).
  // The hook can run more than once against the same file; add the line once.
  const line = 'export SFCS_PLUGIN_DATA="' + d.replace(/[\\"$`]/g, '\\$&') + '"\n';
  let have = '';
  try {
    have = fs.readFileSync(e, 'utf8');
  } catch {}
  if (!have.split('\n').includes(line.trimEnd())) {
    fs.appendFileSync(e, have && !have.endsWith('\n') ? '\n' + line : line);
  }
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
