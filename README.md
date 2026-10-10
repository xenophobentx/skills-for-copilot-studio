# Skills for Copilot Studio (xeno fork)

This is a maintained fork of [microsoft/skills-for-copilot-studio](https://github.com/microsoft/skills-for-copilot-studio). It is a plugin for authoring, syncing and testing classic (topic-based) [Copilot Studio](https://aka.ms/CopilotStudio) agents as YAML files from [Claude Code](https://docs.anthropic.com/en/docs/claude-code) or [GitHub Copilot CLI](https://docs.github.com/en/copilot). Since 1.0.11-xeno.4 it also runs in [OpenAI Codex CLI](https://developers.openai.com/codex).

Agents built with the newer Copilot Studio CLI (`template: cliagent-*` or `authoringModel: CliCopilot` in `settings.mcs.yml`) belong to [microsoft/copilot-studio-plugin](https://github.com/microsoft/copilot-studio-plugin). If you open one here, the plugin will read and describe it and point you to that plugin. It won't edit, pull, push or publish it.

## Why use the fork

Things that fail upstream today:

- On macOS, the Copilot Studio extension 1.9 and later keeps the language server in `lspOut/osx-arm64`. Upstream reports "extension not found" and can't sync. The fork finds it there. Unit tested, and run with extension 1.9.14 on all three of my machines.
- npm 12 blocks dependency install scripts by default, so keytar never gets its native binary and the first sign-in fails. I reproduced that on macOS and Windows. The fork lists keytar in `allowScripts`, and if install scripts are turned off it runs keytar's own downloader once. I ran the hook with npm 12.2.0 on all three machines, also with install scripts turned off.
- With microsoft/copilot-studio-plugin installed as well, both plugins use `CLAUDE_PLUGIN_DATA` and `plugin-paths.json`, and upstream's scripts can load the other plugin's folder and fail with `Cannot find module 'vscode-jsonrpc/node'`. I reproduced that on macOS. The fork has its own names (`SFCS_PLUGIN_DATA`, `sfcs-plugin-paths.json`). The fix is unit tested, and I ran validate live on macOS with both plugins' variables set.
- A workspace copied through git has no `.mcs/botdefinition.json`, because `.mcs/.gitignore` excludes everything. Upstream then fails with a `CdsBotId` error or a 400 (issue #155). The fork says what is missing before it touches the network. I saw the upstream error live; the fix is unit tested.

Places where upstream can lose work without telling you:

- When a pull writes conflict markers into a topic, upstream calls it a success (exit 0, also with extension 1.9.14). With extensions older than 1.9.11, `push --force` then uploads the markers to the server byte for byte; I measured that live on macOS with 1.8.22. The fork's pull exits 1 with `"status":"conflict"`, and push refuses any file with markers, with or without `--force`, before it signs in. I tried that guard on all three machines.
- If a quote in a topic's metadata is closed by a later quote, or text follows a closing quote, the language server says `valid: true`, and a push empties the topic on the server. I measured that live with extension 1.9.14, with the language server push that upstream uses and with `pac copilot push`. In the fork, validate and push parse every `.mcs.yml` as YAML first, and push sends nothing if a file fails. I ran that refusal on macOS.
- When the language server returns no diagnostics for some files, upstream reports the agent as valid. With the fork you get `incomplete`, and push is blocked. Unit tested.
- A classic `agent.mcs.yml` whose `instructions` is an object or a list loads as empty instructions, and nothing reports it (upstream issue #175). The fork's validate fails it. Unit tested.

Day to day:

- `--workspace` is enough for validate, push, pull, changes, remote-changes, verify and publish. The tenant, environment, agent and URLs come from `.mcs/conn.json`, the log shows the target, and a URL outside the known Microsoft hosts is refused. I ran validate and push this way live on macOS and Windows.
- `manage-agent remote-changes` (or `pull --dry-run`) shows what the server changed, which of those files you changed too, and whether a pull would write conflict markers. It writes nothing.
- Pull copies the agent folder to `.mcs/backups/<UTC timestamp>/` first and keeps the last five. Unit tested.
- After a push, the script clones the agent into a temp folder and compares it with yours. A difference is a warning, and `push --verify` turns it into exit 1. I only tested this on small agents with topics and nothing else, so on bigger agents it may report differences that aren't real.
- `manage-agent doctor` checks node, the language server, the native modules, the data folder, the sign-in mode, pac and the workspace, and tells you what to fix. It reads no secrets and changes nothing.
- Over SSH, or on Linux without a display, sign-in uses a device code. I got to the code prompt over SSH on Ubuntu and Windows, and on macOS with `SSH_CONNECTION` set, but didn't finish the sign-in.

[FORK.md](FORK.md) has the full list, with what I took from other forks and from open upstream PRs.

## Install

You need Node.js 20 or later and the [Copilot Studio extension for VS Code](https://github.com/microsoft/vscode-copilotstudio). Clone, validate, push and pull use the language server that ships with the extension. VS Code itself doesn't have to be running.

Don't install the fork next to the upstream plugin. Both are called `copilot-studio` and have the same commands.

### Claude Code

```bash
claude plugin marketplace add xenophobentx/skills-for-copilot-studio
claude plugin install copilot-studio@xeno-skills-for-copilot-studio
```

Inside a session, `/plugin marketplace add xenophobentx/skills-for-copilot-studio` and `/plugin install copilot-studio@xeno-skills-for-copilot-studio` do the same.

On Windows, `marketplace add` can fail with `EPERM: operation not permitted, rename ...` and `Failed to finalize marketplace cache`. I saw it on Claude Code 2.1.295 on every attempt, and with other large marketplaces too. Clone the repository and add the clone as the marketplace instead:

```powershell
git clone https://github.com/xenophobentx/skills-for-copilot-studio.git C:\tools\skills-for-copilot-studio
claude plugin marketplace add C:\tools\skills-for-copilot-studio
claude plugin install copilot-studio@xeno-skills-for-copilot-studio
```

The plugin then runs from that clone, so keep the folder. `git pull` in it updates the plugin. Claude Code doesn't install npm packages into a plugin it loads in place, so the plugin's session hook installs them into its data folder.

To load a clone without the marketplace:

```bash
git clone https://github.com/xenophobentx/skills-for-copilot-studio.git

# one session
claude --plugin-dir /path/to/skills-for-copilot-studio

# or add the clone as a marketplace and install from it (user or project scope)
claude plugin marketplace add /path/to/skills-for-copilot-studio
claude plugin install copilot-studio@xeno-skills-for-copilot-studio --scope user
```

### GitHub Copilot CLI

```bash
copilot plugin marketplace add xenophobentx/skills-for-copilot-studio
copilot plugin install copilot-studio@xeno-skills-for-copilot-studio
```

The `/plugin` commands should work inside a Copilot CLI session too, but I haven't run them there.

The VS Code extensions store only has the upstream plugin. I haven't tried the fork in VS Code.

### Codex

```bash
codex plugin marketplace add xenophobentx/skills-for-copilot-studio
codex plugin add copilot-studio@xeno-skills-for-copilot-studio
```

Codex reads the same manifest as Claude Code. The skills show up as `copilot-studio:<skill>`. Ask in plain words or pick one with `/skills`.

What I tested: Codex 0.160 on macOS, installed from a local copy of the Codex branch, with `--yolo` and with the default sandbox. That covered skill routing and authoring, `validate` on a cloned agent, and the setup without a hook described below. With Codex 0.162.1 on macOS (`--yolo`) I also ran the plugin from a folder with a space in its path, a clone into an empty folder, and the device code sign-in with a stand-in command. Claude Code got a smoke test with `claude -p` after the change.

Codex doesn't run a plugin's SessionStart hook until you trust it in `/hooks`, and `codex exec` skips an untrusted hook silently. The hook adds the routing prompt and installs the native modules (keytar, msal-node-extensions, vscode-jsonrpc) that sign-in, push and pull need. I ran it with `--dangerously-bypass-hook-trust`. The trust screen itself, and what an update does to the trust, are untested.

The skills also work without the hook:

- Every skill that changes files checks for a CLI agent workspace on its own and stops.
- For the native modules, run this once, with `<pluginRoot>` replaced by the absolute plugin folder. Keep the quotes, the path may contain spaces.

  ```bash
  node "<pluginRoot>/hooks/setup.js" --ensure
  ```

  A skill that hits `Cannot find module` tells you to run it. It installs into `SFCS_PLUGIN_DATA`, or into the folder in `sfcs-plugin-paths.json` if this copy of the plugin wrote that file, otherwise into `~/.copilot-studio-cli/sfcs-data` (one folder per user). It never installs into the folder named by `CLAUDE_PLUGIN_DATA` or `plugin-paths.json`, because another plugin can own those, and it doesn't write them. `manage-agent doctor` shows which folder is in use. The command waits for the install and gives up after 110 seconds with a message, so a tool call with a two minute limit is enough. Run it again if it ran out of time (`SFCS_ENSURE_TIMEOUT_MS` changes the limit). It needs the network and write access to the folder it installs into.
- Codex has no agent type for the plugin's agents. With the hook, the routing prompt tells Codex to start a general-purpose sub-agent from the agent file. I haven't run that path. Without the hook, the skills run in the main session.

In my runs `codex exec` started with a read-only workspace, so the authoring skills couldn't write files until I passed `-s workspace-write`. Sign-in, clone, push, pull, validate and chat need the network and write access to `~/.copilot-studio-cli`, and neither `codex exec` mode allowed that. The skills run the command first. On a specific sandbox error (network unreachable, permission denied, read-only file system) they ask for just the access that is missing. Where Codex can't ask (`approval_policy = "never"`) they say what is missing and stop.

On macOS I tried a profile with `sandbox_workspace_write.network_access = true` and `~/.copilot-studio-cli` in `sandbox_workspace_write.writable_roots`. `validate` still failed with `UNIX Operation not permitted` at the token cache's credential store, which I take to be the keychain. So on macOS use full access (`--yolo` or `--sandbox danger-full-access`), which is what I tested. On Linux and Windows a narrower profile may be enough; I haven't tried one.

A broken Codex install on macOS (every shell command timing out, for example) can look like a plugin problem. Try `brew reinstall --cask codex` first.

## Quick start

With the plugin's agents:

```text
/copilot-studio:copilot-studio-manage clone
/copilot-studio:copilot-studio-author Create a topic that handles IT service requests
/copilot-studio:copilot-studio-manage push
/copilot-studio:copilot-studio-test Send "How do I request a new laptop?" to the published agent
/copilot-studio:copilot-studio-advisor Review my agent for improvements and known pitfalls
/copilot-studio:copilot-studio-describer Describe everything this agent does
```

The same cycle with the script. `<pluginRoot>` is the plugin folder, and a clone of this repository works. Clone needs the tenant and the agent's Copilot Studio URL. After that, every command takes `--workspace` and reads the rest from `.mcs/conn.json`.

```bash
node "<pluginRoot>/scripts/manage-agent.bundle.js" clone \
  --workspace ./my-agent \
  --tenant-id "<tenantId>" \
  --url "https://copilotstudio.microsoft.com/environments/<envId>/bots/<agentId>/overview"

# edit the files in ./my-agent, by hand or with the author agent

node "<pluginRoot>/scripts/manage-agent.bundle.js" validate --workspace ./my-agent
node "<pluginRoot>/scripts/manage-agent.bundle.js" remote-changes --workspace ./my-agent
node "<pluginRoot>/scripts/manage-agent.bundle.js" pull --workspace ./my-agent
node "<pluginRoot>/scripts/manage-agent.bundle.js" push --workspace ./my-agent
```

If the agent changed on the server since your last clone or pull, push fails with `ConcurrencyVersionMismatch`, so pull first. A push creates a draft. Publish it in Copilot Studio, or with the manage agent, before you test it with `/copilot-studio:copilot-studio-test`. If a sync command fails in a way you don't understand, start with `node "<pluginRoot>/scripts/manage-agent.bundle.js" doctor`.

The five agents:

```
/copilot-studio:copilot-studio-manage       Clone, push, pull and sync agent content between local files and the cloud
/copilot-studio:copilot-studio-author       Create and edit YAML (topics, actions, knowledge, triggers, variables)
/copilot-studio:copilot-studio-test         Test published agents: point tests, batch suites, evaluation analysis
/copilot-studio:copilot-studio-advisor      Design guidance, agent review and troubleshooting
/copilot-studio:copilot-studio-describer    Read-only descriptions and reports of existing agents
```

In Windows PowerShell 5.1, send chat messages that contain quotes with `--message-file`. [SETUP_GUIDE.md](SETUP_GUIDE.md) goes through the whole cycle, including the test options and troubleshooting.

## Updating

Claude Code installs a new copy only when the plugin version changes, so a commit on `main` alone doesn't reach you.

Claude Code leaves auto-update off for marketplaces that aren't Anthropic's. To update by hand, run these and restart Claude Code (or run `/reload-plugins` in a session):

```bash
claude plugin marketplace update xeno-skills-for-copilot-studio
claude plugin update copilot-studio@xeno-skills-for-copilot-studio
```

For background updates, run `/plugin`, open the Marketplaces tab, select `xeno-skills-for-copilot-studio` and choose Enable auto-update. It runs within about ten minutes after your first message in a session. If you added the marketplace from a local clone (the Windows workaround), `git pull` in the clone is the update. See [Claude Code: keep plugins updated](https://code.claude.com/docs/en/discover-plugins#keep-plugins-updated).

GitHub Copilot CLI (the first command refreshes the catalog):

```bash
copilot plugin marketplace update xeno-skills-for-copilot-studio
copilot plugin update copilot-studio@xeno-skills-for-copilot-studio
```

In a session, `/plugin update copilot-studio@xeno-skills-for-copilot-studio` does the same.

Codex:

```bash
codex plugin marketplace upgrade xeno-skills-for-copilot-studio
codex plugin add copilot-studio@xeno-skills-for-copilot-studio
```

Check `/hooks` afterwards. An updated hook may need trusting again; I haven't tested that.

## Uninstalling

Claude Code:

```bash
claude plugin uninstall copilot-studio@xeno-skills-for-copilot-studio
claude plugin marketplace remove xeno-skills-for-copilot-studio
```

Uninstall removes the data folder (`~/.claude/plugins/data/copilot-studio-xeno-skills-for-copilot-studio`) unless you pass `--keep-data`. If it is still there, delete it by hand. Claude Code keeps the old copy under `~/.claude/plugins/cache/xeno-skills-for-copilot-studio` for a while and removes it itself after 14 days.

GitHub Copilot CLI:

```bash
copilot plugin uninstall copilot-studio@xeno-skills-for-copilot-studio
copilot plugin marketplace remove xeno-skills-for-copilot-studio
```

Copilot CLI leaves its data folder, `~/.copilot/plugin-data/xeno-skills-for-copilot-studio/copilot-studio` (under `$COPILOT_HOME` if you set it). Delete it yourself if you want it gone.

Codex:

```bash
codex plugin remove copilot-studio@xeno-skills-for-copilot-studio
codex plugin marketplace remove xeno-skills-for-copilot-studio
```

None of these touch `~/.copilot-studio-cli` (Windows: `%USERPROFILE%\.copilot-studio-cli`), which holds your sign-in cache. The fork's own files in it are `sfcs-plugin-paths.json`, which the session hook writes and which points at folders that are gone after an uninstall, and `sfcs-data` if you ran `setup.js --ensure`. Delete both if they are there. `plugin-paths.json` in the same folder belongs to other Copilot Studio plugins, so leave it.

```bash
rm ~/.copilot-studio-cli/sfcs-plugin-paths.json
rm -rf ~/.copilot-studio-cli/sfcs-data
```

```powershell
Remove-Item "$env:USERPROFILE\.copilot-studio-cli\sfcs-plugin-paths.json"
Remove-Item -Recurse "$env:USERPROFILE\.copilot-studio-cli\sfcs-data"
```

If you installed from a local clone, delete the clone as well.

## How I test

Before a change goes into `main`, the tests run on macOS, Ubuntu 24.04 and Windows 11 with PowerShell 5.1, and I try the change itself on all three unless the limits below say otherwise. The Copilot Studio extension is 1.9.14 on all three. Sync changes also run against a throwaway agent in my own environment, which I restore afterwards.

CI runs every `tests/*.test.js` on ubuntu, macOS and Windows with Node 22 and 24, and on ubuntu with Node 20. It rebuilds the script bundles from the committed lockfile and fails if they differ from the committed ones, and it runs `claude plugin validate`. It uses no secrets.

Before a branch goes into `main`, the whole branch gets one more review, read the way an upstream Microsoft maintainer would read it.

## Relationship to upstream

I merge upstream `main` in from time to time. FORK.md lists the open upstream PRs I took, with their authors, among them the describer agent (#173), the disambiguation check (#157) and skill `name` fields (#179).

Two of my fixes are open upstream: [#192](https://github.com/microsoft/skills-for-copilot-studio/pull/192) makes validate report paths relative to the agent folder, and [#193](https://github.com/microsoft/skills-for-copilot-studio/pull/193) quotes the `argument-hint` values so Copilot CLI loads every skill.

Upstream PRs I left out:

- #129 (Enhanced Task Completion): `SmartTaskCompletionEnabled` isn't in the schema, on Microsoft Learn or in the 1.9.14 language server, and the PR turns on generative actions without asking.
- #165 (Modern Agent support): it writes a folder layout the 1.9.14 language server no longer uses. I took only its `clone --cluster-category` option.
- #136 (GCC): it is built on the old sign-in code, so the device code path would sign in against the wrong authority, and I have no GCC tenant to test on.
- #98 (VS Code extension): a maintainer suggested it live in its own repository, and the VSIX it builds doesn't run.

## Limits and untested parts

- Codex on Linux and Windows: the plugin installs and lists its skills there and the unit tests pass, but I haven't done a model run on either.
- Codex: installing from GitHub with the commands above, interactive approval of a command, and the sub-agent fallback are untested.
- GitHub Copilot CLI hasn't been tested since the Codex change.
- Government clouds (cluster categories 6 to 8) are not supported. Sign-in fails even with `--environment-url` and `--agent-mgmt-url`.
- `clone --cluster-category` was tested live with 4 and 5. Categories 0 to 3 are unit tested only, because I have no test or preprod tenant.
- The check after push was only tried on small agents that hold topics and nothing else.

This is an experimental project, and Microsoft doesn't support it. The Copilot Studio YAML schema can change without notice. Review generated YAML and run validate before you push, because the model can write errors or unsupported patterns.

## License and security

MIT, see [LICENSE](LICENSE). Report security problems in code this fork changed privately through this repository's security advisories, and problems that also exist upstream through [Microsoft's process](https://aka.ms/SECURITY.md). [SECURITY.md](SECURITY.md) has the details. [CONTRIBUTING.md](CONTRIBUTING.md) covers local development and building the bundles.
