"""
LeadOS LLM Relay Server
Routes browser requests to the LLM through the Axon MCP integration (JSON-RPC over HTTP).

Required environment variable (one of):
    $env:AXON_API_KEY="ak_..."              (exchanged for a workspace token automatically)
    $env:AXON_WORKSPACE_TOKEN="<token>"     (used as-is, no exchange)

Optional environment variables:
    $env:AXON_MCP_URL="https://platform.bosch-context.com/api/v1/rt/ws/f5uy6rv6l50polntb8gnkk2z/mcp"
    $env:AXON_WORKSPACE_ID="<workspace id, defaults to the id found in AXON_MCP_URL>"
    $env:AXON_TOKEN_URL="https://platform.bosch-context.com/iam/api/v1/token"
    AXON_ASSESSMENT_TOOL="default/performance_and_career_agent"  (used for {role, notes} requests)
    AXON_CHAT_TOOL="default/corpus_prompt_reader"                (used for freeform {messages} requests)
    AXON_CHAT_CORPUS_ID="leados_context"                         (corpus collection read by both tools above)
    $env:PORT="3001"
    $env:RELAY_PROXY_HOST="127.0.0.1"   (local corporate proxy agent; set to "" to disable tunneling)
    $env:RELAY_PROXY_PORT="3128"

Run:
    py relay.py

Then serve LeadOS in a second terminal:
    py -m http.server 8080
Open:
    http://localhost:8080/LeadOS.html
"""
import http.client
import json
import os
import re
import time
from http.server import BaseHTTPRequestHandler, HTTPServer
from socketserver import ThreadingMixIn
from urllib.parse import urlencode, urlsplit


class ThreadedHTTPServer(ThreadingMixIn, HTTPServer):
    daemon_threads = True


def _load_dotenv_local():
    """Loads KEY=VALUE pairs from a local, gitignored .env.local file without overriding real env vars."""
    env_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".env.local")
    if not os.path.exists(env_path):
        return
    with open(env_path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, value = line.partition("=")
            key = key.strip()
            value = value.strip()
            if key and key not in os.environ:
                os.environ[key] = value


_load_dotenv_local()


def _extract_workspace_id(url_parts) -> str:
    match = re.search(r"/ws/([^/]+)/", url_parts.path)
    return match.group(1) if match else ""


MCP_URL = os.getenv("AXON_MCP_URL", "https://platform.bosch-context.com/api/v1/rt/ws/f5uy6rv6l50polntb8gnkk2z/mcp")
API_KEY = os.getenv("AXON_API_KEY", "")
STATIC_TOKEN = os.getenv("AXON_WORKSPACE_TOKEN", "")
PORT = int(os.getenv("PORT", "3001"))
TOKEN_REFRESH_SKEW_SECONDS = 60

# Corporate networks here block direct external DNS/HTTPS; a local proxy agent on 127.0.0.1:3128 handles it.
PROXY_HOST = os.getenv("RELAY_PROXY_HOST", "127.0.0.1")
PROXY_PORT = int(os.getenv("RELAY_PROXY_PORT", "3128"))
USE_PROXY = PROXY_HOST != ""

# These two workspace tools are purpose-built for LeadOS; neither fits generic auto-discovery
# (both require structured arguments, not a single freeform message).
ASSESSMENT_TOOL = os.getenv("AXON_ASSESSMENT_TOOL", "default/performance_and_career_agent")
CHAT_TOOL = os.getenv("AXON_CHAT_TOOL", "default/corpus_prompt_reader")
CHAT_TARGET_RESOURCE_ID = os.getenv("AXON_CHAT_CORPUS_ID", "leados_context")

_mcp_url = urlsplit(MCP_URL)
WORKSPACE_ID = os.getenv("AXON_WORKSPACE_ID") or _extract_workspace_id(_mcp_url)
IAM_TOKEN_URL = os.getenv("AXON_TOKEN_URL") or f"{_mcp_url.scheme}://{_mcp_url.netloc}/iam/api/v1/token"
_iam_url = urlsplit(IAM_TOKEN_URL)

_session_id = None
_initialized = False
_next_id = 1

_cached_token = STATIC_TOKEN or None
_cached_token_expiry = float("inf") if STATIC_TOKEN else 0.0


def _https_connection(url_parts, timeout):
    """Opens an HTTPSConnection, tunneling through the local corporate proxy agent via CONNECT if enabled."""
    if USE_PROXY:
        conn = http.client.HTTPSConnection(PROXY_HOST, PROXY_PORT, timeout=timeout)
        conn.set_tunnel(url_parts.hostname, url_parts.port or 443)
        return conn
    return http.client.HTTPSConnection(url_parts.hostname, url_parts.port or 443, timeout=timeout)


def _exchange_api_key_for_token() -> str:
    global _cached_token, _cached_token_expiry

    payload = urlencode({
        "grant_type": "urn:ietf:params:oauth:grant-type:token-exchange",
        "subject_token": API_KEY,
        "subject_token_type": "urn:bosch:params:oauth:token-type:api-key",
        "audience": "Axon",
        "scope": f"workspace:{WORKSPACE_ID}",
    }).encode()

    conn = _https_connection(_iam_url, timeout=30)
    try:
        conn.request("POST", _iam_url.path or "/", body=payload, headers={
            "Content-Type": "application/x-www-form-urlencoded",
            "Content-Length": str(len(payload)),
        })
        resp = conn.getresponse()
        raw = resp.read()
        if resp.status < 200 or resp.status >= 300:
            raise RuntimeError(f"Token exchange failed (HTTP {resp.status}): {raw.decode(errors='replace')[:200]}")
        data = json.loads(raw)
        token = data.get("access_token")
        if not token:
            raise RuntimeError("Token exchange response did not include an access_token.")
        _cached_token = token
        _cached_token_expiry = time.time() + (float(data.get("expires_in") or 300)) - TOKEN_REFRESH_SKEW_SECONDS
        print("[relay] Exchanged Axon API key for a fresh workspace token.")
        return token
    except OSError as error:
        raise RuntimeError(f"Cannot reach Axon IAM endpoint: {error}") from error
    finally:
        conn.close()


def _get_access_token() -> str:
    if _cached_token and time.time() < _cached_token_expiry:
        return _cached_token
    if not API_KEY:
        if _cached_token:
            return _cached_token
        raise RuntimeError("Set AXON_API_KEY (preferred) or AXON_WORKSPACE_TOKEN environment variable.")
    return _exchange_api_key_for_token()


def _mcp_request(method: str, params: dict, notification: bool = False):
    global _session_id, _next_id

    token = _get_access_token()

    body = {"jsonrpc": "2.0", "method": method, "params": params}
    if not notification:
        body["id"] = _next_id
        _next_id += 1
    payload = json.dumps(body).encode()

    headers = {
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream",
        "Authorization": f"Bearer {token}",
    }
    if _session_id:
        headers["Mcp-Session-Id"] = _session_id

    conn = _https_connection(_mcp_url, timeout=60)
    try:
        conn.request("POST", _mcp_url.path or "/", body=payload, headers=headers)
        resp = conn.getresponse()
        raw = resp.read()
        session_header = resp.getheader("Mcp-Session-Id")
        if session_header:
            _session_id = session_header
        content_type = resp.getheader("Content-Type", "")

        if notification or resp.status == 202 or not raw.strip():
            return None
        return _parse_mcp_body(raw.decode(errors="replace"), content_type)
    except OSError as error:
        raise RuntimeError(f"Cannot reach Axon MCP endpoint: {error}") from error
    finally:
        conn.close()


def _parse_mcp_body(raw: str, content_type: str):
    if "text/event-stream" in content_type:
        last_message = None
        for line in raw.split("\n"):
            line = line.strip()
            if not line.startswith("data:"):
                continue
            json_text = line[5:].strip()
            if json_text:
                last_message = json.loads(json_text)
        if last_message is None:
            raise ValueError("No data received from MCP event stream.")
        return _unwrap_json_rpc(last_message)
    return _unwrap_json_rpc(json.loads(raw))


def _unwrap_json_rpc(message: dict):
    if message.get("error"):
        raise RuntimeError(message["error"].get("message", "MCP request failed."))
    return message.get("result")


def _ensure_session():
    global _initialized
    if _initialized:
        return
    _mcp_request("initialize", {
        "protocolVersion": "2025-06-18",
        "capabilities": {},
        "clientInfo": {"name": "leados-relay", "version": "1.0.0"},
    })
    _mcp_request("notifications/initialized", {}, notification=True)
    _initialized = True


def _reset_session():
    global _session_id, _initialized
    _session_id = None
    _initialized = False


def _extract_text(call_result) -> str:
    # The MCP server doesn't always return the {content:[{type,text}]} shape; sometimes it's a bare string.
    if isinstance(call_result, str):
        text = call_result.strip()
    else:
        content = (call_result or {}).get("content", []) if isinstance(call_result, dict) else []
        parts = []
        for item in content:
            if isinstance(item, str):
                parts.append(item)
            elif isinstance(item, dict) and item.get("type") == "text":
                parts.append(item.get("text", ""))
        text = "\n".join(parts).strip()
    if not text:
        raise RuntimeError("The AI model returned an empty response. Try again.")
    return text


def _call_tool(tool_name: str, arguments: dict) -> str:
    _ensure_session()
    print(f"[relay] -> MCP tools/call \"{tool_name}\": {json.dumps(arguments)}")
    result = _mcp_request("tools/call", {"name": tool_name, "arguments": arguments})
    if isinstance(result, dict) and result.get("isError"):
        raise RuntimeError(_extract_text(result) or "MCP tool call failed.")
    return _extract_text(result)


def _call_tool_with_retry(tool_name: str, arguments: dict) -> str:
    try:
        return _call_tool(tool_name, arguments)
    except RuntimeError as error:
        # The cached session can go stale (e.g. server-side session expiry); reset and retry once.
        print(f"[relay] MCP call to \"{tool_name}\" failed, resetting session and retrying once: {error}")
        _reset_session()
        return _call_tool(tool_name, arguments)


def call_assessment_tool(role: str, notes: str) -> str:
    # performance_and_career_agent takes a single free-text message plus a corpus target, not separate {role, notes}.
    message = f"Role: {role}\n\n{notes}"
    return _call_tool_with_retry(ASSESSMENT_TOOL, {
        "message": message,
        "target_resource_kind": "corpus",
        "target_resource_id": CHAT_TARGET_RESOURCE_ID,
    })


def call_chat_tool(prompt: str) -> str:
    return _call_tool_with_retry(CHAT_TOOL, {
        "message": prompt,
        "target_resource_kind": "corpus",
        "target_resource_id": CHAT_TARGET_RESOURCE_ID,
    })


class RelayHandler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        print(f"[relay] {fmt % args}")

    def send_cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_cors()
        self.end_headers()

    def do_GET(self):
        if self.path == "/ping":
            self.send_response(200)
            self.send_header("Content-Type", "text/plain")
            self.send_cors()
            self.end_headers()
            self.wfile.write(b"relay OK")
            return
        self.send_response(404)
        self.end_headers()

    def do_POST(self):
        length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(length)
        try:
            parsed = json.loads(body)
        except json.JSONDecodeError:
            self.send_response(400)
            self.send_header("Content-Type", "application/json")
            self.send_cors()
            self.end_headers()
            self.wfile.write(json.dumps({"error": "Invalid JSON body."}).encode())
            return

        try:
            if "role" in parsed and "notes" in parsed:
                content = call_assessment_tool(parsed["role"], parsed["notes"])
            else:
                messages = parsed.get("messages") or []
                user_prompt = messages[-1]["content"] if messages else ""
                if not user_prompt:
                    raise ValueError("Request body must include either {role, notes} or {messages}.")
                content = call_chat_tool(user_prompt)
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_cors()
            self.end_headers()
            response = {"choices": [{"message": {"content": content}, "finish_reason": "stop"}]}
            self.wfile.write(json.dumps(response).encode())
            print("[relay] MCP call succeeded")
        except Exception as exc:
            print(f"[relay] Error: {exc}")
            self.send_response(502)
            self.send_header("Content-Type", "application/json")
            self.send_cors()
            self.end_headers()
            self.wfile.write(json.dumps({"error": str(exc)}).encode())


if __name__ == "__main__":
    server = ThreadedHTTPServer(("localhost", PORT), RelayHandler)
    print(f"\n  LeadOS LLM relay ready on http://localhost:{PORT}")
    print(f"  Routing via Axon MCP: {MCP_URL}")
    print(f"  Tunneling via local proxy: {PROXY_HOST}:{PROXY_PORT}" if USE_PROXY else "  Connecting directly (no proxy)")
    print("\n  In a second terminal, serve LeadOS:")
    print("    py -m http.server 8080")
    print("  Then open: http://localhost:8080/LeadOS.html\n")
    server.serve_forever()
