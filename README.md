# LeadOS

Single-file Associate Career Development app backed by local browser storage.

## LLM Text Processing

LeadOS calls the LLM through a local relay that connects to the Axon MCP integration, so the browser does not call the MCP endpoint directly.

1. Open PowerShell in this folder.
2. Create an API key for this workspace in Axon IAM, then set it for the current shell (the relay exchanges it for a short-lived workspace token automatically and refreshes it before it expires):

```powershell
$env:AXON_API_KEY="ak_your_api_key"
```

   Alternatively, if you already have a workspace token (e.g. obtained via the curl exchange below), you can set it directly and skip the exchange:

```powershell
$env:AXON_WORKSPACE_TOKEN="<your workspace token>"
```

```bash
curl -sS -X POST 'https://platform.bosch-context.com/iam/api/v1/token' \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  --data-urlencode 'grant_type=urn:ietf:params:oauth:grant-type:token-exchange' \
  --data-urlencode 'subject_token=ak_your_api_key' \
  --data-urlencode 'subject_token_type=urn:bosch:params:oauth:token-type:api-key' \
  --data-urlencode 'audience=Axon' \
  --data-urlencode 'scope=workspace:f5uy6rv6l50polntb8gnkk2z'
```

3. Start the relay:

```powershell
py relay.py
```

4. In a second PowerShell terminal, serve the app:

```powershell
py -m http.server 8080
```

5. Open `http://localhost:8080/LeadOS.html`.

Optional relay settings:

```powershell
$env:AXON_MCP_URL="https://platform.bosch-context.com/api/v1/rt/ws/f5uy6rv6l50polntb8gnkk2z/mcp"
$env:AXON_WORKSPACE_ID="<workspace id, defaults to the id found in AXON_MCP_URL>"
$env:AXON_TOKEN_URL="https://platform.bosch-context.com/iam/api/v1/token"
$env:AXON_MCP_TOOL="<tool name, skips auto-discovery>"
$env:PORT="3001"
```

On first call, the relay lists the tools exposed by the Axon MCP server and auto-selects one whose name looks like a chat/completion tool. If none match, it logs the available tool names to the console — set `AXON_MCP_TOOL` to the correct one and restart the relay.


