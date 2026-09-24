'use strict';

// LLM Relay Server for LeadOS
// Routes browser requests to the LLM through the Axon MCP integration (JSON-RPC over HTTP).
//
// Required environment variable (one of):
//   $env:AXON_API_KEY="ak_..."              (exchanged for a workspace token automatically)
//   $env:AXON_WORKSPACE_TOKEN="<token>"     (used as-is, no exchange)
// Optional environment variables:
//   $env:AXON_MCP_URL="https://platform.bosch-context.com/api/v1/rt/ws/f5uy6rv6l50polntb8gnkk2z/mcp"
//   $env:AXON_WORKSPACE_ID="<workspace id, defaults to the id found in AXON_MCP_URL>"
//   $env:AXON_TOKEN_URL="https://platform.bosch-context.com/iam/api/v1/token"
//   $env:AXON_MCP_TOOL="<tool name, skips auto-discovery>"
//   $env:PORT="3001"
//   $env:RELAY_PROXY_HOST="127.0.0.1"   (local corporate proxy agent; set to "" to disable tunneling)
//   $env:RELAY_PROXY_PORT="3128"
//
// Run:
//   node relay.js

const http = require('http');
const https = require('https');
const tls = require('tls');
const fs = require('fs');
const path = require('path');
const { URL, URLSearchParams } = require('url');

// Loads KEY=VALUE pairs from a local, gitignored .env.local file without overriding real env vars.
function loadDotEnvLocal() {
  const envPath = path.join(__dirname, '.env.local');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (key && !(key in process.env)) process.env[key] = value;
  }
}
loadDotEnvLocal();

const MCP_URL = process.env.AXON_MCP_URL || 'https://platform.bosch-context.com/api/v1/rt/ws/f5uy6rv6l50polntb8gnkk2z/mcp';
const API_KEY = process.env.AXON_API_KEY || '';
const STATIC_TOKEN = process.env.AXON_WORKSPACE_TOKEN || '';
const WORKSPACE_ID = process.env.AXON_WORKSPACE_ID || extractWorkspaceId(MCP_URL);
const IAM_TOKEN_URL = process.env.AXON_TOKEN_URL || `${new URL(MCP_URL).origin}/iam/api/v1/token`;
const FORCED_TOOL = process.env.AXON_MCP_TOOL || '';
const PORT = Number(process.env.PORT || 3001);
const TOKEN_REFRESH_SKEW_MS = 60000;

// Corporate networks here block direct external DNS/HTTPS; a local proxy agent on 127.0.0.1:3128 handles it.
const PROXY_HOST = process.env.RELAY_PROXY_HOST !== undefined ? process.env.RELAY_PROXY_HOST : '127.0.0.1';
const PROXY_PORT = Number(process.env.RELAY_PROXY_PORT || 3128);
const USE_PROXY = PROXY_HOST !== '';

const PROMPT_ARG_CANDIDATES = ['message', 'prompt', 'input', 'query', 'text'];
const TOOL_NAME_HINTS = /chat|complete|generate|ask|llm|prompt|agent/i;

let mcpSessionId = null;
let mcpInitialized = false;
let cachedTool = null;
let nextRequestId = 1;

let cachedToken = STATIC_TOKEN || null;
let cachedTokenExpiry = STATIC_TOKEN ? Infinity : 0;
let tokenExchangeInFlight = null;

function extractWorkspaceId(mcpUrl) {
  const match = new URL(mcpUrl).pathname.match(/\/ws\/([^/]+)\//);
  return match ? match[1] : '';
}

// Tunnels an HTTPS request through the local corporate proxy agent via CONNECT, or connects directly if disabled.
function httpsRequest(options, payload) {
  return USE_PROXY ? httpsRequestViaProxy(options, payload) : httpsRequestDirect(options, payload);
}

function httpsRequestDirect(options, payload) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => collectResponse(res, resolve, reject));
    req.on('error', (error) => reject(new Error(`Cannot reach ${options.hostname}: ${error.message}`)));
    if (payload) req.write(payload);
    req.end();
  });
}

function httpsRequestViaProxy(options, payload) {
  return new Promise((resolve, reject) => {
    const targetPort = options.port || 443;
    const connectReq = http.request({
      host: PROXY_HOST,
      port: PROXY_PORT,
      method: 'CONNECT',
      path: `${options.hostname}:${targetPort}`,
      headers: { Host: `${options.hostname}:${targetPort}` }
    });
    connectReq.on('connect', (proxyRes, socket) => {
      if (proxyRes.statusCode !== 200) {
        socket.destroy();
        reject(new Error(`Proxy CONNECT to ${options.hostname} failed: HTTP ${proxyRes.statusCode}`));
        return;
      }
      const tlsSocket = tls.connect({ socket, servername: options.hostname }, () => {
        const req = https.request({ ...options, agent: false, createConnection: () => tlsSocket }, (res) => collectResponse(res, resolve, reject));
        req.on('error', reject);
        if (payload) req.write(payload);
        req.end();
      });
      tlsSocket.on('error', reject);
    });
    connectReq.on('error', (error) => reject(new Error(`Cannot reach local proxy ${PROXY_HOST}:${PROXY_PORT}: ${error.message}`)));
    connectReq.end();
  });
}

function collectResponse(res, resolve, reject) {
  const chunks = [];
  res.on('data', (data) => chunks.push(data));
  res.on('error', reject);
  res.on('end', () => resolve({ statusCode: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
}

async function exchangeApiKeyForToken() {
  const target = new URL(IAM_TOKEN_URL);
  const payload = new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
    subject_token: API_KEY,
    subject_token_type: 'urn:bosch:params:oauth:token-type:api-key',
    audience: 'Axon',
    scope: `workspace:${WORKSPACE_ID}`
  }).toString();

  const res = await httpsRequest({
    hostname: target.hostname,
    port: target.port || 443,
    path: target.pathname + target.search,
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Content-Length': Buffer.byteLength(payload)
    }
  }, payload);

  if (res.statusCode < 200 || res.statusCode >= 300) {
    throw new Error(`Token exchange failed (HTTP ${res.statusCode}): ${res.body.slice(0, 200)}`);
  }
  const data = JSON.parse(res.body);
  if (!data.access_token) throw new Error('Token exchange response did not include an access_token.');
  cachedToken = data.access_token;
  cachedTokenExpiry = Date.now() + (Number(data.expires_in) || 300) * 1000 - TOKEN_REFRESH_SKEW_MS;
  console.log('[relay] Exchanged Axon API key for a fresh workspace token.');
  return cachedToken;
}

async function getAccessToken() {
  if (cachedToken && Date.now() < cachedTokenExpiry) return cachedToken;
  if (!API_KEY) {
    if (cachedToken) return cachedToken;
    throw new Error('Set AXON_API_KEY (preferred) or AXON_WORKSPACE_TOKEN environment variable.');
  }
  if (!tokenExchangeInFlight) {
    tokenExchangeInFlight = exchangeApiKeyForToken().finally(() => { tokenExchangeInFlight = null; });
  }
  return tokenExchangeInFlight;
}

async function mcpRequest(method, params, { notification = false } = {}) {
  const token = await getAccessToken();
  const body = notification
    ? { jsonrpc: '2.0', method, params }
    : { jsonrpc: '2.0', id: nextRequestId++, method, params };
  const payload = JSON.stringify(body);

  const target = new URL(MCP_URL);
  const headers = {
    'Content-Type': 'application/json',
    'Accept': 'application/json, text/event-stream',
    'Content-Length': Buffer.byteLength(payload),
    'Authorization': `Bearer ${token}`
  };
  if (mcpSessionId) headers['Mcp-Session-Id'] = mcpSessionId;

  let res;
  try {
    res = await httpsRequest({
      hostname: target.hostname,
      port: target.port || 443,
      path: target.pathname + target.search,
      method: 'POST',
      headers
    }, payload);
  } catch (error) {
    throw new Error(`Cannot reach Axon MCP endpoint: ${error.message}`);
  }

  const sessionHeader = res.headers['mcp-session-id'];
  if (sessionHeader) mcpSessionId = sessionHeader;

  if (notification || res.statusCode === 202 || !res.body.trim()) return null;
  return parseMcpBody(res.body, res.headers['content-type'] || '');
}

function parseMcpBody(raw, contentType) {
  if (contentType.includes('text/event-stream')) {
    let lastMessage = null;
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      const jsonText = trimmed.slice(5).trim();
      if (jsonText) lastMessage = JSON.parse(jsonText);
    }
    if (!lastMessage) throw new Error('No data received from MCP event stream.');
    return unwrapJsonRpc(lastMessage);
  }
  return unwrapJsonRpc(JSON.parse(raw));
}

function unwrapJsonRpc(message) {
  if (message.error) throw new Error(message.error.message || 'MCP request failed.');
  return message.result;
}

async function ensureSession() {
  if (mcpInitialized) return;
  await mcpRequest('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'leados-relay', version: '1.0.0' }
  });
  await mcpRequest('notifications/initialized', {}, { notification: true });
  mcpInitialized = true;
}

async function discoverTool() {
  if (cachedTool) return cachedTool;
  const result = await mcpRequest('tools/list', {});
  const tools = result?.tools || [];
  if (!tools.length) throw new Error('Axon MCP server reported no available tools.');

  let tool;
  if (FORCED_TOOL) {
    tool = tools.find((t) => t.name === FORCED_TOOL);
    if (!tool) throw new Error(`Configured AXON_MCP_TOOL "${FORCED_TOOL}" was not found. Available tools: ${tools.map((t) => t.name).join(', ')}`);
  } else {
    // Only consider tools whose only required input is a single freeform prompt/message field;
    // tools that also require corpus/role context (e.g. corpus_prompt_reader) can't be called generically.
    tool = tools.find((t) => TOOL_NAME_HINTS.test(t.name) && isSimplePromptTool(t));
    if (!tool) {
      console.log('[relay] Available MCP tools:', tools.map((t) => t.name).join(', '));
      throw new Error(`Could not auto-detect a chat tool. Set AXON_MCP_TOOL to one of: ${tools.map((t) => t.name).join(', ')}`);
    }
  }

  console.log(`[relay] Using MCP tool "${tool.name}"`);
  cachedTool = tool;
  return tool;
}

function isSimplePromptTool(tool) {
  const required = tool.inputSchema?.required || [];
  if (required.length > 1) return false;
  if (required.length === 1 && required[0] !== 'messages' && !PROMPT_ARG_CANDIDATES.includes(required[0])) return false;
  return true;
}

function buildToolArguments(tool, userPrompt) {
  const props = tool.inputSchema?.properties || {};
  if ('messages' in props) return { messages: [{ role: 'user', content: userPrompt }] };
  const key = PROMPT_ARG_CANDIDATES.find((k) => k in props);
  return { [key || 'prompt']: userPrompt };
}

function extractText(callResult) {
  const content = callResult?.content || [];
  const text = content.filter((c) => c.type === 'text').map((c) => c.text).join('\n').trim();
  if (!text) throw new Error('The AI model returned an empty response. Try again.');
  return text;
}

async function callThroughMcp(userPrompt) {
  await ensureSession();
  const tool = await discoverTool();
  const args = buildToolArguments(tool, userPrompt);
  const result = await mcpRequest('tools/call', { name: tool.name, arguments: args });
  if (result?.isError) throw new Error(extractText(result) || 'MCP tool call failed.');
  return extractText(result);
}

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method === 'GET' && req.url === '/ping') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('relay OK');
    return;
  }

  if (req.method !== 'POST') {
    res.writeHead(405, { 'Content-Type': 'text/plain' });
    res.end('Method Not Allowed');
    return;
  }

  const chunks = [];
  req.on('data', (data) => chunks.push(data));
  req.on('end', async () => {
    let userPrompt = '';
    try {
      const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      userPrompt = parsed.messages?.[parsed.messages.length - 1]?.content || '';
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid JSON body.' }));
      return;
    }

    try {
      const content = await callThroughMcp(userPrompt);
      console.log('[relay] MCP call succeeded');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content }, finish_reason: 'stop' }] }));
    } catch (error) {
      console.error('[relay] Error:', error.message);
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: error.message }));
    }
  });
});

server.listen(PORT, () => {
  console.log('');
  console.log(`  LeadOS LLM relay ready on http://localhost:${PORT}`);
  console.log(`  Routing via Axon MCP: ${MCP_URL}`);
  console.log(USE_PROXY ? `  Tunneling via local proxy: ${PROXY_HOST}:${PROXY_PORT}` : '  Connecting directly (no proxy)');
  console.log('');
  console.log('  In a second terminal, serve LeadOS:');
  console.log('    py -m http.server 8080');
  console.log('  Then open: http://localhost:8080/LeadOS.html');
  console.log('');
});
