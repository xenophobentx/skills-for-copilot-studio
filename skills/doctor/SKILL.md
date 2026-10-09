---
name: doctor
user-invocable: true
description: Check the local setup for Copilot Studio push and pull. Reports Node, the LanguageServerHost binary, native dependencies, sign-in cache files, pac and the state of an agent workspace. Use when clone, push, pull or sign-in fails, or on a new machine.
argument-hint: "[--workspace <path>]"
allowed-tools: Bash(node *manage-agent.bundle.js doctor*), Read, Glob
---

# Doctor

Read-only check of the machine and, if you give one, an agent workspace. It makes no network calls, does not sign in, and never opens token or keyring contents. It only looks at file names, sizes and dates.

## Run it

```bash
node ${CLAUDE_SKILL_DIR}/../../scripts/manage-agent.bundle.js doctor [--workspace "<path>"]
```

Without `--workspace` it checks the current folder if it looks like an agent folder.

## Read the result

Each line on stderr is `OK`, `WARN` or `FAIL`, then the check name and what to do. The same list comes as JSON on stdout. `status` is `ok` when nothing failed, and the exit code is 1 when something did.

Show the user the WARN and FAIL lines as they are, and say what the line tells them to do. Do not fix scripts or settings on your own. If a line says to start a new session or clone the agent again, tell the user and let them decide.

## What it checks

- Node 18 or newer, the OS, PowerShell version on Windows, SSH or no display.
- LanguageServerHost from the VS Code extension (path, version, executable bit, `CPS_LSP_BINARY`).
- keytar and `@azure/msal-node-extensions` load, and the setup marker `native-deps.json` matches. The path of `install.log` is shown when it exists.
- `~/.copilot-studio-cli/plugin-paths.json` points to folders that exist.
- Linux: whether a D-Bus session is there. Without a keyring, tokens fall back to a plaintext file.
- Cache files under `~/.copilot-studio-cli` (name, size, date).
- `pac` on PATH or `CPS_PAC_PATH`, version 2.13.1 or newer.
- Workspace: `.mcs/conn.json`, `.mcs/botdefinition.json`, merge markers in `.mcs.yml` files, CLI agent or classic, UNC path on Windows.
