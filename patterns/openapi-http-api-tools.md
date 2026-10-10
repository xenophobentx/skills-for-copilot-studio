---
name: OpenAPI HTTP API Tools
description: Write an OpenAPI spec for a public REST API so the Copilot Studio REST API tool accepts it at upload and parses the responses at runtime.
challenge: A spec that works in Swagger UI or Postman can fail at upload or at runtime in Copilot Studio, and the error messages do not say why.
status: experimental
tags: [openapi, rest-api, tools, http, plugin, troubleshooting]
---

## Pattern

Copilot Studio turns an uploaded OpenAPI spec into tools the orchestrator can call. The platform has its own limits on response types, default formats and parameter handling, so a spec that is correct for other tools can still fail here. This pattern lists the rules that avoid the usual failures.

The upload happens in the portal, because the tool needs a connection. After that, `manage-agent pull` brings the action file down and `edit-action` changes its YAML. `add-action` covers connector actions, not REST API uploads.

## Where this comes from

The portal path and the file format come from the Microsoft Learn page "Extend your agent with tools from a REST API": Add tool, New tool, REST API, then upload a specification. Learn describes the upload as a JSON file in v2 format and says a v3 file is translated to v2 on creation. The example below is JSON for that reason.

The spec rules and the error table below come from the original author's testing in April 2026 (KarimaKT). They have not been rechecked against the current portal. That is why the status is `experimental`.

## Test the API first

Call each endpoint by hand before you write the spec.

```powershell
Invoke-RestMethod "https://api.example.com/data?param=value&format=json"
```

| Check | Why |
|---|---|
| JSON output | Many institutional APIs (Eurostat, ECB, OECD) answer in XML by default. If the API can return XML, add a `format` query parameter with a JSON default to the spec. Without it the tool receives XML and fails with `JsonReaderException '<' is invalid`. |
| Response shape | A top-level JSON array `[...]` instead of an object `{...}` makes Power Fx fail with "Expecting Record but received a Table". The spec has to declare `type: object` whatever the real shape is. |
| URL pattern | SDMX-style APIs want path dimensions in a fixed order (for example `freq.unit.coicop.geo`). A wrong order gives a 400 or an empty result. |
| Required parameters | Note which query parameters are mandatory and which have API defaults you should not rely on. |

## Minimal working spec

```json
{
  "openapi": "3.0.0",
  "info": { "title": "My API", "version": "1.0" },
  "servers": [{ "url": "https://api.example.com" }],
  "paths": {
    "/data/{param}": {
      "get": {
        "operationId": "getData",
        "summary": "Short summary",
        "parameters": [
          {
            "name": "param",
            "in": "path",
            "required": true,
            "schema": { "type": "string" },
            "description": "Brief description"
          },
          {
            "name": "format",
            "in": "query",
            "required": true,
            "schema": { "type": "string", "default": "JSON" },
            "description": "Response format"
          }
        ],
        "responses": {
          "200": {
            "description": "Success",
            "content": {
              "application/json": { "schema": { "type": "object" } }
            }
          }
        }
      }
    }
  }
}
```

## Rules

1. Declare the response schema as `type: object`, also when the API returns an array. A bare `type: object` is enough. You do not need to describe every field.
2. If the API can answer in XML, force JSON with a required query parameter that has a default value, as `format` does above.
3. Keep descriptions short at upload time. Long descriptions or special characters made the save fail with "Something went wrong". Write the long version later into `modelDescription` of the pulled action file with `edit-action`. See the NL to Query Compilation pattern for what to put there.
4. Give a `default` to parameters that always have the same value, such as `per_page: 500`.
5. Leave out `security` and `securitySchemes` for an API without authentication, and pick "None" as the authentication in the portal.

## Parameters

In the portal step where you pick the tool parameters, the original author found that nothing was preselected and that every path and query parameter needed "Add input". Only the added ones became `AutomaticTaskInput` entries in the action YAML, and the orchestrator could not fill the others at runtime. This is the most common reason for a tool that ignores the values it is given.

The Learn page describes this step as a review of the inputs and outputs read from the spec, with editable descriptions, and mentions no "Add input" button. The portal may have changed since. After the pull, open the action file and check that every parameter you need is listed under `inputs`. If one is missing, add it in the portal and pull again.

## Common errors

| Symptom | Cause | Fix |
|---|---|---|
| `JsonReaderException '<' is invalid` | The API returned XML | Add a `format` query parameter with a JSON default |
| `Expecting Record but received Table` | The response is a top-level JSON array | Change the response schema to `type: object` |
| "Something went wrong" on save | Long descriptions, special characters or a complex schema | Shorten the descriptions, simplify the schema |
| The tool ignores parameter values | The parameter was not added as an input | Check `inputs` in the pulled action, add it in the portal, pull again |
| 404 at runtime | The path parameters do not match the real URL | Test the URL by hand and fix the path in the spec |
| The tool is missing from `actions/` after a pull | The tool was not saved in the portal, or the pull ran against another agent | Check the tool in the portal and the agent in `.mcs/conn.json`, then pull again |

A pull does create files that exist only on the server. On language server 1.9.14 a pull wrote a topic that the local folder did not have yet.
