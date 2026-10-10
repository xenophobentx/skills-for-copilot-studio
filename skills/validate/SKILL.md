---
name: validate
user-invocable: false
description: Validate Copilot Studio agent YAML files using the LSP binary's full diagnostics (YAML structure, Power Fx, schema, cross-file references). Use when the user asks to check, validate, or verify YAML files.
argument-hint: <path-to-agent-workspace>
allowed-tools: Bash(node *manage-agent.bundle.js *), Bash(node *manage-agent.bundle.js" *), Bash(node *schema-lookup.bundle.js *), Bash(node *schema-lookup.bundle.js" *), Read, Glob
---

# Validate Agent YAML

Validate Copilot Studio agent YAML files using the LanguageServerHost binary's full diagnostics — the same validation engine used by the VS Code Copilot Studio extension.

**Sandbox.** `manage-agent.bundle.js validate` signs in, calls the network and writes to `~/.copilot-studio-cli`. `schema-lookup.bundle.js` is local. Run the command and do not assume it is blocked: a sandbox can allow the network and the folders it needs. If the command fails with a concrete sandbox error (network unreachable, `EPERM`, permission denied, read-only file system), ask for only the access that is missing (the network, write access to the folder in the error, or on macOS the keychain) and run it again. If you cannot ask (Codex with `approval_policy = "never"`), say which access is missing and stop.

## Locate the plugin files

`<pluginRoot>` below is the plugin folder, the one that holds `skills/`, `scripts/` and `templates/`. Work it out once and use absolute paths from then on.

1. This file is `<pluginRoot>/skills/validate/SKILL.md`. In Claude Code `<pluginRoot>` is `${CLAUDE_SKILL_DIR}/../..`. If that shows up as literal text, your client does not fill it in: take the folder two levels above the folder of this file.
2. Otherwise read `pluginRoot` from `~/.copilot-studio-cli/sfcs-plugin-paths.json`. The setup hook writes it, so it can name another installed copy.

Check that the file you need exists under `<pluginRoot>` before you use it. In commands, put the whole path in double quotes, as the examples do: the folder name can contain spaces. If a script fails with `Cannot find module` or says the native dependencies are missing, run `node "<pluginRoot>/hooks/setup.js" --ensure` once and try again. It installs them without a hook and can take a minute.

## Instructions

1. **Locate the agent workspace.** Find the directory containing `.mcs/conn.json`. If a specific file was requested, use the workspace that contains it.

2. **Run LSP-based validation**:
   ```bash
   node "<pluginRoot>/scripts/manage-agent.bundle.js" validate \
     --workspace "<path-to-agent-folder>"
   ```
   This validates all `.mcs.yml` files in the workspace using the LSP binary's full diagnostics: YAML structure, Power Fx expressions, schema validation, cross-file references, and environment-specific checks.

   The language server does not catch every YAML syntax error (a quote closed by a later quote, or text after a closing quote, still comes back as valid), so validate also parses each file itself. A file that does not parse shows up as an error with `source: "yaml-syntax"`, and the line and column are in the message and in `range` (zero-based, like the other diagnostics). The reported line is where the parser gave up, which can be below the real mistake, for example after an unclosed quote.

   Some unquoted values are warnings: a value that contains `: ` (for example `description: Text: more text`), ends with a colon, or starts with `@`, a backtick, `%`, `*`, `!` or `- `. The service keeps them and returns them from a clone, and the language server reads them as the literal text, but a strict YAML parser rejects them. They show up with `severity: "warning"` and `source: "yaml-lenient"`, the file stays valid, and push goes ahead. Quote the value if the file is also read by other YAML tools. If the same file has a real error, only the error is reported until it is fixed.

   validate also checks that `instructions` in the agent's root `agent.mcs.yml` is a string, because the language server drops an object or a list there without a diagnostic. The result is an error with `source: "instructions-shape"`. Child agents in `agents/` are not checked.

   Files that still contain merge conflict markers (`<<<<<<<`, `=======`, `>>>>>>>`, left by a conflicted pull) are reported with `source: "conflict-markers"`, one error per file that lists the marker lines, and are not parsed further. Resolve the markers first, then validate again.

   The script reads tenant ID, environment ID and the URLs from `.mcs/conn.json` in the workspace, so `--workspace` is enough. Do not read `conn.json` to copy them into flags. A folder without `conn.json` has no `.mcs/botdefinition.json` either and validate stops on that: clone the agent again into a new folder instead of asking the user for IDs. If the script lists several agents, run it again with the folder of the one you mean.

3. **Parse the JSON output**:
   - `status: "ok"` / `valid: true` → all files pass (may still have warnings)
   - `valid: false` + `summary.errors > 0` → report errors as FAIL items
   - `status: "incomplete"` (also `incomplete: true`, with a non-zero exit code) → the language server timed out or exited before publishing diagnostics for every file, or a file could not be read. **This is NOT a pass.** Report `message` and the files listed in `missingFiles` and `unreadableFiles` as UNVERIFIED, and re-run validation. Do not tell the user the YAML is valid.
   - `summary.warnings > 0` → report as WARN items
   - Each file with diagnostics is listed with severity, message, code, and line range

   If the command fails with `No .mcs/botdefinition.json found`, the workspace was restored from git or copied without `.mcs/`. Do not try to validate or push it: `clone` the agent again into a new folder, copy the edited YAML files over it, and validate that folder. See the manage-agent skill.

4. **If the user asked about a specific file**, filter the output to show only that file's diagnostics.

5. **For additional context on specific errors**, use schema lookup:
   ```bash
   node "<pluginRoot>/scripts/schema-lookup.bundle.js" resolve <kind>
   ```

6. **Report findings**:

   ```
   Validation Results for: <agent-name>

   [PASS] <filename> — no issues
   [FAIL] <filename> — <error message> (line X)
   [WARN] <filename> — <warning message> (line X)
   [UNVERIFIED] <filename> — no diagnostics received (validation incomplete)

   Summary: X files checked, Y errors, Z warnings
   ```
