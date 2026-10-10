---
name: NL to Query Compilation
description: Describe each API tool in modelDescription, with field meanings, valid values and glossaries, so the orchestrator turns the user's words into correct API parameters.
challenge: The orchestrator guesses API parameter values when the tool description does not say what the fields mean, and it fails most often on opaque codes and IDs.
status: recommended
tags: [modelDescription, glossary, api, tools, AutomaticTaskInput, orchestrator, openapi]
---

## Pattern

The generative orchestrator reads the `modelDescription` of a tool and the `description` of each input when it decides which tool to call and what to pass in. Put what it needs to know there: what the API returns, what each parameter does, which values are valid, and for coded APIs a glossary from the user's words to the API's codes. No custom model and no topic code are involved. The orchestrator does the translation when it plans the call.

An OpenAPI upload fills `modelDescription` with the `summary` of the operation. That is rarely enough.

Edit `modelDescription` with `edit-action` after the tool has been added in the portal and pulled.

## How much to write

| API type | What goes into modelDescription |
|---|---|
| Simple REST with free-text search and obvious parameters | What the API does, what each parameter means, formats such as `YYYY-MM-DD` |
| Enum-heavy APIs (status codes, category filters) | The field descriptions and each valid value with a readable label |
| Coded APIs (SDMX keys, indicator codes) | A full glossary from user terms to API codes |

Without this the orchestrator does not know which fields exist or how to map the user's words to filter values. It then guesses or leaves the parameter out. A tool whose `status` parameter takes `active|archived|draft` can be called with a made-up value such as `open` unless the description lists the valid ones.

Opaque codes are the worst case:

- SDMX: `B.U2.EUR.4F.KR.MRR_FR.LEV` for "ECB main refinancing rate"
- REST: `indicator=NY.GDP.MKTP.KD.ZG` for "GDP growth"
- Filters: `coicop=CP00&unit=RCH_A` for "headline inflation, annual rate of change"

## Levels

Light, for an API with obvious parameters:

```yaml
modelDescription: Searches the product catalog. 'category' filters by product category (electronics, clothing, home, sports). 'sort' orders results (price-asc, price-desc, rating, newest). 'q' is free-text search. 'inStock' is true or false.
```

Medium, with enum values and labels:

```yaml
modelDescription: Retrieves HR policy documents. 'region' accepts NA (North America), EMEA (Europe, Middle East, Africa), APAC (Asia-Pacific). 'policyType' accepts wfh (work from home), travel, benefits, leave. 'effectiveDate' is YYYY-MM-DD.
```

Full glossary, for coded APIs. The format is:

```
GLOSSARY: "[user term]"/"[alias]"->[param]=[value]. "[user term]"->[param]=[value] [param2]=[value2]. [param]=FORMAT_HINT. [fixedParam]=[default].
```

An example:

```yaml
modelDescription: 'Retrieves ECB monetary and exchange rate data via SDMX. GLOSSARY: "refi rate"/"MRR"/"main refinancing rate"->flowRef=FM key=B.U2.EUR.4F.KR.MRR_FR.LEV. "deposit rate"/"DFR"->flowRef=FM key=B.U2.EUR.4F.KR.DFR.LEV. "marginal lending"/"MLF"->flowRef=FM key=B.U2.EUR.4F.KR.MLF_FR.LEV. "EUR/USD"/"euro dollar"->flowRef=EXR key=D.USD.EUR.SP00.A. startPeriod and endPeriod are YYYY-MM. format=jsondata.'
```

## Glossary rules

1. Put the user's term on the left and the API value on the right. List common synonyms and abbreviations, separated by `/`.
2. Name the parameter each value goes into, for example `flowRef=FM`.
3. When one term needs several parameters, list them together: `flowRef=FM key=B.U2...`.
4. Give format hints for dates and times: `YYYY-MM`, `YYYY`, `ISO-8601`.
5. List fixed defaults, such as `format=jsondata`.
6. Quote the whole value. A glossary contains `: ` (after `GLOSSARY`), and an unquoted YAML value ends at that point, so the file is no longer valid YAML. This fork's `validate` reports it as "bad indentation of a mapping entry". Single quotes work with the double quotes inside the glossary. Double an apostrophe inside the text (`don''t`).

On line breaks: `validate` on language server 1.9.14 accepts `modelDescription` as a `|`, `>` or `>-` block scalar. What I did not check is how the server stores a value with line breaks and how the orchestrator reads it. Start with one single-quoted line. If the glossary gets long enough that you want line breaks, test the tool in the Test pane after the push before you rely on it.

## Where things belong

| Content | Where |
|---|---|
| API parameter mappings, glossaries, dimension codes | `modelDescription` of the action file |
| Persona, tone, output format, date defaults | Agent instructions (`settings.mcs.yml`) |
| Orchestration across tools, follow-up suggestions | Agent instructions |

Keep each mapping in one place. If it is in `modelDescription`, do not repeat it in the instructions, or the two copies drift apart.

Large glossaries make the text the orchestrator reads per tool longer. Two tools with big overlapping glossaries can confuse the tool choice. The `disambiguation` skill checks for that.

## Show the translation

You can ask the agent to say what it is about to send, so the user can correct a wrong mapping. Add this to the agent instructions:

```
Before you call an API tool, state in one sentence the query parameters you will use.
```

## Several tools

Each tool's `modelDescription` should be complete by itself. The orchestrator picks a tool from its description and then uses that tool's own glossary. Do not put a shared glossary for all tools into the agent instructions.

## When the parameters are wrong

1. Check that the term is in the glossary of the right tool.
2. Check the `description` of the `AutomaticTaskInput`: does it state the expected format?
3. Call the API by hand with the parameters you expect. Does it return data?
4. Add aliases for terms the users actually type.
5. Use the visible translation above to see what the agent chose, then fix that glossary entry.
