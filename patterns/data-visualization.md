---
name: Data Visualization in Chat
description: Show charts, diagrams and tables in agent replies with URL-rendered images (QuickChart, Mermaid.ink) or native Adaptive Cards.
challenge: Copilot Studio chat has no chart widget, and an API that returns an image or a PDF cannot be used as a tool, so agents that work with data have no obvious way to show a chart.
status: experimental
tags: [chart, diagram, mermaid, quickchart, adaptive-card, visualization, privacy]
---

## Pattern

Plugin tools expect JSON. An API that returns binary data (a chart image, a PDF) cannot be a tool, because the response cannot be parsed. Chat can show an image from markdown syntax, `![alt text](url)`. A service that renders an image from URL parameters therefore needs no tool call. The agent builds the URL in its reply text and the chat client loads the image.

Whether the image shows depends on the channel. Test each channel you ship on.

## Data leaves your tenant (QuickChart and Mermaid.ink)

With options A and B the chart data, or the diagram text, is part of the image URL. The user's client sends that URL to a third-party service (`quickchart.io`, `mermaid.ink`). That service, and any proxy or log between, sees the values. The full URL also stays in the conversation transcript.

- Do not use these services for personal data, customer data, financial figures or anything else confidential, unless your security team has approved the service.
- Check the data policies of the environment before you add the instructions below.
- To keep the data inside, run your own copy. QuickChart (AGPL-3.0) and mermaid.ink (MIT) are open source and publish Docker images. Point the URL at your own host.
- Option C, the Adaptive Card, sends nothing to a third party.

## Option A: QuickChart (Chart.js through a URL)

[QuickChart](https://quickchart.io) renders a Chart.js configuration as a PNG. The configuration goes into the `c` query parameter as URL-encoded JSON.

Add to the agent instructions:

```
## Charts
When the user asks for a chart, or a chart would help:
1. Get the data from the API tool.
2. Build the URL https://quickchart.io/chart?c={CHART_CONFIG}
3. URL-encode the chart configuration JSON.
4. Show it as markdown: ![Chart description](URL)

Chart configuration example:
{"type":"line","data":{"labels":["2022","2023","2024"],"datasets":[{"label":"GDP growth %","data":[1.0,2.5,3.2]}]}}

Supported types: line, bar, pie, doughnut, radar, scatter.
Label the axes, give units, and title the chart.
```

Good: many chart types, no sign-in. Bad: the URL length limit (about 2000 characters in some clients) caps the data set, and it is an external dependency.

## Option B: Mermaid.ink (diagrams through a URL)

[Mermaid.ink](https://mermaid.ink) renders Mermaid syntax as an image. The diagram text is base64-encoded into the URL path.

Add to the agent instructions:

```
## Diagrams
When a process, timeline or comparison would be clearer as a diagram:
1. Write the diagram in Mermaid syntax.
2. Base64-encode it.
3. Show it: ![Diagram](https://mermaid.ink/img/{base64_encoded_mermaid})

Mermaid example before encoding:
graph LR
  A[User question] --> B[Orchestrator]
  B --> C[API tool]
  C --> D[Response]
```

Good: flowcharts, sequence diagrams, Gantt charts, timelines. Bad: weak for data-heavy charts, and the model has to base64-encode correctly, which it can get wrong for longer diagrams.

## Option C: Adaptive Card (native)

An Adaptive Card is rendered by the platform, so there is no external service and no URL length limit. It has no chart element. It is good for tables, fact sets and summaries.

```yaml
- kind: SendActivity
  id: sendCard_x7Kp2m
  activity:
    attachments:
      - kind: AdaptiveCardTemplate
        cardContent: |
          {
            "type": "AdaptiveCard",
            "$schema": "http://adaptivecards.io/schemas/adaptive-card.json",
            "version": "1.5",
            "body": [
              {
                "type": "TextBlock",
                "text": "ECB interest rates",
                "weight": "Bolder",
                "size": "Medium"
              },
              {
                "type": "FactSet",
                "facts": [
                  { "title": "Main refinancing rate", "value": "4.50%" },
                  { "title": "Deposit facility", "value": "4.00%" },
                  { "title": "As of", "value": "2024-03" }
                ]
              }
            ]
          }
```

For a card with input fields or buttons, use the `add-adaptive-card` skill, which writes an `AdaptiveCardPrompt`.

## Choosing

| Need | Option |
|---|---|
| Line, bar or pie chart from non-sensitive data | QuickChart |
| Process flow, timeline, architecture diagram without sensitive content | Mermaid.ink |
| Tables, KPI cards, summaries, or any sensitive data | Adaptive Card |
| A chart and a table in one reply | QuickChart image plus an Adaptive Card table |

## Limits of the URL options

- The URL length limit (about 2000 characters in some clients) means small data sets. Aggregate before charting.
- The image is static: no hover, zoom or click.
- The client must be able to reach the service.
- There is no tool call, so the agent has no output to process further.
