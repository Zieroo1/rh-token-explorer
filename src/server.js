import 'dotenv/config';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { inspectToken } from './tokenInfo.js';

const PORT = Number(process.env.PORT) || 3000;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const INDEX_HTML = path.join(__dirname, '..', 'public', 'index.html');

const ts = () => new Date().toISOString();
const log = (...a) => console.log(`[${ts()}]`, ...a);

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

// ETH/USD price: env override wins, else fetch from a public API (cached 60s).
let ethUsdCache = { value: null, ts: 0 };
async function getEthUsd() {
  if (process.env.ETH_USD) return Number(process.env.ETH_USD);
  const now = Date.now();
  if (ethUsdCache.value != null && now - ethUsdCache.ts < 60_000) return ethUsdCache.value;
  try {
    const r = await fetch('https://api.coinbase.com/v2/prices/ETH-USD/spot', { signal: AbortSignal.timeout(8000) });
    const j = await r.json();
    const v = Number(j?.data?.amount);
    if (isFinite(v) && v > 0) {
      ethUsdCache = { value: v, ts: now };
      return v;
    }
  } catch {
    /* price feed unavailable -> fall back to last cached / null */
  }
  return ethUsdCache.value;
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);

    // --- API ---
    if (url.pathname === '/api/token') {
      const address = (url.searchParams.get('address') || '').trim();
      if (!address) return sendJson(res, 400, { error: 'Missing ?address=' });
      const wallet = (url.searchParams.get('wallet') || '').trim();
      log(`Inspecting token ${address}${wallet ? ` for wallet ${wallet}` : ''}`);
      try {
        const ethUsd = await getEthUsd();
        const data = await inspectToken(address, ethUsd, wallet || null);
        return sendJson(res, 200, data);
      } catch (e) {
        log(`ERROR: ${e.message}`);
        return sendJson(res, 400, { error: e.message });
      }
    }

    // --- config for the frontend ---
    if (url.pathname === '/api/config') {
      return sendJson(res, 200, {
        chainId: Number(process.env.CHAIN_ID) || 4663,
        explorerUrl: (process.env.EXPLORER_URL || '').replace(/\/+$/, ''),
        rpcUrl: process.env.RPC_URL || '',
      });
    }

    // --- static index ---
    if (url.pathname === '/' || url.pathname === '/index.html') {
      const html = await readFile(INDEX_HTML);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(html);
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  } catch (e) {
    log(`UNHANDLED: ${e.message}`);
    sendJson(res, 500, { error: 'Internal server error' });
  }
});

server.listen(PORT, () => {
  log(`Robinhood L2 token explorer running at http://localhost:${PORT}`);
  log(`RPC: ${process.env.RPC_URL || '(default)'}`);
});
