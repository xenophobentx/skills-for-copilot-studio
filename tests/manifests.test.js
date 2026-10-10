/**
 * Tests for the plugin manifests: .claude-plugin/plugin.json,
 * .claude-plugin/marketplace.json and hooks/hooks.json.
 *
 * Offline stand-in for `claude plugin validate`. Checks that the files parse,
 * that the names and versions agree, and that every hook command points at a
 * script that exists.
 *
 * Run: node tests/manifests.test.js
 */

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");

let passed = 0;
let failed = 0;

function check(cond, label) {
  if (cond) {
    passed++;
  } else {
    failed++;
    console.error(`FAIL: ${label}`);
  }
}

function readJson(rel) {
  const file = path.join(ROOT, rel);
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    check(false, `${rel} parses (${err.message})`);
    return null;
  }
}

const plugin = readJson(".claude-plugin/plugin.json");
const market = readJson(".claude-plugin/marketplace.json");
const hooks = readJson("hooks/hooks.json");

if (plugin) {
  for (const key of ["name", "version", "description"]) {
    check(typeof plugin[key] === "string" && plugin[key] !== "", `plugin.json has ${key}`);
  }
}

if (market) {
  check(typeof market.name === "string" && market.name !== "", "marketplace.json has name");
  check(Array.isArray(market.plugins) && market.plugins.length > 0, "marketplace.json lists a plugin");
}

if (plugin && market && Array.isArray(market.plugins) && market.plugins.length > 0) {
  const entry = market.plugins[0];
  check(entry.name === plugin.name, `marketplace plugin name matches plugin.json (${entry.name} vs ${plugin.name})`);
  check(entry.version === plugin.version, `marketplace version matches plugin.json (${entry.version} vs ${plugin.version})`);
}

if (hooks) {
  const events = hooks.hooks || {};
  const names = Object.keys(events);
  check(names.length > 0, "hooks.json defines at least one event");
  for (const name of names) {
    for (const group of events[name]) {
      for (const hook of group.hooks || []) {
        check(hook.type === "command", `${name} hook has type command`);
        for (const field of ["command", "bash", "powershell"]) {
          if (typeof hook[field] !== "string") continue;
          const m = hook[field].match(/hooks[\\/'",]+([\w.-]+\.js)/) || hook[field].match(/hooks\/([\w.-]+\.js)/);
          check(!!m, `${name} ${field} names a script under hooks/`);
          if (m) check(fs.existsSync(path.join(ROOT, "hooks", m[1])), `hooks/${m[1]} exists`);
        }
      }
    }
  }
}

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
