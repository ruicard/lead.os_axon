"""
LeadOS LLM Relay Server
Routes browser requests through the local corporate proxy to Bosch Model Farm.

Required environment variable:
    $env:BMF_API_KEY="<your subscription key>"

Optional environment variables:
    $env:BMF_SUBSCRIPTION_ID="personal-...-prod"
    $env:BMF_DEPLOYMENT="gpt-5-nano-2025-08-07"
    $env:BMF_API_VERSION="2025-04-01-preview"
    $env:PORT="3001"

Run:
    py relay.py

Then serve LeadOS in a second terminal:
    py -m http.server 8080
Open:
    http://localhost:8080/LeadOS.html
"""
import json
import os
import socket
import ssl
from http.server import BaseHTTPRequestHandler, HTTPServer
from socketserver import ThreadingMixIn
from urllib.parse import quote, urlencode


class ThreadedHTTPServer(ThreadingMixIn, HTTPServer):
    daemon_threads = True


PROXY_HOST = os.getenv("PROXY_HOST", "localhost")
PROXY_PORT = int(os.getenv("PROXY_PORT", "3128"))
LLM_HOST = os.getenv("BMF_HOST", "aoai-farm.bosch-temp.com")
DEPLOYMENT = os.getenv("BMF_DEPLOYMENT", "gpt-5-nano-2025-08-07")
API_VERSION = os.getenv("BMF_API_VERSION", "2025-04-01-preview")
SUBSCRIPTION_ID = os.getenv("BMF_SUBSCRIPTION_ID", "")
API_KEY = os.getenv("BMF_API_KEY", "")
PORT = int(os.getenv("PORT", "3001"))


def build_llm_path() -> str:
    params = {"api-version": API_VERSION}
    if SUBSCRIPTION_ID:
        params["subscription-id"] = SUBSCRIPTION_ID
    return f"/api/openai/deployments/{quote(DEPLOYMENT)}/chat/completions?{urlencode(params)}"


def decode_chunked_body(response_body: bytes) -> bytes:
    decoded = b""
    pos = 0
    while pos < len(response_body):
        line_end = response_body.find(b"\r\n", pos)
        if line_end < 0:
            break
        size = int(response_body[pos:line_end], 16)
        if size == 0:
            break
        chunk_start = line_end + 2
        decoded += response_body[chunk_start:chunk_start + size]
        pos = chunk_start + size + 2
    return decoded


def forward_through_proxy(body: bytes) -> tuple[int, bytes]:
    if not API_KEY:
        raise RuntimeError("BMF_API_KEY environment variable is not set.")

    raw_sock = socket.create_connection((PROXY_HOST, PROXY_PORT), timeout=30)
    connect_req = (
        f"CONNECT {LLM_HOST}:443 HTTP/1.1\r\n"
        f"Host: {LLM_HOST}:443\r\n"
        f"\r\n"
    ).encode()
    raw_sock.sendall(connect_req)

    resp = b""
    while b"\r\n\r\n" not in resp:
        chunk = raw_sock.recv(4096)
        if not chunk:
            break
        resp += chunk

    first_line = resp.split(b"\r\n")[0].decode(errors="replace")
    if "200" not in first_line:
        raw_sock.close()
        raise ConnectionError(f"Proxy CONNECT failed: {first_line}")

    raw_sock.settimeout(None)
    ctx = ssl.create_default_context()
    tls_sock = ctx.wrap_socket(raw_sock, server_hostname=LLM_HOST)

    http_req = (
        f"POST {build_llm_path()} HTTP/1.1\r\n"
        f"Host: {LLM_HOST}\r\n"
        f"genaiplatform-farm-subscription-key: {API_KEY}\r\n"
        f"Content-Type: application/json\r\n"
        f"Content-Length: {len(body)}\r\n"
        f"Connection: close\r\n"
        f"\r\n"
    ).encode() + body
    tls_sock.sendall(http_req)

    raw_response = b""
    while True:
        chunk = tls_sock.recv(16384)
        if not chunk:
            break
        raw_response += chunk
    tls_sock.close()

    separator = raw_response.find(b"\r\n\r\n")
    if separator < 0:
        raise ValueError("Malformed HTTP response from LLM")

    header_section = raw_response[:separator].decode(errors="replace")
    response_body = raw_response[separator + 4:]
    status_code = int(header_section.split(" ")[1])

    if "transfer-encoding: chunked" in header_section.lower():
        response_body = decode_chunked_body(response_body)

    return status_code, response_body


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
            status, response_body = forward_through_proxy(body)
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_cors()
            self.end_headers()
            self.wfile.write(response_body)
            print(f"[relay] LLM responded HTTP {status} ({len(response_body)} bytes)")
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
    print(f"  Routing via proxy {PROXY_HOST}:{PROXY_PORT}")
    print(f"  Target: https://{LLM_HOST}")
    print("\n  In a second terminal, serve LeadOS:")
    print("    py -m http.server 8080")
    print("  Then open: http://localhost:8080/LeadOS.html\n")
    server.serve_forever()
