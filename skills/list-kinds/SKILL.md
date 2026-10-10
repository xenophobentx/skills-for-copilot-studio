---
name: list-kinds
user-invocable: false
description: List all available kind discriminator values from the Copilot Studio YAML schema. Use when the user asks what kinds/types are available.
argument-hint: <optional-filter-keyword>
allowed-tools: Bash(node *schema-lookup.bundle.js *), Bash(node *schema-lookup.bundle.js" *)
---

# List Available Kind Values

List all available `kind` discriminator values from the schema, dynamically.

`$ARGUMENTS` is the text the user gave with this skill. If your client does not fill it in, use the user's request instead.

## Locate the plugin files

`<pluginRoot>` below is the plugin folder, the one that holds `skills/`, `scripts/` and `templates/`. Work it out once and use absolute paths from then on.

1. This file is `<pluginRoot>/skills/list-kinds/SKILL.md`. In Claude Code `<pluginRoot>` is `${CLAUDE_SKILL_DIR}/../..`. If that shows up as literal text, your client does not fill it in: take the folder two levels above the folder of this file.
2. Otherwise read `pluginRoot` from `~/.copilot-studio-cli/sfcs-plugin-paths.json`. The setup hook writes it, so it can name another installed copy.

Check that the file you need exists under `<pluginRoot>` before you use it. In commands, put the whole path in double quotes, as the examples do: the folder name can contain spaces.

## Instructions

1. Run the schema lookup script to get all kinds:
   ```bash
   node "<pluginRoot>/scripts/schema-lookup.bundle.js" kinds
   ```

2. If `$ARGUMENTS` contains a filter keyword, filter the output to show only matching kinds.

3. Categorize the results for easier reading:
   - **Triggers** — kinds starting with "On" (e.g., OnRecognizedIntent, OnConversationStart)
   - **Actions** — node actions (e.g., SendActivity, Question, SetVariable)
   - **Dialogs** — dialog types (e.g., AdaptiveDialog, TaskDialog, AgentDialog)
   - **Cards** — card templates (e.g., AdaptiveCardTemplate, HeroCardTemplate)
   - **Knowledge Sources** — knowledge kinds (e.g., KnowledgeSourceConfiguration)
   - **Inputs** — input kinds (e.g., AutomaticTaskInput, ManualTaskInput)

4. Present the categorized list to the user.

**Important**: Always use the script output as the source of truth. Do NOT hardcode kind values.
