# Skills for Copilot Studio

> This is my fork of [microsoft/skills-for-copilot-studio](https://github.com/microsoft/skills-for-copilot-studio) with my fixes and a few open community PRs merged in. Some of the fixes are also open as PRs upstream. I merge upstream changes in from time to time. [FORK.md](FORK.md) lists what differs from upstream.
>
> To install from this fork:
>
> ```bash
> /plugin marketplace add xenophobentx/skills-for-copilot-studio
> /plugin install copilot-studio@xeno-skills-for-copilot-studio
> ```
>
> Don't install it next to the upstream plugin. Both are called `copilot-studio` and have the same commands.

A plugin for [Claude Code](https://docs.anthropic.com/en/docs/claude-code), [GitHub Copilot CLI](https://docs.github.com/en/copilot), [Codex](https://developers.openai.com/codex), and [VS Code](https://code.visualstudio.com/) that enables authoring, testing, and troubleshooting [Microsoft Copilot Studio](https://aka.ms/CopilotStudio) **STANDARD** agents through YAML files, directly from your terminal or editor.

Looking for the plugin for GitHub Copilot harness agents? See the [New Microsoft Copilot Studio Plugin](https://github.com/microsoft/copilot-studio-plugin). If you open a CLI agent workspace here (`template: cliagent-*` or `authoringModel: CliCopilot` in its `settings.mcs.yml`), the plugin is instructed to detect it, only read and describe it (no edits, pull, push or publish), and point you to that plugin.

## Prerequisites

- [Claude Code](https://docs.anthropic.com/en/docs/claude-code), [GitHub Copilot CLI](https://docs.github.com/en/copilot), [Codex](https://developers.openai.com/codex), or [VS Code](https://code.visualstudio.com/)
- [Node.js](https://nodejs.org/) 20 or later
- [VS Code](https://code.visualstudio.com/) with the [Copilot Studio Extension](https://github.com/microsoft/vscode-copilotstudio) (required for push/pull/clone operations)

## Installation

### From marketplace (Claude Code / GitHub Copilot CLI)

```bash
/plugin marketplace add xenophobentx/skills-for-copilot-studio
/plugin install copilot-studio@xeno-skills-for-copilot-studio
```

On Windows, `marketplace add` can fail with `EPERM: operation not permitted, rename ...` and `Failed to finalize marketplace cache`. Seen on Claude Code 2.1.295, on every attempt and also for other large marketplaces. If you get it, clone the repository and add the clone as the marketplace:

```powershell
git clone https://github.com/xenophobentx/skills-for-copilot-studio.git C:\tools\skills-for-copilot-studio
claude plugin marketplace add C:\tools\skills-for-copilot-studio
claude plugin install copilot-studio@xeno-skills-for-copilot-studio
```

The plugin then runs from that clone, so keep the folder. `git pull` in it updates the plugin. Claude Code does not install npm packages into a plugin it loads in place; the plugin's own session hook installs them into its data folder.

### From VS Code Extensions Store (GitHub Copilot)

The VS Code store installs the upstream plugin, not this fork. To use this fork in VS Code, install it from a local clone (below).

Search for **Skills for Copilot Studio** in the VS Code Extensions using the **@agentPlugins** filter to view and click **Install**.

![VS Code Extensions Store](./img/VSCodeStore.png)

### From a local clone

```bash
git clone https://github.com/xenophobentx/skills-for-copilot-studio.git

# Load for a single session
claude --plugin-dir /path/to/skills-for-copilot-studio

# Or install persistently (user-wide)
claude plugin install /path/to/skills-for-copilot-studio --scope user

# Or install for a specific project
claude plugin install /path/to/skills-for-copilot-studio --scope project
```

### Codex

```bash
codex plugin marketplace add xenophobentx/skills-for-copilot-studio
codex plugin add copilot-studio@xeno-skills-for-copilot-studio
```

Codex reads the same manifest as Claude Code, so there is nothing else to package. The skills are listed as `copilot-studio:<skill>`. Ask in plain words or pick one with `/skills`.

What has been tested: Codex 0.160 on macOS, installed from a local copy of this branch, with `--yolo` and with the default sandbox. That covers skill routing and authoring, `validate` on a cloned agent, and the setup without a hook described below. The plugin also installs and lists its skills in Codex on Linux and Windows, and the unit tests pass there. Not yet tested: a full Codex run on Linux and Windows, the `/hooks` trust screen, the sub-agent fallback described below, approving a command interactively, installing from GitHub with the commands above, and GitHub Copilot CLI after this change. Claude Code was smoke-tested with `claude -p`. Codex 0.162.1 on macOS (`--yolo`) was also run with the plugin in a folder with a space in its path, with a clone into an empty folder, and with a stand-in command for the device-code sign-in; the sandbox runs are described below.

The plugin also has a SessionStart hook. Codex does not run a plugin hook until you trust it (`/hooks`), and `codex exec` skips an untrusted hook without saying so. The hook adds the routing prompt and installs the native modules (keytar, msal-node-extensions, vscode-jsonrpc) for sign-in and push/pull. I ran it with `--dangerously-bypass-hook-trust`; the trust screen itself and what an update does to the trust are untested.

The skills also work without the hook:

- Every skill that changes files checks for a CLI agent workspace on its own and stops.
- Native modules: run `node "<pluginRoot>/hooks/setup.js" --ensure` once, with `<pluginRoot>` replaced by the absolute plugin folder (keep the quotes, the path may contain spaces). A skill that hits `Cannot find module` says so. It installs into `SFCS_PLUGIN_DATA`, or into the folder in `sfcs-plugin-paths.json` if that file was written by this copy of the plugin, otherwise into `~/.copilot-studio-cli/sfcs-data`. That folder is per user. It never installs into the folder named by `CLAUDE_PLUGIN_DATA` or `plugin-paths.json`, because another plugin can own those, and it does not write them. `manage-agent doctor` shows which folder is in use. The command waits for the install and stops after 110 seconds with a message, so a tool call with a two minute limit is enough; run it again if it ran out of time (`SFCS_ENSURE_TIMEOUT_MS` changes the limit). It needs the network and write access to the folder it installs into. Run it, and if the sandbox denies the network or the write, allow only that (see Sandbox below).
- Codex has no agent type for the plugin's agents. With the hook, the routing prompt tells Codex to start a general-purpose sub-agent from the agent file. I have not run that path. Without the hook, the skills run in the main session.

Sandbox: in my runs `codex exec` started with a read-only workspace, so the authoring skills could not write files until I passed `-s workspace-write`. Sign-in, clone, push, pull, validate and chat need the network and write to `~/.copilot-studio-cli`, and neither `codex exec` mode allowed that. The skills run the command first. On a concrete sandbox error (network unreachable, permission denied, read-only file system) they ask for only the access that is missing, and where Codex cannot ask (`approval_policy = "never"`) they say which access is missing and stop. On macOS I tried a profile with `sandbox_workspace_write.network_access = true` and `~/.copilot-studio-cli` in `sandbox_workspace_write.writable_roots`: `validate` still failed with `UNIX Operation not permitted`, at the token cache's credential persistence, which I take to be the keychain. On macOS use full access (`--yolo` or `--sandbox danger-full-access`), the option I tested. On Linux and Windows a narrower profile may be enough; I did not test one. Approving a command in an interactive session is untested.

macOS: a problem with the Codex install itself (for example every shell command timing out) is not caused by this plugin. Try reinstalling Codex first (`brew reinstall --cask codex`).

Windows: in PowerShell 5.1, send chat messages that contain quotes through `--message-file`.

## Updating

The update process depends on how you installed the plugin:

| Interface | Update Method | Details |
|-----------|--------------|--------|
| **Claude Code CLI** | Manual, or background auto-update once you turn it on | Claude Code leaves auto-update off for third-party marketplaces, and this is one. See below. |
| **GitHub Copilot CLI** | Manual | Run `copilot plugin update copilot-studio@xeno-skills-for-copilot-studio` from the terminal, or `/plugin update copilot-studio@xeno-skills-for-copilot-studio` in an interactive session. `copilot plugin marketplace update xeno-skills-for-copilot-studio` refreshes the catalog first. |
| **VS Code** | Extension auto-update | VS Code handles updates automatically when extension auto-update is enabled in settings. |
| **Codex** | Manual | Run `codex plugin marketplace upgrade xeno-skills-for-copilot-studio`, then `codex plugin add copilot-studio@xeno-skills-for-copilot-studio` again. Check `/hooks` afterwards, because an updated hook may need trusting again (untested). |

To remove the plugin from Codex:

```bash
codex plugin remove copilot-studio@xeno-skills-for-copilot-studio
codex plugin marketplace remove xeno-skills-for-copilot-studio
```

This leaves `~/.copilot-studio-cli`, which holds your sign-in cache and the installed native modules, alone. Delete it yourself if you want it gone.

### Claude Code

Claude Code turns auto-update on by default only for Anthropic's own marketplaces. For any other marketplace it is off until you enable it. To update by hand, run these in a terminal and then restart Claude Code (or run `/reload-plugins` in a session):

```bash
claude plugin marketplace update xeno-skills-for-copilot-studio
claude plugin update copilot-studio@xeno-skills-for-copilot-studio
```

To have Claude Code do it in the background, run `/plugin`, open the **Marketplaces** tab, select `xeno-skills-for-copilot-studio` and choose **Enable auto-update**. It runs within about ten minutes after you send your first message in a session.

Claude Code installs a new copy only when the plugin version changes, so a commit on `main` alone does not reach you. If you added the marketplace from a local clone (the Windows workaround above), `git pull` in the clone is the update. See [Claude Code: keep plugins updated](https://code.claude.com/docs/en/discover-plugins#keep-plugins-updated).

## Uninstalling

For Claude Code:

```bash
claude plugin uninstall copilot-studio@xeno-skills-for-copilot-studio
claude plugin marketplace remove xeno-skills-for-copilot-studio
```

Uninstall removes the plugin's data folder (`~/.claude/plugins/data/copilot-studio-xeno-skills-for-copilot-studio`) unless you pass `--keep-data`. It does not remove the file the session hook writes outside the plugin folders:

- `~/.copilot-studio-cli/sfcs-plugin-paths.json` (Windows: `%USERPROFILE%\.copilot-studio-cli\sfcs-plugin-paths.json`). It holds the plugin's data and root paths, which are gone after the uninstall. Delete only this file. `plugin-paths.json` in the same folder belongs to other Copilot Studio plugins.

In PowerShell: `Remove-Item "$env:USERPROFILE\.copilot-studio-cli\sfcs-plugin-paths.json"`. On macOS and Linux: `rm ~/.copilot-studio-cli/sfcs-plugin-paths.json`.

If the data folder is still there, delete it by hand. Claude Code keeps the old copy of the plugin under `~/.claude/plugins/cache/xeno-skills-for-copilot-studio` for a while after an uninstall and removes it itself after 14 days.

For GitHub Copilot CLI:

```bash
copilot plugin uninstall copilot-studio@xeno-skills-for-copilot-studio
copilot plugin marketplace remove xeno-skills-for-copilot-studio
```

Copilot CLI leaves the plugin's data folder, `~/.copilot/plugin-data/xeno-skills-for-copilot-studio/copilot-studio` (under `$COPILOT_HOME` if you set it). Delete that folder, and the `sfcs-plugin-paths.json` file above, if you want the plugin gone completely. If you used the local clone, delete the clone as well.

## Usage

The plugin provides five sub-agents, each backed by a specialized agent:

```
/copilot-studio:copilot-studio-manage       Clone, push, pull, and sync agent content between local files and the cloud
/copilot-studio:copilot-studio-author       Create and edit YAML (topics, actions, knowledge, triggers, variables)
/copilot-studio:copilot-studio-test         Test published agents — point-tests, batch suites, or evaluation analysis
/copilot-studio:copilot-studio-advisor      Design guidance, agent review, and troubleshooting
/copilot-studio:copilot-studio-describer    Read-only descriptions and detailed reports of existing agents
```

## Quick Start

```bash
# Clone an agent from the cloud (guided flow, signs in with a browser or a device code over SSH)
/copilot-studio:copilot-studio-manage clone

# Design and build topics
/copilot-studio:copilot-studio-author Create a topic that handles IT service requests

# Pull latest, push your changes
/copilot-studio:copilot-studio-manage pull
/copilot-studio:copilot-studio-manage push

# Publish in Copilot Studio UI, then test
/copilot-studio:copilot-studio-test Send "How do I request a new laptop?" to the published agent

# Get design advice and review
/copilot-studio:copilot-studio-advisor Review my agent for improvements and known pitfalls

# Generate a read-only behavior report
/copilot-studio:copilot-studio-describer Describe everything this agent does
```

See [SETUP_GUIDE.md](SETUP_GUIDE.md) for a full end-to-end walkthrough including validation, testing options, and troubleshooting.


## Disclaimer

This plugin is an experimental research project, not an officially supported Microsoft product. The Copilot Studio YAML schema may change without notice. Always review and validate generated YAML before pushing to your environment — AI-generated output may contain errors or unsupported patterns.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for local development setup, building bundled scripts, and project structure.
