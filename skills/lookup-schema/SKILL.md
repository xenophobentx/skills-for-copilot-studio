---
name: lookup-schema
user-invocable: false
description: Look up Copilot Studio YAML schema definitions. Use when the user asks about schema structure, element properties, or how to use a specific YAML kind.
argument-hint: <definition-name>
allowed-tools: Bash(node *schema-lookup.bundle.js *)
agent: copilot-studio-advisor
---

# Lookup Schema Definition

Look up and explain a Copilot Studio YAML schema definition.

## Locate the plugin files

`<pluginRoot>` below is the plugin folder, the one that holds `skills/`, `scripts/` and `templates/`. Work it out once and use absolute paths from then on.

1. This file is `<pluginRoot>/skills/lookup-schema/SKILL.md`. In Claude Code `<pluginRoot>` is `${CLAUDE_SKILL_DIR}/../..`. If that shows up as literal text, your client does not fill it in: take the folder two levels above the folder of this file.
2. Otherwise read `pluginRoot` from `~/.copilot-studio-cli/sfcs-plugin-paths.json`. The setup hook writes it, so it can name another installed copy.

Check that the file you need exists under `<pluginRoot>` before you use it.

## Instructions

1. Run the schema lookup script to find the definition:
   ```bash
   node <pluginRoot>/scripts/schema-lookup.bundle.js lookup $ARGUMENTS
   ```

2. If the definition is not found, search for similar definitions:
   ```bash
   node <pluginRoot>/scripts/schema-lookup.bundle.js search $ARGUMENTS
   ```

3. If the definition contains `$ref` references that need resolution, use:
   ```bash
   node <pluginRoot>/scripts/schema-lookup.bundle.js resolve $ARGUMENTS
   ```

4. Present the schema definition in a readable format, explaining:
   - What the element does (from the description)
   - Required properties
   - Optional properties and their types
   - Any related definitions that might be useful

## Example

User: `/lookup-schema SendActivity`

Response should include the full schema definition and explain how to use it in YAML.

## Schema-valid does not mean synced

A kind that is in the schema can still be ignored by `push`. For example `EvaluationSet` and `EvaluationData` are only picked up from a `testcases/` folder and never come back on `pull`. If the user wants a test set, use `/copilot-studio:create-eval-set` (a CSV for the Evaluate tab), not these kinds.

