# What this fork changes

This fork follows [microsoft/skills-for-copilot-studio](https://github.com/microsoft/skills-for-copilot-studio) `main` and adds the changes below. I test each change on macOS, Ubuntu 24.04 and Windows 11 before it goes in, and I merge upstream changes in from time to time. Some of the fixes are also open as PRs upstream.

## Sync (manage-agent)

- It finds the language server in the macOS layout of the Copilot Studio extension 1.9 and later (`lspOut/osx-arm64`, `lspOut/osx-x64`). Upstream reports "extension not found" there. If the newest extension folder has no binary, the next version is used. Linux on arm64 looks for the arm64 package.
- Pull reports `"status":"conflict"` and exits 1 when it wrote merge conflict markers into a file. The language server reports such a pull as a success.
- Push refuses files with conflict markers, also with `--force`. Extension 1.9.11 and later refuse this on their own, older versions upload the markers.
- validate and push parse every `.mcs.yml` as YAML first. The language server called a topic with an unclosed quote valid, so push stops before anything is sent. validate also lists conflict markers per file.
- validate fails closed. If the language server returns no diagnostics for some files, the result is `incomplete` and push is blocked. Upstream reports that as valid.
- validate reports file paths relative to the agent folder.
- A push blocked by validation exits 1. Upstream exits 0.
- Push and validate stop early with a clear message when `.mcs/botdefinition.json` is missing, instead of the `CdsBotId` error (upstream issue #155).
- The language server no longer logs an error at the end of every command.
- validate (and `schema-lookup validate`) fails a classic `agent.mcs.yml` whose `instructions` is an object or a list, with source `instructions-shape`. The language server reads it as empty instructions and reports nothing (upstream issue #175).

## Sign-in

- Over SSH, or on Linux without a display, sign-in uses a device code instead of waiting for a browser that can't open. `--auth-mode device` or `--auth-mode interactive` picks one. The browser sign-in gives up after 300 seconds with a message that says what to do.
- Token cache creation is serialized and retried, so parallel commands don't fail on it.
- On Windows the scripts start even when keytar has no native binary (upstream issue #190). Windows doesn't use keytar.

## Setup and environment

- Native dependencies install into a staging folder and are swapped in only when every module loads. A failed or interrupted install is retried at the next session start, and a slow registry no longer blocks the session start for minutes (upstream issue #174).
- The native dependency install works with npm 12, which blocks dependency install scripts unless `allowScripts` lists them. The manifest lists keytar, so its native binary is fetched. npm 10 and 11 ignore the field or only warn.
- If install scripts are off (an `ignore-scripts` setting), the hook does not override it. It still downloads keytar's prebuilt binary from GitHub releases, the same host keytar's own install script uses, first with `npm rebuild keytar --ignore-scripts=false`, which runs only keytar's own install script for that one call, then with `prebuild-install` if that did not produce the binary. The install itself keeps the user's setting.
- The session start hook writes its `SFCS_PLUGIN_DATA` line to the env file once, escaped for bash and zsh.
- The scripts find their native dependencies through `SFCS_PLUGIN_DATA` and `~/.copilot-studio-cli/sfcs-plugin-paths.json`. Upstream uses `CLAUDE_PLUGIN_DATA` and `plugin-paths.json`, the same names as microsoft/copilot-studio-plugin, so with both plugins installed the scripts can load the other plugin's folder and fail with `Cannot find module 'vscode-jsonrpc/node'`.
- `manage-agent doctor` (and the doctor skill) checks node, the language server, native dependencies, the plugin data folder, sign-in mode, pac and the workspace, and says what to fix. It reads no secrets and changes nothing.
- `scripts/package-lock.json` is committed, so the bundles rebuild byte for byte.

## Chat

- `chat-with-agent` refuses a message that arrives split into several arguments, which Windows PowerShell 5.1 does with embedded quotes. `--message-file <path>` sends a message from a file.

## Skills, agents and hooks

- The SessionStart hook adds the full routing prompt only in Copilot Studio projects (a `.mcs` folder or a `*.mcs.yml` file in the session folder or one level down). Other folders get a short pointer, so cloning into an empty folder still works. Based on upstream PR #181 by @hectorfitch-coder.
- The routing prompt is under Claude Code's 10,000 character limit for hook output. Upstream's is over it, so the model only gets a preview of it.
- Every SKILL.md has a `name`, so `npx skills add` loads the skills. Upstream PR #179 by @dudelis.
- Describer agent, upstream PR #173 by @GiorgioUghini.
- Disambiguation check skill, upstream PR #157 by @KarimaKT, run from the advisor.
- Workspaces of the newer CLI-authored agents are detected, and the agents point to microsoft/copilot-studio-plugin instead of editing them.
- `argument-hint` values are quoted, so GitHub Copilot CLI loads every skill.
- MCP and connector requests go to the portal flow first.
- run-tests-kit installs its dependencies from the plugin folder.

## CI

- `.github/workflows/fork-ci.yml` runs on push and pull requests to `main` and `xeno/**`. It runs every `tests/*.test.js` on ubuntu, macOS and Windows with Node 22 and 24, and on ubuntu with Node 20. It rebuilds the bundles and fails when they differ from the committed ones, and it runs `claude plugin validate` with a pinned Claude Code CLI. No secrets are used.
- The README said "Node 18+", which is stale. The dependencies in `scripts/package-lock.json` (msal-node, agents-activity, agents-copilotstudio-client, open) declare `node >=20`, so 20 is the floor and the README now says so. `doctor` still has `MIN_NODE_MAJOR = 18`.
- `.gitattributes` checks text files out with LF. On a Windows runner with `core.autocrlf=true` several tests read the script sources by line and fail on CRLF. A Windows clone that was checked out before this file existed keeps CRLF until it is checked out again once. In PowerShell 5.1 run these two commands (no `&&`), in a clean working tree:

  ```
  git rm -r --cached -q .
  git reset --hard -q
  ```

  Afterwards only `reference/adaptive-card.schema.json` (kept byte for byte) is CRLF.
- The workflow only exists on branches that contain it. The `fix/*`, `feat/*` and `chore/*` branches that become upstream PRs are based on upstream main, so a push to them runs no CI. To get a run, open a draft pull request from the branch into fork `main`. It tests the merge with the fork's changes, so it is close to the branch but not identical.
- The Claude Code version in the `validate-plugin` job is pinned by hand. Use a release that is at least 7 days old.
- `new-release.yml` is kept for clean upstream merges but only runs in microsoft/skills-for-copilot-studio.

## Not taken from upstream PRs

- #129 (Enhanced Task Completion). `SmartTaskCompletionEnabled` is not in the bundled schema, not on Microsoft Learn and not in the 1.9.14 language server, and the PR turns on generative actions without asking.
- #165, #136 and #98 are too large for me to review well for now.
