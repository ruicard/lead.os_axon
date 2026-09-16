# LeadOS

Single-file Associate Career Development app backed by local browser storage.

## LLM Text Processing

LeadOS calls Bosch Model Farm through a local relay so the browser does not call the BMF endpoint directly.

1. Open PowerShell in this folder.
2. Set your BMF subscription key for the current shell:

```powershell
$env:BMF_API_KEY="<your subscription key>"
$env:BMF_SUBSCRIPTION_ID="personal-<your-id>-prod"
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
$env:BMF_DEPLOYMENT="gpt-5-nano-2025-08-07"
$env:BMF_API_VERSION="2025-04-01-preview"
$env:PORT="3001"
$env:PROXY_HOST="localhost"
$env:PROXY_PORT="3128"
```
