/**
 * manage-agent.js — Push/pull agent content via the Copilot Studio VS Code extension's
 * LanguageServerHost binary, using its custom LSP protocol.
 *
 * Subcommands:
 *   node manage-agent.bundle.js auth                          # Sign in for both tokens (browser, or device code over SSH)
 *   node manage-agent.bundle.js push --workspace <path>       # Push local changes
 *   node manage-agent.bundle.js pull --workspace <path>       # Pull remote changes
 *   node manage-agent.bundle.js clone --workspace <path>      # Clone agent to local
 *   node manage-agent.bundle.js changes --workspace <path>    # Show local/remote diffs
 *   node manage-agent.bundle.js publish --workspace <path>    # Publish agent (make draft live)
 *   node manage-agent.bundle.js validate --workspace <path>   # Validate YAML via LSP
 *   node manage-agent.bundle.js list-agents                   # List agents in environment
 *   node manage-agent.bundle.js list-envs                     # List environments
 *   node manage-agent.bundle.js doctor [--workspace <path>]   # Read-only environment check
 *
 * Environment variables (all optional):
 *   CPS_LSP_BINARY          Override path to LanguageServerHost binary
 *   CPS_TENANT_ID           Azure AD tenant ID
 *   CPS_CLIENT_ID           Azure AD client ID (public client)
 *   CPS_ENVIRONMENT_ID      Power Platform environment ID
 *   CPS_ENVIRONMENT_URL     Dataverse environment URL (e.g. https://org123.crm.dynamics.com)
 *   CPS_AGENT_MGMT_URL      Agent management URL
 *   CPS_ENVIRONMENT_NAME    Display name for the environment
 *   CPS_AUTH_MODE           device | interactive (default: device over SSH or without a display, else interactive);
 *                           the --auth-mode flag does the same and wins
 *   CPS_AUTH_TIMEOUT_SECONDS  How long the browser sign-in may take (default 300)
 *
 * Output: JSON on stdout, diagnostics on stderr.
 */

const { spawn } = require("child_process");
const { randomUUID } = require("crypto");
const path = require("path");
const fs = require("fs");
const os = require("os");
const { fileURLToPath } = require("url");
const yaml = require("js-yaml");
const { log, die, sleep } = require("./shared-utils");
const {
  VSCODE_CLIENT_ID,
  getIslandResourceId,
  DEFAULT_CLUSTER_CATEGORY,
  COPILOT_STUDIO_HOST_RE,
  parseClusterCategory,
  getBapHost,
  resolveClusterCategory,
  buildTokenInfo,
  acquireTokenSilent,
  resolveAuthMode,
  setAuthModeOverride,
  getOrAcquireToken,
  getOrAcquireIslandToken,
} = require("./shared-auth");
const doctor = require("./doctor");
const {
  readConnJson,
  resolveConnDefaults,
  matchesEnvironment,
  matchesTenant,
  storedClusterCategory,
} = require("./conn-defaults");

// ---------------------------------------------------------------------------
// Logging helpers
// ---------------------------------------------------------------------------

function warn(msg) {
  process.stderr.write("[WARN] " + msg + "\n");
}

// ---------------------------------------------------------------------------
// URL parsing — extract environmentId + agentId from Copilot Studio URLs
// ---------------------------------------------------------------------------

/**
 * Parse a Copilot Studio web URL and extract environmentId + agentId.
 *
 * Accepted formats:
 *   https://copilotstudio.microsoft.com/environments/<envId>/bots/<agentId>[/...]
 *   https://copilotstudio.preview.microsoft.com/environments/<envId>/bots/<agentId>[/...]
 *   https://copilotstudio.preprod.microsoft.com/... and https://copilotstudio.test.microsoft.com/...
 *
 * @param {string} url — Copilot Studio URL
 * @returns {{ environmentId: string, agentId: string }} or null if the URL doesn't match
 */
function parseAgentUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }

  if (!COPILOT_STUDIO_HOST_RE.test(parsed.hostname)) return null;

  // pathname: /environments/<envId>/bots/<agentId>[/overview|/canvas|...]
  const segments = parsed.pathname.split("/").filter(Boolean);
  const envIdx = segments.indexOf("environments");
  const botsIdx = segments.indexOf("bots");

  if (envIdx === -1 || botsIdx === -1 || botsIdx <= envIdx + 1 || botsIdx + 1 >= segments.length) {
    return null;
  }

  const environmentId = decodeURIComponent(segments[envIdx + 1]);
  const agentId = decodeURIComponent(segments[botsIdx + 1]);

  if (!environmentId || !agentId) return null;
  return { environmentId, agentId };
}

// ---------------------------------------------------------------------------
// CLI parsing
// ---------------------------------------------------------------------------

function parseArgs() {
  const args = process.argv.slice(2);
  let environmentIdFlag = false; // --environment-id was given (a CPS_ENVIRONMENT_ID value is not a flag)
  const parsed = {
    command: null,
    workspace: null,
    tenantId: process.env.CPS_TENANT_ID || null,
    clientId: process.env.CPS_CLIENT_ID || null,
    environmentId: process.env.CPS_ENVIRONMENT_ID || null,
    environmentUrl: process.env.CPS_ENVIRONMENT_URL || null,
    agentMgmtUrl: process.env.CPS_AGENT_MGMT_URL || null,
    environmentName: process.env.CPS_ENVIRONMENT_NAME || null,
    accountId: null,
    accountEmail: null,
    agentId: null,
    owner: true, // default: filter by owner
    timeout: 300000, // default: 5 minutes for publish polling
    force: false,
    clusterCategory: null,
    url: null,
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--workspace":
        parsed.workspace = args[++i];
        break;
      case "--tenant-id":
        parsed.tenantId = args[++i];
        break;
      case "--client-id":
        parsed.clientId = args[++i];
        break;
      case "--environment-id":
        parsed.environmentId = args[++i];
        environmentIdFlag = true;
        break;
      case "--environment-url":
        parsed.environmentUrl = args[++i];
        break;
      case "--agent-mgmt-url":
        parsed.agentMgmtUrl = args[++i];
        break;
      case "--environment-name":
        parsed.environmentName = args[++i];
        break;
      case "--account-id":
        parsed.accountId = args[++i];
        break;
      case "--account-email":
        parsed.accountEmail = args[++i];
        break;
      case "--agent-id":
        parsed.agentId = args[++i];
        break;
      case "--no-owner":
        parsed.owner = false;
        break;
      case "--timeout": {
        const v = parseInt(args[++i], 10);
        parsed.timeout = Number.isFinite(v) && v > 0 ? v : 300000;
        break;
      }
      case "--force":
        parsed.force = true;
        break;
      case "--cluster-category":
        try {
          parsed.clusterCategory = parseClusterCategory(args[++i]);
        } catch (e) {
          die(e.message);
        }
        break;
      case "--url":
        parsed.url = args[++i];
        break;
      case "--auth-mode":
        setAuthModeOverride(args[++i]);
        break;
      default:
        if (!args[i].startsWith("--") && !parsed.command) {
          parsed.command = args[i];
        }
        break;
    }
  }

  if (!parsed.command) {
    die(
      "Usage: manage-agent <command> [options]\n" +
        "Commands: auth, push, pull, clone, changes, validate, publish, list-agents, list-envs, doctor"
    );
  }

  if (parsed.clusterCategory != null && parsed.command !== "clone") {
    warn(
      `--cluster-category only applies to clone, so ${parsed.command} ignores it. ` +
        "Other commands use the value stored in .mcs/conn.json."
    );
  }

  // When --url is provided, extract environmentId and agentId from the URL
  if (parsed.url) {
    const urlInfo = parseAgentUrl(parsed.url);
    if (!urlInfo) {
      die(
        `Could not parse Copilot Studio URL: ${parsed.url}\n` +
          "Expected format: https://copilotstudio.microsoft.com/environments/<envId>/bots/<agentId>"
      );
    }
    // --environment-id beats --url, and --url beats the CPS_ENVIRONMENT_ID variable
    if (!environmentIdFlag) parsed.environmentId = urlInfo.environmentId;
    if (!parsed.agentId) parsed.agentId = urlInfo.agentId;
    log(`Parsed URL → environmentId: ${urlInfo.environmentId}, agentId: ${urlInfo.agentId}`);
  }

  return parsed;
}

// ---------------------------------------------------------------------------
// Binary discovery — find LanguageServerHost
// ---------------------------------------------------------------------------

const EXTENSION_ID = "ms-copilotstudio.vscode-copilotstudio";
const BINARY_NAME = "LanguageServerHost";
const MIN_EXTENSION_VERSION = "1.2.90";

function getPlatformSuffix() {
  const p = os.platform();
  const a = os.arch();
  if (p === "darwin") return a === "arm64" ? "darwin-arm64" : "darwin-x64";
  if (p === "win32") return a === "arm64" ? "win32-arm64" : "win32-x64";
  return a === "arm64" ? "linux-arm64" : "linux-x64";
}

function parseSemver(v) {
  return v.split(".").map((n) => parseInt(n, 10) || 0);
}

function compareSemver(a, b) {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  for (let i = 0; i < 3; i++) {
    const diff = (pa[i] || 0) - (pb[i] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

// readOnly: report only. Skips the chmod and the log lines, and says in the
// result whether the binary is executable (doctor uses this).
function searchInDir(extensionsDir, { readOnly = false } = {}) {
  const say = readOnly ? () => {} : log;
  const skipped = [];
  const suffix = getPlatformSuffix();
  let entries;
  try {
    entries = fs.readdirSync(extensionsDir);
  } catch {
    return null;
  }

  const prefix = `${EXTENSION_ID}-`;
  const matches = [];
  for (const entry of entries) {
    if (!entry.startsWith(prefix)) continue;
    const rest = entry.slice(prefix.length);
    if (!rest.endsWith(`-${suffix}`)) continue;
    const version = rest.slice(0, -(suffix.length + 1));
    if (version) matches.push({ dir: entry, version });
  }

  matches.sort((a, b) => compareSemver(b.version, a.version));

  // Newest version that has a binary wins. Since 1.9 the macOS package keeps one
  // binary per architecture under lspOut/osx-arm64 and lspOut/osx-x64; the
  // extension itself looks there first and falls back to lspOut/.
  const binaryName =
    os.platform() === "win32" ? `${BINARY_NAME}.exe` : BINARY_NAME;
  const archDir = os.arch() === "arm64" ? "osx-arm64" : "osx-x64";
  for (const match of matches) {
    const extensionDir = path.join(extensionsDir, match.dir);
    const candidates = [path.join(extensionDir, "lspOut", binaryName)];
    if (os.platform() === "darwin") {
      candidates.unshift(path.join(extensionDir, "lspOut", archDir, binaryName));
    }
    const binaryPath = candidates.find((c) => fs.existsSync(c));
    if (!binaryPath) {
      say(`Extension found at ${extensionDir} but binary missing: ${candidates.join(" or ")}`);
      skipped.push(match.version);
      continue;
    }

    // Ensure executable on Unix
    let executable = true;
    if (os.platform() !== "win32") {
      try {
        fs.accessSync(binaryPath, fs.constants.X_OK);
      } catch {
        if (readOnly) {
          executable = false;
        } else {
          log(`Setting executable permission on ${binaryPath}`);
          fs.chmodSync(binaryPath, 0o755);
        }
      }
    }

    return { binaryPath, extensionDir, lspOutDir: path.dirname(binaryPath), version: match.version, executable, skipped };
  }
  return null;
}

// Looks for the binary without exiting: { info, searchDirs }, info is null when
// nothing was found. doctor calls it with readOnly.
function locateBinary({ readOnly = false } = {}) {
  // Check env override first
  const envBinary = process.env.CPS_LSP_BINARY;
  if (envBinary) {
    if (fs.existsSync(envBinary)) {
      if (!readOnly) log(`Using CPS_LSP_BINARY override: ${envBinary}`);
      return {
        info: { binaryPath: envBinary, lspOutDir: path.dirname(envBinary), version: "custom" },
        searchDirs: [],
      };
    }
    if (!readOnly) log(`Warning: CPS_LSP_BINARY set but not found: ${envBinary}`);
  }

  const home = os.homedir();
  const searchDirs = [
    path.join(home, ".vscode", "extensions"),
    path.join(home, ".vscode-insiders", "extensions"),
  ];

  for (const dir of searchDirs) {
    const result = searchInDir(dir, { readOnly });
    if (result) return { info: result, searchDirs };
  }
  return { info: null, searchDirs };
}

function findBinary() {
  const { info, searchDirs } = locateBinary();
  if (info) {
    if (info.version !== "custom") {
      log(
        `Found Copilot Studio extension v${info.version} at ${info.lspOutDir}`
      );
      if (compareSemver(info.version, MIN_EXTENSION_VERSION) < 0) {
        warn(`Extension v${info.version} is older than tested v${MIN_EXTENSION_VERSION}. Some features may not work. Update: https://marketplace.visualstudio.com/items?itemName=ms-copilotstudio.vscode-copilotstudio`);
      }
    }
    return info;
  }

  die(
    "Copilot Studio VS Code extension not found.\n" +
      `Searched: ${searchDirs.join(", ")}\n` +
      "Install from: https://marketplace.visualstudio.com/items?itemName=ms-copilotstudio.vscode-copilotstudio\n" +
      "Or set CPS_LSP_BINARY env var to the LanguageServerHost path."
  );
}

// ---------------------------------------------------------------------------
// LSP client — spawn binary, connect via named pipe, JSON-RPC lifecycle
// ---------------------------------------------------------------------------

class LspClient {
  constructor(binaryInfo, workspaceRoot) {
    this.binaryPath = binaryInfo.binaryPath;
    this.lspOutDir = binaryInfo.lspOutDir;
    this.workspaceRoot = workspaceRoot || process.cwd();
    this.process = null;
    this.running = false;
    this._connection = null;
    this._pipeSocket = null;
    this._pipeServer = null;
    this._diagnostics = new Map(); // uri → diagnostics[]
    this._onDiagnosticsCallback = null;
    this._onExitCallback = null;
    this.exitInfo = null; // set when the LSP process exits or errors
  }

  async start() {
    if (this.running) return;

    const net = require("net");
    const { SocketMessageReader, SocketMessageWriter, createMessageConnection } = require("vscode-jsonrpc/node");
    const sessionId = randomUUID();
    const pipePath = os.platform() === "win32"
      ? `\\\\.\\pipe\\manage-agent-${sessionId}`
      : path.join(os.tmpdir(), `manage-agent-${sessionId}.sock`);

    // Create socket server FIRST — the binary connects to us as a client
    const server = net.createServer();
    server.listen(pipePath);
    await new Promise((resolve, reject) => {
      server.once("listening", resolve);
      server.once("error", reject);
    });

    log(`Listening on pipe: ${pipePath}`);

    // Spawn binary — it will connect to our socket
    const args = [
      `--sessionid=${sessionId}`,
      "--enabletelemetry=false",
      `--pipe=${pipePath}`,
    ];

    log(`Spawning LSP: ${this.binaryPath}`);
    log(`  cwd: ${this.lspOutDir}`);

    this.process = spawn(this.binaryPath, args, {
      cwd: this.lspOutDir,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env },
    });

    // Discard stdout (.NET log noise) — LSP goes over the pipe instead
    this.process.stdout.resume();
    this.process.stderr.on("data", (data) => {
      const text = data.toString().trim();
      if (text) log(`[LSP stderr] ${text}`);
    });

    this.process.on("exit", (code, signal) => {
      log(`LSP process exited: code=${code}, signal=${signal}`);
      this.running = false;
      this.exitInfo = `exited (code=${code}, signal=${signal})`;
      if (this._onExitCallback) this._onExitCallback();
    });

    this.process.on("error", (err) => {
      log(`LSP process error: ${err.message}`);
      this.running = false;
      this.exitInfo = `failed (${err.message})`;
      if (this._onExitCallback) this._onExitCallback();
    });

    // Wait for the binary to connect to our socket
    this._pipeSocket = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error("LSP binary did not connect to pipe within 15s"));
      }, 15000);
      server.once("connection", (socket) => {
        clearTimeout(timeout);
        resolve(socket);
      });
      this.process.once("exit", () => {
        clearTimeout(timeout);
        reject(new Error("LSP binary exited before connecting to pipe"));
      });
    });

    this._pipeServer = server;
    log("LSP connected via named pipe (clean channel, no stdout filtering)");

    // Create JSON-RPC connection over the socket
    const reader = new SocketMessageReader(this._pipeSocket);
    const writer = new SocketMessageWriter(this._pipeSocket);
    this._connection = createMessageConnection(reader, writer);

    // Handle server requests
    this._connection.onRequest("workspace/configuration", (params) => {
      log(`[LSP server request] workspace/configuration`);
      return (params.items || []).map(() => ({}));
    });

    // Handle server notifications
    this._connection.onNotification("textDocument/publishDiagnostics", (params) => {
      const { uri, diagnostics } = params;
      this._diagnostics.set(uri, diagnostics || []);
      log(`[LSP diagnostics] ${uri}: ${(diagnostics || []).length} diagnostic(s)`);
      if (this._onDiagnosticsCallback) this._onDiagnosticsCallback(uri, diagnostics || []);
    });

    this._connection.onUnhandledNotification((msg) => {
      const detail = msg.params
        ? ` ${JSON.stringify(msg.params).substring(0, 300)}`
        : "";
      log(`[LSP notification] ${msg.method}${detail}`);
    });

    this._connection.listen();

    // Send initialize
    const rootUri = toFileUri(this.workspaceRoot);
    const initResult = await this._connection.sendRequest("initialize", {
      processId: process.pid,
      rootUri,
      capabilities: {
        textDocument: {
          synchronization: { dynamicRegistration: false },
          publishDiagnostics: { relatedInformation: true },
        },
        workspace: { workspaceFolders: true },
      },
      workspaceFolders: [{ uri: rootUri, name: "agent" }],
    });

    log("LSP initialized successfully");

    // Send initialized notification
    this._connection.sendNotification("initialized", {});
    this.running = true;

    return initResult;
  }

  async sendCustomRequest(method, params) {
    if (!this.running) throw new Error("LSP client not running");
    log(`Sending: ${method}`);
    return await this._connection.sendRequest(method, params);
  }

  sendNotification(method, params) {
    this._connection.sendNotification(method, params);
  }

  getDiagnostics() {
    return this._diagnostics;
  }

  async stop() {
    if (!this.running) return;

    // Race shutdown+exit against a 2s timeout. LSP defines no params for either
    // (not even null); the server rejects shutdown if it receives some.
    const graceful = (async () => {
      await this._connection.sendRequest("shutdown");
      // The server may close the socket first. Without the catch, a late write
      // error crashes the process, which matters when work continues after stop().
      this._connection.sendNotification("exit").catch(() => {});
    })();
    const timeout = new Promise((resolve) => setTimeout(resolve, 2000));

    try {
      const result = await Promise.race([
        graceful.then(() => "ok"),
        timeout.then(() => "timeout"),
      ]);
      if (result === "timeout") {
        log("LSP shutdown timed out after 2s, forcing cleanup");
      }
    } catch {
      // Ignore errors during shutdown
    }

    this.running = false;
    this._connection.dispose();
    this._connection = null;
    if (this._pipeSocket) {
      this._pipeSocket.destroy();
      this._pipeSocket = null;
    }
    if (this._pipeServer) {
      this._pipeServer.close();
      this._pipeServer = null;
    }
    if (this.process) {
      this.process.kill();
      this.process = null;
    }
  }
}

// ---------------------------------------------------------------------------
// Request builders
// ---------------------------------------------------------------------------

function toFileUri(absPath) {
  // Proper file URI encoding: encode spaces and special chars
  // Windows: C:\foo\bar → file:///C:/foo/bar
  // Unix:    /foo/bar   → file:///foo/bar
  const resolved = path.resolve(absPath);
  const segments = resolved.split(path.sep);
  const encoded = segments.map((s, i) => {
    // Preserve Windows drive letter (e.g. "C:") unencoded
    if (i === 0 && /^[A-Za-z]:$/.test(s)) return s;
    return encodeURIComponent(s);
  }).join("/");
  const prefix = encoded.startsWith("/") ? "file://" : "file:///";
  return `${prefix}${encoded}`;
}

// ---------------------------------------------------------------------------
// Validation helpers — LSP-based diagnostics
// ---------------------------------------------------------------------------

function findMcsYmlFiles(dir, results = []) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch { return results; }
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      findMcsYmlFiles(full, results);
    } else if (entry.isFile() && entry.name.endsWith(".mcs.yml")) {
      results.push(full);
    }
  }
  return results;
}

// Raw git-style merge markers (7 chars at line start, then a space or EOL).
// syncPull writes these into a topic when the same line changed locally and
// on the server, and still reports success.
const CONFLICT_MARKER_RE = /^(<{7}|={7}|>{7})( |$)/;

function conflictMarkerLines(text) {
  const lines = [];
  text.replace(/^\uFEFF/, "").split(/\r?\n/).forEach((line, i) => {
    if (CONFLICT_MARKER_RE.test(line)) lines.push(i + 1);
  });
  return lines;
}

function findConflictMarkers(agentDir) {
  const conflicts = [];
  for (const file of findMcsYmlFiles(agentDir).sort()) {
    let text;
    try { text = fs.readFileSync(file, "utf8"); }
    catch { continue; }
    const lines = conflictMarkerLines(text);
    if (lines.length > 0) {
      conflicts.push({ file: path.relative(agentDir, file).split(path.sep).join("/"), lines });
    }
  }
  return conflicts;
}

function formatConflicts(conflicts) {
  return conflicts.map((c) => `${c.file} (line${c.lines.length > 1 ? "s" : ""} ${c.lines.join(", ")})`).join("; ");
}

// A "key: value" line whose value is an unquoted (plain) scalar. The service
// keeps such values and returns them from a clone, for example `description:
// Text: more text` in the tool files of a CLI agent, and the language server
// reads them as the literal text. A strict YAML parser rejects them. Groups:
// indent and list dashes, key, colon and spaces, value.
const PLAIN_VALUE_LINE_RE = /^(\s*(?:-[ \t]+)*)([^\s"'#\[\]{}|>&*!%@`,?:-][^#]*?)(:[ \t]+)([^\s"'#\[{|>].*)$/;

// Why a plain value is a problem for a strict parser, or null when it is not
// one of the shapes measured against the service (round trip, 2026-10-10):
// ": " inside the value, a trailing ":", or a first character that YAML
// reserves (@ ` % * ! or "- ").
function plainValueProblem(value) {
  const text = value.replace(/\s+#.*$/, "");
  if (/^[@`%*!]/.test(text)) return `starts with "${text[0]}"`;
  if (/^-(\s|$)/.test(text)) return 'starts with "- "';
  if (/:\s/.test(text)) return 'contains ": "';
  if (/:$/.test(text)) return 'ends with ":"';
  return null;
}

// Block scalar header after the optional key, dashes and node properties:
// `|`, `>`, with indicators and a comment.
const BLOCK_HEADER_RE = /^\s*(?:-[ \t]+)*(?:(?:[^\s"'#\[\]{}|>&*!%@`,?:-][^#]*?|"[^"]*"|'[^']*'):[ \t]+)?(?:[&!]\S*[ \t]+)*[|>][+-]?[0-9]?[+-]?[ \t]*(?:#.*)?$/;

// Column where the key starts (indent plus list dashes) of a line.
function keyColumn(line) {
  return /^\s*(?:-[ \t]+)*/.exec(line)[0].length;
}

// Is there a quoted value that opens on a line and is not closed on it? The
// language server calls such a file valid when a later quote closes it, and a
// push empties the topic, so the lenient reading must not hide that mistake
// behind a tolerated line. Anchors and tags may stand before the quote. The
// content of `|` and `>` blocks is text and is skipped.
function hasUnclosedQuoteLine(lines) {
  const open = /^\s*(?:-[ \t]+)*(?:[^\s"'#\[\]{}|>&*!%@`,?:-][^#]*?:[ \t]+)?(?:[&!]\S*[ \t]+)*(["'])/;
  let blockKey = -1;
  for (const line of lines) {
    if (blockKey >= 0) {
      if (line.trim() === "" || keyColumn(line) > blockKey) continue;
      blockKey = -1;
    }
    if (BLOCK_HEADER_RE.test(line)) { blockKey = keyColumn(line); continue; }
    const m = open.exec(line);
    if (!m) continue;
    const rest = line.slice(m[0].length);
    let closed = false;
    for (let i = 0; i < rest.length && !closed; i++) {
      if (m[1] === '"') {
        if (rest[i] === "\\") i++;
        else if (rest[i] === '"') closed = true;
      } else if (rest[i] === "'") {
        if (rest[i + 1] === "'") i++;
        else closed = true;
      }
    }
    if (!closed) return true;
  }
  return false;
}

// Does the line at index i stand right below a block scalar header without
// being indented under it? The block is empty and the line is the next entry,
// for example `description: |` followed by `Note: see: x` at the left margin.
// The service then takes the line as the content of the block and the topic
// comes back corrupted (measured), so such a line stays an error.
function belowEmptyBlock(lines, i) {
  for (let j = i - 1; j >= 0; j--) {
    if (lines[j].trim() === "") continue;
    return BLOCK_HEADER_RE.test(lines[j]) && keyColumn(lines[i]) <= keyColumn(lines[j]);
  }
  return false;
}

// Parses one file. A line that fails only because of an unquoted value that
// the service keeps is quoted and the parse is repeated, and reported as a
// warning. Anything else that fails is an error. Returns
// { error: { line, column, message } | null, warnings: [{ line, column, reason, message }] },
// line and column 1-based. A file with an error returns no warnings.
function checkYamlText(text) {
  const lines = text.replace(/^﻿/, "").split(/\r?\n/);
  const warnings = [];
  let relax = null;
  for (let round = 0; round <= lines.length; round++) {
    try {
      // json: true lets a repeated key through; the LSP already reports those.
      yaml.load(lines.join("\n"), { json: true });
      return { error: null, warnings };
    } catch (e) {
      const failure = {
        line: e.mark ? e.mark.line + 1 : 1,
        column: e.mark ? e.mark.column + 1 : 1,
        message: e.reason || e.message,
      };
      if (relax === null) relax = !hasUnclosedQuoteLine(lines);
      const i = e.mark ? e.mark.line : -1;
      const m = relax && i >= 0 && i < lines.length ? PLAIN_VALUE_LINE_RE.exec(lines[i]) : null;
      const problem = m && !belowEmptyBlock(lines, i) ? plainValueProblem(m[4]) : null;
      if (!problem) return { error: failure, warnings: [] };
      const comment = /\s+#.*$/.exec(m[4]);
      const value = comment ? m[4].slice(0, comment.index) : m[4];
      warnings.push({
        line: i + 1,
        column: m[1].length + m[2].length + m[3].length + 1,
        reason: problem,
        message: `Unquoted value ${problem}. The service keeps it as plain text, but a strict YAML parser rejects it. Put the value in quotes to make the file valid YAML.`,
      });
      lines[i] = `${m[1]}${m[2]}: ${JSON.stringify(value.trimEnd())}${comment ? " " + comment[0].trim() : ""}`;
    }
  }
  return { error: { line: 1, column: 1, message: "too many unquoted values" }, warnings: [] };
}

// The LSP accepts files that do not parse as YAML (a quote closed by a later
// quote, or text after a closing quote, comes back as "valid"; an unclosed
// quote that runs to the end of the file it reports itself), so parse every
// file here. Returns
// { errors, warnings }, one entry per problem: { file, line, column, message },
// line and column 1-based. Errors are files that fail; warnings are unquoted
// values that only a strict parser rejects.
function scanYamlFiles(agentDir) {
  const errors = [];
  const warnings = [];
  for (const file of findMcsYmlFiles(agentDir).sort()) {
    let text;
    try { text = fs.readFileSync(file, "utf8"); }
    catch { continue; }
    // A file with merge markers is reported as that, not as a parse error.
    if (conflictMarkerLines(text).length > 0) continue;
    const rel = path.relative(agentDir, file).split(path.sep).join("/");
    const result = checkYamlText(text);
    if (result.error) errors.push({ file: rel, ...result.error });
    for (const w of result.warnings) warnings.push({ file: rel, ...w });
  }
  return { errors, warnings };
}

function findYamlSyntaxErrors(agentDir) {
  return scanYamlFiles(agentDir).errors;
}

function findYamlLenientWarnings(agentDir) {
  return scanYamlFiles(agentDir).warnings;
}

function formatYamlSyntaxErrors(errors) {
  return errors.map((e) => `${e.file} (line ${e.line}, column ${e.column}: ${e.message})`).join("; ");
}

// In a classic agent.mcs.yml, an object or a list under instructions reads as
// empty instructions: the language server sees no difference from an empty
// value (getLocalChanges, extension 1.9.14) and raises no diagnostic. Plain
// scalars (a number, a boolean, a date) are text for the server, so they pass.
// Only the agent.mcs.yml in the agent root is checked.
// Returns [{ file, line, message }] (line is 1-based, 1 when unknown).
function findInstructionsShapeErrors(agentDir) {
  const rel = "agent.mcs.yml";
  let text;
  let doc;
  try {
    text = fs.readFileSync(path.join(agentDir, rel), "utf8");
    if (conflictMarkerLines(text).length > 0) return [];
    doc = yaml.load(text, { json: true });
  } catch { return []; }
  if (!doc || typeof doc !== "object" || doc.kind !== "GptComponentMetadata") return [];
  const ins = doc.instructions;
  if (ins === null || typeof ins !== "object" || ins instanceof Date) return [];
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
  const i = lines.findIndex((l) => /^instructions\s*:/.test(l));
  return [{
    file: rel,
    line: i === -1 ? 1 : i + 1,
    message: "instructions must be a string. An object or a list under it is dropped without an error and the agent runs with empty instructions. Write the text as a block scalar (instructions: |).",
  }];
}

// What validate adds to the LSP diagnostics: one merge marker error per file,
// then YAML syntax errors (files with markers are not parsed), then the
// instructions shape error.
function findLocalErrors(agentDir, scan = scanYamlFiles(agentDir)) {
  const errors = [];
  for (const c of findConflictMarkers(agentDir)) {
    errors.push({
      file: c.file, line: c.lines[0], column: 1, source: "conflict-markers",
      message: `Unresolved merge conflict markers at line${c.lines.length > 1 ? "s" : ""} ${c.lines.join(", ")}. Keep the right version between the markers and delete the marker lines.`,
    });
  }
  for (const e of scan.errors) {
    errors.push({
      file: e.file, line: e.line, column: e.column, source: "yaml-syntax",
      message: `YAML syntax error (line ${e.line}, column ${e.column}): ${e.message}`,
    });
  }
  for (const e of findInstructionsShapeErrors(agentDir)) {
    errors.push({ file: e.file, line: e.line, column: 1, source: "instructions-shape", message: e.message });
  }
  return errors;
}

// Unquoted values that validate reports as warnings: the service keeps them,
// a strict YAML parser rejects them. scan is the result of scanYamlFiles, so
// validate parses the files once.
function findLocalWarnings(agentDir, scan = scanYamlFiles(agentDir)) {
  return scan.warnings.map((w) => ({
    file: w.file, line: w.line, column: w.column, source: "yaml-lenient",
    message: `YAML warning (line ${w.line}, column ${w.column}): ${w.message}`,
  }));
}

// Returns the files that could not be read (and so were not opened): [{ filePath, error }]
function openFilesForDiagnostics(client, filePaths) {
  // Notify the server about all files via workspace/didChangeWatchedFiles first.
  // This mirrors the VS Code extension's file watcher behavior and triggers
  // workspace-wide diagnostics (PublishAllDiagnosticsAsync) which includes
  // cross-file validation that textDocument/didOpen alone doesn't trigger.
  const fileEvents = filePaths.map((filePath) => ({
    uri: toFileUri(filePath),
    type: 1, // FileChangeType.Created
  }));
  client.sendNotification("workspace/didChangeWatchedFiles", { changes: fileEvents });

  // Then open each file for per-document diagnostics
  const unreadable = [];
  for (const filePath of filePaths) {
    const uri = toFileUri(filePath);
    let text = "";
    try { text = fs.readFileSync(filePath, "utf8"); }
    catch (e) {
      log(`[validate] Could not read ${filePath}: ${e.message}`);
      unreadable.push({ filePath, error: e.message });
      continue;
    }
    client.sendNotification("textDocument/didOpen", {
      textDocument: { uri, languageId: "yaml", version: 1, text },
    });
  }
  return unreadable;
}

// Normalize a file URI or path so URIs from the server and from toFileUri()
// compare equal regardless of percent-encoding, and (on Windows) case/slashes.
function diagnosticsKey(uri) {
  let p = uri.replace(/^file:\/\//, "");
  try { p = decodeURIComponent(p); } catch {}
  if (os.platform() === "win32") {
    p = p.replace(/^\/([A-Za-z]:)/, "$1").replace(/\\/g, "/").toLowerCase();
  }
  return p;
}

// Files that were sent to the server but never got a publishDiagnostics
// (an empty diagnostics array counts as published).
function findFilesWithoutDiagnostics(filePaths, diagnosticsMap) {
  const received = new Set();
  for (const uri of diagnosticsMap.keys()) received.add(diagnosticsKey(uri));
  return filePaths.filter((filePath) => !received.has(diagnosticsKey(toFileUri(filePath))));
}

// Resolves with { diagnostics, reason }. reason is null when diagnostics arrived
// for every file in filePaths, "timeout" if the wait timed out first, or
// "lsp-exited" if the LSP process went away while waiting.
function waitForDiagnostics(client, filePaths, settleMs = 500, timeoutMs = 15000) {
  return new Promise((resolve) => {
    let settleTimer = null;
    let hardTimer = null;
    let resolved = false;

    function done(reason) {
      if (resolved) return;
      resolved = true;
      client._onDiagnosticsCallback = null;
      client._onExitCallback = null;
      if (settleTimer) clearTimeout(settleTimer);
      if (hardTimer) clearTimeout(hardTimer);
      resolve({ diagnostics: new Map(client._diagnostics), reason });
    }

    function resetSettle() {
      if (settleTimer) clearTimeout(settleTimer);
      // Only settle once every file has reported; otherwise keep waiting for
      // the remaining files until the hard timeout.
      settleTimer = setTimeout(() => {
        if (findFilesWithoutDiagnostics(filePaths, client._diagnostics).length === 0) done(null);
      }, settleMs);
    }

    hardTimer = setTimeout(() => {
      log("[validate] Diagnostics wait timed out");
      done("timeout");
    }, timeoutMs);

    client._onDiagnosticsCallback = () => resetSettle();
    client._onExitCallback = () => done("lsp-exited");
    if (!client.running) done("lsp-exited");
    else if (filePaths.length === 0) done(null);
  });
}

const SEVERITY_NAMES = { 1: "error", 2: "warning", 3: "information", 4: "hint" };

function formatValidationOutput(diagnosticsMap, agentDir, incomplete = null, localErrors = [], localWarnings = []) {
  let errorCount = 0, warningCount = 0, infoCount = 0;
  const files = [];

  for (const [uri, diags] of diagnosticsMap) {
    if (!diags || diags.length === 0) continue;
    let filePath = uri;
    try {
      // toFileUri writes a UNC path as file:////host/share/..., which fileURLToPath rejects
      // (and for host "localhost" the URL parser would drop the host), so build the path directly.
      const unc = process.platform === "win32" && uri.match(/^file:\/\/\/\/(.*)$/);
      const localPath = unc
        ? "\\\\" + unc[1].split("/").map(decodeURIComponent).join("\\")
        : fileURLToPath(uri);
      filePath = path.relative(agentDir, localPath);
    } catch {}

    const mapped = diags.map((d) => {
      const sev = d.severity || 1;
      if (sev === 1) errorCount++;
      else if (sev === 2) warningCount++;
      else infoCount++;
      return {
        severity: SEVERITY_NAMES[sev] || "error",
        message: d.message,
        code: d.code,
        source: d.source,
        range: d.range,
      };
    });
    files.push({ file: filePath, diagnostics: mapped });
  }

  // Problems found locally (merge markers, YAML syntax, unquoted values); the
  // LSP does not report them.
  const addLocal = (e, severity) => {
    const diagnostic = {
      severity,
      message: e.message,
      source: e.source,
      range: {
        start: { line: e.line - 1, character: e.column - 1 },
        end: { line: e.line - 1, character: e.column - 1 },
      },
    };
    // e.file uses forward slashes; the LSP entries use the native separator
    const native = e.file.split("/").join(path.sep);
    const entry = files.find((f) => f.file === native);
    if (entry) entry.diagnostics.push(diagnostic);
    else files.push({ file: native, diagnostics: [diagnostic] });
  };
  for (const e of localErrors) { errorCount++; addLocal(e, "error"); }
  for (const e of localWarnings) { warningCount++; addLocal(e, "warning"); }

  const output = {
    status: errorCount > 0 ? "error" : incomplete ? "incomplete" : "ok",
    valid: errorCount === 0 && !incomplete,
    summary: { errors: errorCount, warnings: warningCount, info: infoCount },
    files,
  };
  if (incomplete) {
    // Fail closed: diagnostics are missing, so a clean result cannot be trusted
    output.incomplete = true;
    output.reason = incomplete.reason;
    output.message = incomplete.message;
    output.missingFiles = incomplete.missingFiles;
    output.unreadableFiles = incomplete.unreadableFiles || [];
  }
  return output;
}

function pushBlockedError(validation) {
  const errors = validation.summary.errors;
  if (validation.incomplete && errors === 0) {
    return `Push blocked: ${validation.message} Re-run, or use --force to bypass.`;
  }
  if (validation.incomplete) {
    return `Push blocked: ${errors} validation error(s). ${validation.message} Fix errors and re-run before pushing, or use --force to bypass.`;
  }
  return `Push blocked: ${errors} validation error(s). Fix errors before pushing, or use --force to bypass.`;
}

async function runValidation(client, args, tokens) {
  const agentDir = findAgentDir(args.workspace);

  // Send a lightweight request to initialize environment context
  try {
    await client.sendCustomRequest("powerplatformls/getLocalChanges", buildSyncRequest(args, tokens));
  } catch (e) {
    log(`[validate] Context init warning: ${e.message}`);
  }

  const filePaths = findMcsYmlFiles(agentDir);
  if (filePaths.length === 0) {
    return {
      status: "ok", valid: true,
      summary: { errors: 0, warnings: 0, info: 0 },
      files: [], fileCount: 0,
      message: "No .mcs.yml files found",
    };
  }

  log(`[validate] Found ${filePaths.length} .mcs.yml file(s)`);
  const unreadable = openFilesForDiagnostics(client, filePaths);
  // Files that could not be read were never opened, so do not wait for them
  const unreadablePaths = new Set(unreadable.map((u) => u.filePath));
  const expected = filePaths.filter((f) => !unreadablePaths.has(f));

  log("[validate] Waiting for diagnostics...");
  const { diagnostics: diagnosticsMap, reason } = await waitForDiagnostics(client, expected);

  // Every file must have been read and have reported diagnostics; a timeout,
  // a crashed LSP process or an unreadable file must not look like a clean pass.
  const missing = findFilesWithoutDiagnostics(expected, diagnosticsMap);
  let incomplete = null;
  if (missing.length > 0 || unreadable.length > 0) {
    const problems = [];
    if (missing.length > 0) {
      const why = reason === "lsp-exited"
        ? `the LSP process ${client.exitInfo || "exited"}`
        : "the wait for diagnostics timed out";
      problems.push(`${why}; no diagnostics received for ${missing.length} of ${filePaths.length} file(s)`);
    }
    if (unreadable.length > 0) problems.push(`${unreadable.length} file(s) could not be read`);
    incomplete = {
      reason: missing.length > 0 ? reason || "timeout" : "unreadable",
      message: `Validation incomplete: ${problems.join("; ")}. This is not a clean pass.`,
      missingFiles: missing.map((f) => path.relative(agentDir, f)),
      unreadableFiles: unreadable.map((u) => ({ file: path.relative(agentDir, u.filePath), error: u.error })),
    };
    log(`[validate] ${incomplete.message}`);
  }

  const yamlScan = scanYamlFiles(agentDir);
  const output = formatValidationOutput(diagnosticsMap, agentDir, incomplete, findLocalErrors(agentDir, yamlScan), findLocalWarnings(agentDir, yamlScan));
  output.fileCount = filePaths.length;
  return output;
}

function findAgentDir(workspace, quiet = false) {
  // If workspace itself has .mcs/, use it directly
  const resolvedWs = path.resolve(workspace);
  if (fs.existsSync(path.join(resolvedWs, ".mcs", "conn.json"))) {
    return resolvedWs;
  }
  // Otherwise look for a single subfolder with .mcs/
  try {
    const entries = fs.readdirSync(resolvedWs, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory() && !entry.name.startsWith(".")) {
        const sub = path.join(resolvedWs, entry.name);
        if (fs.existsSync(path.join(sub, ".mcs", "conn.json"))) {
          if (!quiet) log(`Found agent directory: ${sub}`);
          return sub;
        }
      }
    }
  } catch {}
  return resolvedWs;
}

/**
 * The LSP needs .mcs/botdefinition.json, which clone writes but git never
 * tracks (.mcs/.gitignore contains "*"). Returns an error message when the
 * workspace lacks it, or null when the workspace is usable.
 */
function getMissingBotDefinitionError(workspace) {
  const agentDir = findAgentDir(workspace);
  if (fs.existsSync(path.join(agentDir, ".mcs", "botdefinition.json"))) {
    return null;
  }
  return (
    `No .mcs/botdefinition.json found in ${agentDir}. clone creates this file, ` +
    "but it is not tracked in git because .mcs/.gitignore ignores everything, " +
    "so a workspace that went through git or was copied without .mcs/ does not " +
    "have it. Without it validate reports a misleading missing 'CdsBotId', and " +
    "push and pull fail with 'Please resync'. To fix it, clone the agent again " +
    "into a new folder, copy your edited YAML files over the new clone, then " +
    "run validate and push."
  );
}

function requireBotDefinition(args) {
  const message = getMissingBotDefinitionError(args.workspace);
  if (message) die(message);
}

function loadConnJson(agentDir) {
  return readConnJson(agentDir); // same reader as resolveConnDefaults, so a BOM is fine in both
}

// Cluster category for the environment lookup of a workspace command: the value
// stored in .mcs/conn.json (push and pull use it for the Island token), else the
// --url host, else Prod.
function lookupClusterCategory(args) {
  const conn = loadConnJson(findAgentDir(args.workspace, true));
  return resolveClusterCategory({ stored: storedClusterCategory(conn, args), url: args.url }).category;
}

function buildSyncRequest(args, tokens) {
  const agentDir = findAgentDir(args.workspace);
  const workspaceUri = toFileUri(agentDir);
  const conn = loadConnJson(agentDir);

  log(`Workspace URI: ${workspaceUri}`);
  if (conn) {
    log(`Found .mcs/conn.json — AgentId: ${conn.AgentId}`);
  }

  // Build accountInfo: conn.json uses PascalCase but LSP binary expects camelCase.
  // The account in conn.json belongs to its tenant, so all of it comes from the file or
  // none of it does. The cluster category belongs to the environment (see storedClusterCategory).
  const connAccount = conn && matchesTenant(args, conn) ? conn.AccountInfo : null;
  const accountInfo = {
    accountId: (connAccount && connAccount.AccountId) || args.accountId || tokens.copilotStudio.account?.homeAccountId || "unknown",
    accountEmail: (connAccount && connAccount.AccountEmail) || args.accountEmail || tokens.copilotStudio.account?.username || undefined,
    tenantId: args.tenantId,
    clusterCategory: connAccount ? storedClusterCategory(conn, args) ?? undefined : undefined,
  };

  const request = {
    accountInfo,
    copilotStudioAccessToken: tokens.copilotStudio.accessToken,
    dataverseAccessToken: tokens.dataverse.accessToken,
    environmentInfo: {
      // Only what resolveConnDefaults checked or the lookup returned. Never the raw conn.json URLs.
      agentManagementUrl: args.agentMgmtUrl || undefined,
      dataverseUrl: args.environmentUrl || undefined,
      displayName: args.environmentName || "Environment",
      environmentId: args.environmentId || undefined,
    },
    workspaceUri,
  };

  // Include solutionVersions if available from conn.json (they belong to its environment)
  if (conn && conn.SolutionVersions && matchesEnvironment(args, conn)) {
    request.solutionVersions = conn.SolutionVersions;
  }

  return request;
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

const LSP_TRANSIENT_SSL_MAX_ATTEMPTS = 3;
const LSP_TRANSIENT_SSL_RETRY_DELAY_MS = 3000;

function isTransientSslError(message) {
  return /ssl connection could not be established/i.test(message || "");
}

function isLspErrorCode(code) {
  return code < 0 || code >= 400;
}

function buildLspError(method, result) {
  if (
    result &&
    typeof result === "object" &&
    typeof result.code === "number" &&
    isLspErrorCode(result.code)
  ) {
    const message = result.message || "LSP request failed";
    const retryHint = isTransientSslError(message)
      ? " This is sometimes transient; retry the command if it continues after automatic retries."
      : "";
    return new Error(`${method} failed: ${message} (code ${result.code}).${retryHint}`);
  }
  return null;
}

async function sendCustomRequestWithRetries(client, method, request, options = {}) {
  const maxAttempts = options.maxAttempts || LSP_TRANSIENT_SSL_MAX_ATTEMPTS;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const result = await client.sendCustomRequest(method, request);
      const error = buildLspError(method, result);
      if (!error) return result;

      if (!isTransientSslError(error.message) || attempt === maxAttempts) {
        throw error;
      }
    } catch (error) {
      if (error.message && error.message.startsWith(`${method} failed:`)) {
        throw error;
      }
      if (isTransientSslError(error.message) && attempt === maxAttempts) {
        throw new Error(
          `${method} failed: ${error.message}. ` +
            "This is sometimes transient; retry the command if it continues after automatic retries."
        );
      }
      if (!isTransientSslError(error.message) || attempt === maxAttempts) {
        throw error;
      }
    }

    log(
      `[retry] ${method} failed with a transient SSL error ` +
        `(attempt ${attempt}/${maxAttempts}). Retrying in ${LSP_TRANSIENT_SSL_RETRY_DELAY_MS / 1000}s...`
    );
    await sleep(LSP_TRANSIENT_SSL_RETRY_DELAY_MS);
  }

  throw new Error(`${method} failed after ${maxAttempts} attempts`);
}

async function cmdAuth(args) {
  if (!args.tenantId) die("--tenant-id (or CPS_TENANT_ID) is required");
  if (!args.environmentUrl) die("--environment-url (or CPS_ENVIRONMENT_URL) is required");

  const clientId = args.clientId || VSCODE_CLIENT_ID;

  log("Acquiring Copilot Studio API token...");
  const cpsToken = await getOrAcquireToken(
    args.tenantId,
    clientId,
    ["https://api.powerplatform.com/.default"],
    "Copilot Studio API"
  );

  const envUrl = args.environmentUrl.replace(/\/+$/, "");
  log("Acquiring Dataverse API token...");
  const dvToken = await getOrAcquireToken(
    args.tenantId,
    clientId,
    [`${envUrl}/.default`],
    "Dataverse API"
  );

  const result = {
    status: "ok",
    copilotStudio: {
      expiresOn: cpsToken.expiresOn,
      account: cpsToken.account,
    },
    dataverse: {
      expiresOn: dvToken.expiresOn,
      account: dvToken.account,
    },
  };

  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
}

async function acquireLspTokens(args) {
  const agentDir = findAgentDir(args.workspace);
  const conn = loadConnJson(agentDir);
  const clusterCategory = storedClusterCategory(conn, args);
  const tenantId = args.tenantId;

  const envUrl = args.environmentUrl.replace(/\/+$/, "");
  let cpsToken, dvToken;

  if (clusterCategory != null) {
    log(`Cluster category ${clusterCategory} (from .mcs/conn.json)`);
    cpsToken = await getOrAcquireIslandToken(tenantId, clusterCategory, "Island API");
    dvToken = await getOrAcquireToken(
      tenantId, VSCODE_CLIENT_ID,
      [`${envUrl}/.default`],
      "Dataverse API"
    );
  } else {
    cpsToken = await getOrAcquireToken(
      tenantId, VSCODE_CLIENT_ID,
      ["https://api.powerplatform.com/.default"],
      "Copilot Studio API"
    );
    dvToken = await getOrAcquireToken(
      tenantId, VSCODE_CLIENT_ID,
      [`${envUrl}/.default`],
      "Dataverse API"
    );
  }

  return { copilotStudio: cpsToken, dataverse: dvToken };
}

async function cmdWithLsp(args, method) {
  if (!args.workspace) die("--workspace is required");
  if (!args.tenantId) die("--tenant-id (or CPS_TENANT_ID) is required");
  if (!args.environmentId) die("--environment-id (or --url / CPS_ENVIRONMENT_ID) is required");
  requireBotDefinition(args);

  // Never upload unresolved merge markers. Checked before any network call and
  // deliberately not bypassed by --force (which is meant for validation
  // false positives).
  const agentDir = findAgentDir(args.workspace);
  if (method === "powerplatformls/syncPush") {
    const conflicts = findConflictMarkers(agentDir);
    if (conflicts.length > 0) {
      process.stdout.write(
        JSON.stringify({
          status: "error",
          error: `Push refused: unresolved merge conflict markers in ${formatConflicts(conflicts)}. Pick the right version between the markers, delete the marker lines, run validate, then push. --force does not bypass this check.`,
          conflicts,
        }, null, 2) + "\n"
      );
      process.exitCode = 1;
      return;
    }
  }

  // Same for files that do not parse as YAML. validate calls a file valid
  // when a later quote closes an open quote, or when text follows a closing
  // quote, and pushing such a file emptied the topic on the server (measured
  // with this script). --force is for validation false positives, not for
  // broken syntax. Unquoted values that the service keeps (`description:
  // Text: more text`) are not errors; they are logged.
  if (method === "powerplatformls/syncPush") {
    const { errors: syntaxErrors, warnings: yamlWarnings } = scanYamlFiles(agentDir);
    if (syntaxErrors.length > 0) {
      process.stdout.write(
        JSON.stringify({
          status: "error",
          error: `Push refused: YAML syntax errors in ${formatYamlSyntaxErrors(syntaxErrors)}. The real mistake can be above the reported line, for example an unclosed quote. Fix the syntax, run validate, then push. --force does not bypass this check.`,
          syntaxErrors,
        }, null, 2) + "\n"
      );
      process.exitCode = 1;
      return;
    }
    if (yamlWarnings.length > 0) {
      log(`[push] ${yamlWarnings.length} unquoted value(s) that a strict YAML parser rejects, pushing anyway: ${yamlWarnings.map((w) => `${w.file} line ${w.line} (${w.reason})`).join("; ")}`);
    }
  }

  if (!args.environmentUrl || !args.agentMgmtUrl) {
    log("Resolving environment details from BAP API...");
    const envDetails = await resolveEnvironmentById(args.tenantId, args.environmentId, lookupClusterCategory(args));
    if (!args.environmentUrl) args.environmentUrl = envDetails.dataverseUrl;
    if (!args.agentMgmtUrl) args.agentMgmtUrl = envDetails.agentManagementUrl;
    if (!args.environmentName) args.environmentName = envDetails.displayName;
    log(`Resolved: ${envDetails.displayName} (${envDetails.dataverseUrl})`);
  }

  if (!args.environmentUrl) die("Could not resolve --environment-url (or CPS_ENVIRONMENT_URL)");
  if (!args.agentMgmtUrl) die("Could not resolve --agent-mgmt-url (or CPS_AGENT_MGMT_URL)");

  const tokens = await acquireLspTokens(args);
  const binaryInfo = findBinary();
  const client = new LspClient(binaryInfo, args.workspace);

  try {
    await client.start();

    // Pre-push validation: block if errors found
    if (method === "powerplatformls/syncPush" && !args.force) {
      log("[push] Running pre-push validation...");
      const validation = await runValidation(client, args, tokens);
      if (!validation.valid) {
        process.stdout.write(
          JSON.stringify({ status: "error", error: pushBlockedError(validation), validation }, null, 2) + "\n"
        );
        process.exitCode = 1;
        return;
      }
      log(`[push] Validation passed (${validation.summary.warnings} warning(s))`);
    }

    const request = buildSyncRequest(args, tokens);
    log(`Calling ${method}...`);
    const result = await sendCustomRequestWithRetries(client, method, request);

    // syncPull reports success even when it wrote merge markers into a file.
    const conflicts = method === "powerplatformls/syncPull"
      ? findConflictMarkers(agentDir)
      : [];
    if (conflicts.length > 0) {
      process.stdout.write(
        JSON.stringify({
          status: "conflict",
          method,
          result,
          conflicts,
          message: `Pull finished, but the same lines were changed locally and on the server, so merge conflict markers (<<<<<<<, =======, >>>>>>>) were written into: ${formatConflicts(conflicts)}. Pick the right version between the markers, delete the marker lines, run validate, then push.`,
        }, null, 2) + "\n"
      );
      process.exitCode = 1;
    } else {
      process.stdout.write(
        JSON.stringify({ status: "ok", method, result }, null, 2) + "\n"
      );
    }
  } finally {
    await client.stop();
  }
}

async function cmdValidate(args) {
  if (!args.workspace) die("--workspace is required");
  if (!args.tenantId) die("--tenant-id (or CPS_TENANT_ID) is required");
  if (!args.environmentId) die("--environment-id (or --url / CPS_ENVIRONMENT_ID) is required");
  requireBotDefinition(args);

  if (!args.environmentUrl || !args.agentMgmtUrl) {
    log("Resolving environment details from BAP API...");
    const envDetails = await resolveEnvironmentById(args.tenantId, args.environmentId, lookupClusterCategory(args));
    if (!args.environmentUrl) args.environmentUrl = envDetails.dataverseUrl;
    if (!args.agentMgmtUrl) args.agentMgmtUrl = envDetails.agentManagementUrl;
    if (!args.environmentName) args.environmentName = envDetails.displayName;
  }

  if (!args.environmentUrl) die("Could not resolve --environment-url (or CPS_ENVIRONMENT_URL)");
  if (!args.agentMgmtUrl) die("Could not resolve --agent-mgmt-url (or CPS_AGENT_MGMT_URL)");

  const tokens = await acquireLspTokens(args);
  const binaryInfo = findBinary();
  const client = new LspClient(binaryInfo, args.workspace);

  try {
    await client.start();
    const output = await runValidation(client, args, tokens);
    process.stdout.write(JSON.stringify(output, null, 2) + "\n");
    if (output.incomplete) process.exitCode = 1;
  } finally {
    await client.stop();
  }
}

// ---------------------------------------------------------------------------
// BAP / Dataverse REST API helpers (list-envs, list-agents use REST, not LSP)
// ---------------------------------------------------------------------------

const BAP_TOKEN_SCOPE = "https://service.powerapps.com/.default";

async function httpGetJson(url, accessToken) {
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status}: ${body.substring(0, 500)}`);
  }
  return res.json();
}

async function httpPostJson(url, accessToken, body) {
  const payload = body != null ? JSON.stringify(body) : "";
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      "OData-MaxVersion": "4.0",
      "OData-Version": "4.0",
    },
    body: payload || undefined,
    signal: AbortSignal.timeout(60000),
  });
  if (res.status === 204) return null;
  if (!res.ok) {
    const errBody = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status}: ${errBody.substring(0, 500)}`);
  }
  const text = await res.text();
  if (!text.trim()) return null;
  return JSON.parse(text);
}

async function cmdListAgents(args) {
  if (!args.tenantId) die("--tenant-id (or CPS_TENANT_ID) is required");
  if (!args.environmentUrl) die("--environment-url (or CPS_ENVIRONMENT_URL) is required");

  const envUrl = args.environmentUrl.replace(/\/+$/, "");
  const dvToken = await getOrAcquireToken(
    args.tenantId,
    VSCODE_CLIENT_ID,
    [`${envUrl}/.default`],
    "Dataverse API"
  );

  const ownerOnly = args.owner !== false; // default: owned by current user

  // WhoAmI to get current user ID (needed for owner filter or annotation)
  log("Calling WhoAmI...");
  const whoAmI = await httpGetJson(
    `${envUrl}/api/data/v9.2/WhoAmI`,
    dvToken.accessToken
  );
  const systemUserId = whoAmI.UserId;
  log(`Signed in as user: ${systemUserId}`);

  // List unmanaged bots
  const select = encodeURIComponent("botid,name,_ownerid_value");
  const filterParts = ["ismanaged eq false"];
  if (ownerOnly) filterParts.push(`_ownerid_value eq ${systemUserId}`);
  const filter = encodeURIComponent(filterParts.join(" and "));
  log(ownerOnly ? "Listing agents owned by current user..." : "Listing all unmanaged agents...");
  const botsResponse = await httpGetJson(
    `${envUrl}/api/data/v9.2/bots?$select=${select}&$filter=${filter}`,
    dvToken.accessToken
  );

  const agents = (botsResponse.value || []).map((bot) => ({
    agentId: bot.botid,
    displayName: bot.name,
    ownedByCurrentUser: bot._ownerid_value === systemUserId,
  }));

  const result = { status: "ok", agents };
  if (agents.length === 0) {
    result.message = ownerOnly
      ? "No unmanaged agents owned by you in this environment. Retry with --no-owner to list all agents."
      : "No unmanaged agents found in this environment. Verify the environment URL is correct and your account has access.";
  }

  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
}

async function cmdListEnvs(args) {
  if (!args.tenantId) die("--tenant-id (or CPS_TENANT_ID) is required");

  const bapToken = await getOrAcquireToken(
    args.tenantId,
    VSCODE_CLIENT_ID,
    [BAP_TOKEN_SCOPE],
    "Power Platform API"
  );

  const filter = encodeURIComponent("properties/environmentSku ne 'Platform'");
  const url = `https://${getBapHost(DEFAULT_CLUSTER_CATEGORY)}/providers/Microsoft.BusinessAppPlatform/environments?api-version=2024-05-01&$filter=${filter}&$expand=properties.permissions`;

  log("Fetching environments from BAP API...");
  const response = await httpGetJson(url, bapToken.accessToken);

  const environments = (response.value || [])
    .filter((env) => {
      // Only include environments with Dataverse (linked metadata) and edit permissions
      const meta = env.properties?.linkedEnvironmentMetadata;
      const perms = env.properties?.permissions;
      return meta?.instanceUrl && (perms?.UpdateEnvironment || perms?.CreatePowerApp);
    })
    .map((env) => ({
      environmentId: env.name,
      displayName: env.properties.displayName,
      dataverseUrl: env.properties.linkedEnvironmentMetadata.instanceUrl,
      agentManagementUrl: env.properties.runtimeEndpoints?.["microsoft.PowerVirtualAgents"] || null,
      environmentSku: env.properties.environmentSku,
    }));

  process.stdout.write(
    JSON.stringify({ status: "ok", environments }, null, 2) + "\n"
  );
}

// ---------------------------------------------------------------------------
// Resolve environment details by ID — used when --url provides only env + agent IDs
// ---------------------------------------------------------------------------

async function resolveEnvironmentById(tenantId, environmentId, clusterCategory = DEFAULT_CLUSTER_CATEGORY) {
  // Before any sign-in: the host depends on the cluster category, and some have none.
  const bapHost = getBapHost(clusterCategory);
  const bapToken = await getOrAcquireToken(
    tenantId,
    VSCODE_CLIENT_ID,
    [BAP_TOKEN_SCOPE],
    "Power Platform API (env lookup)"
  );

  const url =
    `https://${bapHost}/providers/Microsoft.BusinessAppPlatform/environments/${encodeURIComponent(environmentId)}` +
    `?api-version=2024-05-01&$expand=properties.permissions`;

  log(`Resolving environment details for ${environmentId} on ${bapHost}...`);
  const env = await httpGetJson(url, bapToken.accessToken);

  const meta = env.properties?.linkedEnvironmentMetadata;
  if (!meta?.instanceUrl) {
    throw new Error(
      `Environment ${environmentId} has no linked Dataverse instance. ` +
        "It may not have been provisioned or you may not have access."
    );
  }

  return {
    environmentId: env.name,
    displayName: env.properties.displayName,
    dataverseUrl: meta.instanceUrl,
    agentManagementUrl:
      env.properties.runtimeEndpoints?.["microsoft.PowerVirtualAgents"] || null,
    environmentSku: env.properties.environmentSku,
  };
}

// ---------------------------------------------------------------------------
// Publish — trigger PvaPublish bound action and poll for completion
// ---------------------------------------------------------------------------

const PUBLISH_POLL_INTERVAL_MS = 10000; // 10 seconds

async function cmdPublish(args) {
  if (!args.workspace) die("--workspace is required");

  // resolveConnDefaults has filled these from .mcs/conn.json, after checking them,
  // when the flags did not give them.
  const tenantId = args.tenantId;
  if (!tenantId) die("--tenant-id (or CPS_TENANT_ID) is required");

  const envUrl = (args.environmentUrl || "").replace(/\/+$/, "");
  if (!envUrl) die("--environment-url (or CPS_ENVIRONMENT_URL) is required");

  const botId = args.agentId;
  if (!botId) die("Cannot determine agent ID. Provide --agent-id, or use --workspace of a cloned agent with .mcs/conn.json.");

  const dvToken = await getOrAcquireToken(
    tenantId,
    VSCODE_CLIENT_ID,
    [`${envUrl}/.default`],
    "Dataverse API"
  );

  // Read current publishedon timestamp before triggering publish
  log("Reading current publish timestamp...");
  const botBefore = await httpGetJson(
    `${envUrl}/api/data/v9.2/bots(${botId})?$select=publishedon`,
    dvToken.accessToken
  );
  const previousPublishedOn = botBefore.publishedon || null;
  log(`Current publishedon: ${previousPublishedOn || "(never published)"}`);

  // Trigger PvaPublish bound action
  log("Calling PvaPublish...");
  const publishUrl = `${envUrl}/api/data/v9.2/bots(${botId})/Microsoft.Dynamics.CRM.PvaPublish`;
  let publishResponse;
  try {
    publishResponse = await httpPostJson(publishUrl, dvToken.accessToken, null);
  } catch (err) {
    die(`PvaPublish failed: ${err.message}`);
  }
  log("PvaPublish triggered successfully.");

  // Poll for completion by watching the publishedon timestamp change
  const startTime = Date.now();
  const timeoutMs = args.timeout || 300000;
  log(`Polling for publish completion (timeout: ${timeoutMs / 1000}s)...`);

  while (Date.now() - startTime < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, PUBLISH_POLL_INTERVAL_MS));

    const elapsed = Math.round((Date.now() - startTime) / 1000);
    let botNow;
    try {
      botNow = await httpGetJson(
        `${envUrl}/api/data/v9.2/bots(${botId})?$select=publishedon`,
        dvToken.accessToken
      );
    } catch (err) {
      log(`Poll error (${elapsed}s): ${err.message} — retrying...`);
      continue;
    }

    const currentPublishedOn = botNow.publishedon || null;
    log(`  [${elapsed}s] publishedon: ${currentPublishedOn || "(null)"}`);

    if (currentPublishedOn && currentPublishedOn !== previousPublishedOn) {
      const durationMs = Date.now() - startTime;
      const result = {
        status: "ok",
        botId,
        publishedOn: currentPublishedOn,
        previousPublishedOn,
        durationMs,
        durationSeconds: Math.round(durationMs / 1000),
      };
      if (publishResponse) {
        result.publishResponse = publishResponse;
      }
      process.stdout.write(JSON.stringify(result, null, 2) + "\n");
      return;
    }
  }

  die(`Publish timed out after ${timeoutMs / 1000}s. The publish may still be in progress — check the Copilot Studio UI.`);
}

async function cmdChanges(args) {
  if (!args.workspace) die("--workspace is required");
  if (!args.tenantId) die("--tenant-id (or CPS_TENANT_ID) is required");
  if (!args.environmentId) die("--environment-id (or --url / CPS_ENVIRONMENT_ID) is required");
  requireBotDefinition(args);

  if (!args.environmentUrl || !args.agentMgmtUrl) {
    log("Resolving environment details from BAP API...");
    const envDetails = await resolveEnvironmentById(args.tenantId, args.environmentId, lookupClusterCategory(args));
    if (!args.environmentUrl) args.environmentUrl = envDetails.dataverseUrl;
    if (!args.agentMgmtUrl) args.agentMgmtUrl = envDetails.agentManagementUrl;
    if (!args.environmentName) args.environmentName = envDetails.displayName;
  }

  if (!args.environmentUrl) die("Could not resolve --environment-url (or CPS_ENVIRONMENT_URL)");
  if (!args.agentMgmtUrl) die("Could not resolve --agent-mgmt-url (or CPS_AGENT_MGMT_URL)");

  const agentDir = findAgentDir(args.workspace);
  const conn = loadConnJson(agentDir);
  const clusterCategory = storedClusterCategory(conn, args);
  const tenantId = args.tenantId;

  const envUrl = args.environmentUrl.replace(/\/+$/, "");
  let cpsToken, dvToken;

  if (clusterCategory != null) {
    log(`Cluster category ${clusterCategory} (from .mcs/conn.json)`);
    cpsToken = await getOrAcquireIslandToken(tenantId, clusterCategory, "Island API");
    dvToken = await getOrAcquireToken(
      tenantId, VSCODE_CLIENT_ID,
      [`${envUrl}/.default`],
      "Dataverse API"
    );
  } else {
    cpsToken = await getOrAcquireToken(
      tenantId, VSCODE_CLIENT_ID,
      ["https://api.powerplatform.com/.default"],
      "Copilot Studio API"
    );
    dvToken = await getOrAcquireToken(
      tenantId, VSCODE_CLIENT_ID,
      [`${envUrl}/.default`],
      "Dataverse API"
    );
  }

  const tokens = { copilotStudio: cpsToken, dataverse: dvToken };
  const binaryInfo = findBinary();
  const client = new LspClient(binaryInfo, args.workspace);

  try {
    await client.start();
    const request = buildSyncRequest(args, tokens);

    log("Fetching local changes...");
    const localChanges = await client.sendCustomRequest(
      "powerplatformls/getLocalChanges",
      request
    );

    log("Fetching remote changes...");
    const remoteChanges = await client.sendCustomRequest(
      "powerplatformls/getRemoteChanges",
      request
    );

    process.stdout.write(
      JSON.stringify(
        { status: "ok", localChanges, remoteChanges },
        null,
        2
      ) + "\n"
    );
  } finally {
    await client.stop();
  }
}

// ---------------------------------------------------------------------------
// Clone — needs additional fields vs push/pull
// ---------------------------------------------------------------------------

const SOLUTION_NAMES = [
  "msft_AIPlatformExtensionsComponents",
  "msdyn_RelevanceSearch",
  "PowerVirtualAgents",
];

async function fetchSolutionVersions(envUrl, accessToken) {
  const filter = SOLUTION_NAMES.map((s) => `uniquename eq '${s}'`).join(" or ");
  const query = `$select=uniquename,version&$filter=${encodeURIComponent(filter)}`;
  const url = `${envUrl}/api/data/v9.2/solutions?${query}`;

  log("Fetching solution versions...");
  const response = await httpGetJson(url, accessToken);

  const solutionVersions = {};
  let copilotStudioSolutionVersion = "1.0.0";

  for (const sol of response.value || []) {
    if (sol.uniquename === "PowerVirtualAgents") {
      copilotStudioSolutionVersion = sol.version;
    } else {
      solutionVersions[sol.uniquename] = sol.version;
    }
  }

  return { solutionVersions, copilotStudioSolutionVersion };
}

async function fetchAgentInfo(envUrl, agentId, accessToken) {
  const query = `$select=botid,name,iconbase64&$expand=bot_botcomponentcollection($select=schemaname,botcomponentcollectionid,name)`;
  const url = `${envUrl}/api/data/v9.2/bots(${agentId})?${query}`;

  log(`Fetching agent info for ${agentId}...`);
  const bot = await httpGetJson(url, accessToken);

  return {
    agentId: bot.botid,
    displayName: bot.name,
    displayComplement: "",
    iconBase64: bot.iconbase64 || "",
    componentCollections: (bot.bot_botcomponentcollection || []).map((cc) => ({
      id: cc.botcomponentcollectionid,
      schemaName: cc.schemaname,
      displayName: cc.name,
    })),
  };
}

async function cmdClone(args) {
  if (!args.workspace) die("--workspace is required");
  if (!args.tenantId) die("--tenant-id (or CPS_TENANT_ID) is required");
  if (!args.agentId) die("--agent-id (or --url) is required for clone");
  if (!args.environmentId) die("--environment-id (or --url / CPS_ENVIRONMENT_ID) is required");

  // Cluster category: --cluster-category, else the --url host (preview 4, preprod 3, test 2),
  // else Prod (5). It picks the BAP host for the lookup below and the Island token audience,
  // and it is written to .mcs/conn.json, which push and pull read later.
  const picked = resolveClusterCategory({ option: args.clusterCategory, url: args.url });
  const clusterCategory = picked.category;
  const sources = { option: "from --cluster-category", url: "from the --url host", default: "default, Prod" };
  log(`Cluster category ${clusterCategory} (${sources[picked.source]})`);
  if (picked.source === "option" && picked.conflict) {
    warn(`--url host suggests cluster category ${picked.urlCategory}; using ${clusterCategory} as given.`);
  }

  // When --url was used, environmentUrl and agentMgmtUrl may be missing.
  // Resolve them from the BAP API using the environmentId extracted from the URL.
  if (!args.environmentUrl || !args.agentMgmtUrl) {
    log("Resolving environment details from BAP API...");
    const envDetails = await resolveEnvironmentById(args.tenantId, args.environmentId, clusterCategory);
    if (!args.environmentUrl) args.environmentUrl = envDetails.dataverseUrl;
    if (!args.agentMgmtUrl) args.agentMgmtUrl = envDetails.agentManagementUrl;
    if (!args.environmentName) args.environmentName = envDetails.displayName;
    log(`Resolved: ${envDetails.displayName} (${envDetails.dataverseUrl})`);
  }

  if (!args.environmentUrl) die("Could not resolve --environment-url (or CPS_ENVIRONMENT_URL)");
  if (!args.agentMgmtUrl) die("Could not resolve --agent-mgmt-url (or CPS_AGENT_MGMT_URL)");

  const envUrl = args.environmentUrl.replace(/\/+$/, "");

  const cpsToken = await getOrAcquireIslandToken(args.tenantId, clusterCategory, "Island API");

  const dvToken = await getOrAcquireToken(args.tenantId, VSCODE_CLIENT_ID, [`${envUrl}/.default`], "Dataverse API");

  // Fetch agent info and solution versions from Dataverse
  const [agentInfo, solVersions] = await Promise.all([
    fetchAgentInfo(envUrl, args.agentId, dvToken.accessToken),
    fetchSolutionVersions(envUrl, dvToken.accessToken),
  ]);

  log(`Cloning agent: ${agentInfo.displayName}`);

  const rootFolder = path.resolve(args.workspace);

  // Start LSP and send clone request
  const binaryInfo = findBinary();
  const client = new LspClient(binaryInfo, rootFolder);

  try {
    await client.start();

    const request = {
      accountInfo: {
        accountId: args.accountId || dvToken.account?.homeAccountId || "unknown",
        accountEmail: args.accountEmail || dvToken.account?.username || undefined,
        tenantId: args.tenantId,
        clusterCategory,
      },
      copilotStudioAccessToken: cpsToken.accessToken,
      dataverseAccessToken: dvToken.accessToken,
      environmentInfo: {
        agentManagementUrl: args.agentMgmtUrl,
        dataverseUrl: envUrl,
        displayName: args.environmentName || "Environment",
        environmentId: args.environmentId,
      },
      solutionVersions: solVersions,
      agentInfo,
      assets: { cloneAgent: true, componentcollectionIds: [] },
      rootFolder,
    };

    log("Calling powerplatformls/cloneAgent...");
    const result = await sendCustomRequestWithRetries(
      client,
      "powerplatformls/cloneAgent",
      request
    );

    process.stdout.write(
      JSON.stringify({ status: "ok", method: "powerplatformls/cloneAgent", result }, null, 2) + "\n"
    );
  } finally {
    await client.stop();
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function cmdDoctor(args) {
  const result = doctor.runDoctor(doctor.makeContext(args), {
    locateBinary,
    compareSemver,
    minExtensionVersion: MIN_EXTENSION_VERSION,
    resolveAuthMode,
    findAgentDir: (workspace) => findAgentDir(workspace, true),
    findConflictMarkers,
    formatConflicts,
  });
  for (const c of result.checks) process.stderr.write(doctor.formatLine(c) + "\n");
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  if (result.status === "fail") process.exitCode = 1;
}

async function main() {
  const args = parseArgs();
  // validate, push, pull, changes and publish take tenant, environment, agent and
  // URLs from the workspace's .mcs/conn.json when they were not given.
  resolveConnDefaults(args, { findAgentDir, log, warn, die });

  try {
    switch (args.command) {
      case "auth":
        await cmdAuth(args);
        break;
      case "push":
        await cmdWithLsp(args, "powerplatformls/syncPush");
        break;
      case "pull":
        await cmdWithLsp(args, "powerplatformls/syncPull");
        break;
      case "clone":
        await cmdClone(args);
        break;
      case "changes":
        await cmdChanges(args);
        break;
      case "publish":
        await cmdPublish(args);
        break;
      case "validate":
        await cmdValidate(args);
        break;
      case "list-agents":
        await cmdListAgents(args);
        break;
      case "list-envs":
        await cmdListEnvs(args);
        break;
      case "doctor":
        cmdDoctor(args);
        break;
      default:
        die(`Unknown command: ${args.command}`);
    }
  } catch (e) {
    die(`${args.command} failed: ${e.message}`);
  }

  // Ensure Node exits even if stale event-loop handles linger (e.g. from
  // the LSP binary's pipe server or unresolved timers).
  process.exit(process.exitCode || 0);
}

// Expose helpers for testing when loaded as a module
if (typeof module !== "undefined") {
  module.exports = { parseAgentUrl };
}

main();
