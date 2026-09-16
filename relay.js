'use strict';

// LLM Relay Server for LeadOS
// Routes browser requests through the local corporate proxy to Bosch Model Farm.
//
// Required environment variable:
//   $env:BMF_API_KEY="<your subscription key>"
// Optional environment variables:
//   $env:BMF_SUBSCRIPTION_ID="personal-...-prod"
//   $env:BMF_DEPLOYMENT="gpt-5-nano-2025-08-07"
//   $env:BMF_API_VERSION="2025-04-01-preview"
//   $env:PORT="3001"
//
// Run:
//   node relay.js

const http = require('http');
const net = require('net');
const tls = require('tls');

const PROXY_HOST = process.env.PROXY_HOST || 'localhost';
const PROXY_PORT = Number(process.env.PROXY_PORT || 3128);
const LLM_HOST = process.env.BMF_HOST || 'aoai-farm.bosch-temp.com';
const DEPLOYMENT = process.env.BMF_DEPLOYMENT || 'gpt-5-nano-2025-08-07';
const API_VERSION = process.env.BMF_API_VERSION || '2025-04-01-preview';
const SUBSCRIPTION_ID = process.env.BMF_SUBSCRIPTION_ID || '';
const API_KEY = process.env.BMF_API_KEY || '';
const PORT = Number(process.env.PORT || 3001);

function buildLlmPath() {
  const params = new URLSearchParams({ 'api-version': API_VERSION });
  if (SUBSCRIPTION_ID) params.set('subscription-id', SUBSCRIPTION_ID);
  return `/api/openai/deployments/${encodeURIComponent(DEPLOYMENT)}/chat/completions?${params.toString()}`;
}

function decodeChunkedBody(responseBody) {
  let decoded = '';
  let pos = 0;
  while (pos < responseBody.length) {
    const lineEnd = responseBody.indexOf('\r\n', pos);
    if (lineEnd < 0) break;
    const size = parseInt(responseBody.slice(pos, lineEnd), 16);
    if (!Number.isFinite(size) || size === 0) break;
    const chunkStart = lineEnd + 2;
    decoded += responseBody.slice(chunkStart, chunkStart + size);
    pos = chunkStart + size + 2;
  }
  return decoded;
}

function forwardThroughProxy(body, callback) {
  if (!API_KEY) {
    callback(new Error('BMF_API_KEY environment variable is not set.'));
    return;
  }

  const socket = net.connect(PROXY_PORT, PROXY_HOST, () => {
    socket.write(`CONNECT ${LLM_HOST}:443 HTTP/1.1\r\nHost: ${LLM_HOST}:443\r\n\r\n`);
  });

  socket.once('data', (chunk) => {
    const proxyResp = chunk.toString();
    if (!proxyResp.includes('200')) {
      socket.destroy();
      callback(new Error('Proxy CONNECT failed: ' + proxyResp.split('\r\n')[0]));
      return;
    }

    const tlsSocket = tls.connect({ socket, servername: LLM_HOST }, () => {
      const bodyBuf = Buffer.from(body);
      tlsSocket.write(
        `POST ${buildLlmPath()} HTTP/1.1\r\n` +
        `Host: ${LLM_HOST}\r\n` +
        `genaiplatform-farm-subscription-key: ${API_KEY}\r\n` +
        `Content-Type: application/json\r\n` +
        `Content-Length: ${bodyBuf.length}\r\n` +
        `Connection: close\r\n` +
        `\r\n`
      );
      tlsSocket.write(bodyBuf);
    });

    const chunks = [];
    tlsSocket.on('data', (data) => chunks.push(data));
    tlsSocket.on('error', (error) => callback(error));
    tlsSocket.on('end', () => {
      const raw = Buffer.concat(chunks).toString();
      const separator = raw.indexOf('\r\n\r\n');
      if (separator < 0) {
        callback(new Error('Malformed HTTP response from LLM'));
        return;
      }

      const headerSection = raw.slice(0, separator);
      let responseBody = raw.slice(separator + 4);
      const statusCode = parseInt(headerSection.split(' ')[1], 10) || 200;

      if (headerSection.toLowerCase().includes('transfer-encoding: chunked')) {
        responseBody = decodeChunkedBody(responseBody);
      }

      callback(null, statusCode, responseBody);
    });
  });

  socket.on('error', (error) => {
    callback(new Error(`Cannot connect to proxy ${PROXY_HOST}:${PROXY_PORT} - ${error.message}`));
  });
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
  req.on('end', () => {
    const body = Buffer.concat(chunks).toString();
    forwardThroughProxy(body, (err, status, responseBody) => {
      if (err) {
        console.error('[relay] Error:', err.message);
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
        return;
      }

      console.log('[relay] LLM responded HTTP', status);
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(responseBody);
    });
  });
});

server.listen(PORT, () => {
  console.log('');
  console.log(`  LeadOS LLM relay ready on http://localhost:${PORT}`);
  console.log(`  Routing via proxy ${PROXY_HOST}:${PROXY_PORT}`);
  console.log(`  Target: https://${LLM_HOST}`);
  console.log('');
  console.log('  In a second terminal, serve LeadOS:');
  console.log('    py -m http.server 8080');
  console.log('  Then open: http://localhost:8080/LeadOS.html');
  console.log('');
});
