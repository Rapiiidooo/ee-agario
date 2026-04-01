// index.js — HTTP + WebSocket server + game loop

const VERSION = '1.0.0';

import { createServer } from 'http';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { randomBytes } from 'crypto';
import { WebSocketServer } from 'ws';
import Database from 'better-sqlite3';
import {
  createGameState, createEntity, removeEntity, splitEntity,
  tick, getStateForPlayer, getEndState,
  MAP_SIZE, MAX_ENTITIES, TICK_RATE, SESSION_DURATION,
} from './gameState.js';
import { updateBots } from './bot.js';
import { signatureVerify, cryptoWaitReady } from '@polkadot/util-crypto';
import { u8aWrapBytes } from '@polkadot/util';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.PORT || '9420');
const MAX_REAL_PLAYERS = 30;

// ── SQLite setup ──

const dbPath = process.env.DB_PATH || join(__dirname, '..', 'leaderboard.db');
const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS games (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ended_at TEXT DEFAULT (datetime('now')),
    duration_sec INTEGER
  );
  CREATE TABLE IF NOT EXISTS scores (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    game_id INTEGER REFERENCES games(id),
    name TEXT NOT NULL,
    score INTEGER NOT NULL,
    kills INTEGER DEFAULT 0,
    rank INTEGER,
    is_bot INTEGER DEFAULT 0,
    address TEXT
  );
  CREATE TABLE IF NOT EXISTS players (
    address TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    xp INTEGER DEFAULT 0,
    best_score INTEGER DEFAULT 0,
    games_played INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    last_seen TEXT DEFAULT (datetime('now'))
  );
`);

// Migrations for existing DBs
try { db.exec('ALTER TABLE scores ADD COLUMN address TEXT'); } catch (_) {}
try { db.exec('CREATE UNIQUE INDEX idx_players_name ON players(name)'); } catch (_) {}

const insertGame = db.prepare('INSERT INTO games (duration_sec) VALUES (?)');
const insertScore = db.prepare('INSERT INTO scores (game_id, name, score, kills, rank, is_bot, address) VALUES (?, ?, ?, ?, ?, ?, ?)');
const upsertPlayer = db.prepare(`
  INSERT INTO players (address, name, xp, best_score, games_played, last_seen)
  VALUES (?, ?, ?, ?, 1, datetime('now'))
  ON CONFLICT(address) DO UPDATE SET
    xp = players.xp + excluded.xp,
    best_score = MAX(players.best_score, excluded.best_score),
    games_played = players.games_played + 1,
    last_seen = datetime('now')
`);
const getPlayer = db.prepare('SELECT * FROM players WHERE address = ?');
const getPlayerByName = db.prepare('SELECT * FROM players WHERE name = ?');
const claimGuest = db.prepare(`UPDATE players SET address = ? WHERE address = ?`);
const getTopPlayers = db.prepare('SELECT address, name, xp, best_score, games_played FROM players ORDER BY best_score DESC');

function saveLeaderboard(leaderboard) {
  const game = insertGame.run(SESSION_DURATION / 1000);
  const gameId = game.lastInsertRowid;

  for (const e of leaderboard) {
    if (e.isBot) continue;
    try { insertScore.run(gameId, e.name, e.score, e.kills, e.rank, 0, e.address || null); } catch (_) {}
    const playerKey = e.address || `guest:${e.name}`;
    try { upsertPlayer.run(playerKey, e.name, e.score, e.score); } catch (err) { console.error('upsertPlayer failed:', err.message, playerKey, e.name); }
  }
  return gameId;
}

// ── Wallet signature verification (SR25519 / ED25519) ──

function verifyWalletSignature(address, signature, message) {
  try {
    const messageBytes = u8aWrapBytes(new TextEncoder().encode(message));
    const { isValid } = signatureVerify(messageBytes, signature, address);
    return isValid;
  } catch {
    return false;
  }
}

// ── Fetch Bittensor identities ──

let identities = [];

// Image cache: hash -> { buffer, contentType }
const imageCache = new Map();

async function fetchIdentities() {
  try {
    // Fetch validator identities
    const res = await fetch('https://api.taoswap.org/identities/');
    const data = await res.json();
    const entries = Object.values(data.results || data)
      .filter(e => e.name && e.name !== '-' && e.name !== 'N/A' && e.image && e.image !== '-' && e.image !== '' && !e.image.includes('N/A') && e.image.startsWith('http'))
      .map(e => ({ name: e.name, image: e.image }));

    // Fetch subnet identities
    let subnetEntries = [];
    try {
      const subRes = await fetch('https://api.taoswap.org/subnets/');
      const subData = await subRes.json();
      subnetEntries = Object.values(subData.results || subData)
        .filter(s => s.identity?.image && s.identity.image !== '-' && s.identity.image.startsWith('http'))
        .map(s => ({ name: s.identity.name || s.name || `SN${s.id}`, image: s.identity.image }));
    } catch (_) {}

    // Merge and dedupe by URL
    const all = [...entries, ...subnetEntries];
    const seenUrls = new Set();
    const candidates = all.filter(e => {
      if (seenUrls.has(e.image)) return false;
      seenUrls.add(e.image);
      return true;
    });

    // Fetch images in batches, dedupe by SHA-256, cache for proxying
    const seenHashes = new Map();
    const unique = [];
    let proxyIdx = 0;
    const BATCH = 10;
    const startTime = Date.now();
    console.log(`Fetching ${candidates.length} identity images (batch size ${BATCH})...`);
    for (let i = 0; i < candidates.length; i += BATCH) {
      const batch = candidates.slice(i, i + BATCH);
      await Promise.allSettled(batch.map(async (id) => {
        try {
          const imgRes = await fetch(id.image, { signal: AbortSignal.timeout(10000) });
          if (!imgRes.ok) return;
          const contentType = imgRes.headers.get('content-type') || 'image/png';
          const buf = Buffer.from(await imgRes.arrayBuffer());
          const hash = await crypto.subtle.digest('SHA-256', buf);
          const hex = [...new Uint8Array(hash)].map(b => b.toString(16).padStart(2, '0')).join('');
          if (!seenHashes.has(hex)) {
            seenHashes.set(hex, id);
            const pid = proxyIdx++;
            imageCache.set(pid, { buffer: buf, contentType });
            id.image = `/api/img/${pid}`;
            unique.push(id);
          }
        } catch (_) {}
      }));
      console.log(`  batch ${Math.floor(i / BATCH) + 1}/${Math.ceil(candidates.length / BATCH)} done (${unique.length} unique so far)`);
    }

    identities = unique;
    console.log(`Identity fetch complete in ${((Date.now() - startTime) / 1000).toFixed(1)}s — ${identities.length} unique (${candidates.length} candidates)`);
  } catch (err) {
    console.error('Failed to fetch identities:', err.message);
  }
}

// ── Game state ──

let state = null;
let lastTick = Date.now();

function startNewSession() {
  state = createGameState(identities);
  lastTick = Date.now();

  const botCount = MAX_ENTITIES;
  for (let i = 0; i < botCount; i++) {
    createEntity(state, { isBot: true });
  }

  console.log(`New session started — ends at ${new Date(state.sessionEnd).toISOString()}`);
}

// Map ws -> { playerId, address }
const players = new Map();
const waitingQueue = []; // ws[] waiting to join when slots open

// ── Game loop ──

function gameLoop() {
  const now = Date.now();
  const dt = now - lastTick;
  lastTick = now;

  if (!state) return;

  updateBots(state);
  tick(state, dt);
  manageBots();
  broadcastState();
  broadcastSpectatorState();

  if (state.gameOver && !state._gameOverHandled) {
    state._gameOverHandled = true;
    broadcastGameOver();
    if (state.leaderboard.length > 0) {
      saveLeaderboard(state.leaderboard);
    }

    // Remove all player entities, mark as spectators
    for (const [ws, info] of players) {
      const entity = state?.entities.get(info.playerId);
      const ownerId = entity?.ownerId || info.playerId;
      for (const e of [...state.entities.values()]) {
        if (e.ownerId === ownerId) removeEntity(state, e.id);
      }
      ws._joined = false;
    }
    players.clear();

    // Countdown then new session
    const COUNTDOWN = 15;
    let remaining = COUNTDOWN;
    const countdownInterval = setInterval(() => {
      remaining--;
      broadcastToAll({ type: 'countdown', seconds: remaining });
      if (remaining <= 0) {
        clearInterval(countdownInterval);
        startNewSession();
        broadcastToAll({ type: 'newSession' });
      }
    }, 1000);
  }
}

let botTickCounter = 0;
function manageBots() {
  if (!state || state.gameOver) return;

  // Process waiting queue
  while (waitingQueue.length > 0 && players.size < MAX_REAL_PLAYERS) {
    const ws = waitingQueue.shift();
    if (ws.readyState !== 1 || ws._joined) continue;
    joinPlayer(ws);
  }
  // Clean dead WS from queue
  for (let i = waitingQueue.length - 1; i >= 0; i--) {
    if (waitingQueue[i].readyState !== 1) waitingQueue.splice(i, 1);
  }

  // Only rebalance bots every 10th tick (2x/sec)
  if (++botTickCounter % 10 !== 0) return;

  const realCount = players.size;
  let botCount = 0;
  for (const e of state.entities.values()) {
    if (e.alive && e.isBot) botCount++;
  }
  const targetBots = Math.max(0, MAX_ENTITIES - realCount);
  const deficit = targetBots - botCount;
  for (let i = 0; i < deficit; i++) {
    createEntity(state, { isBot: true });
  }
  if (deficit < 0) {
    let toRemove = -deficit;
    for (const e of state.entities.values()) {
      if (toRemove <= 0) break;
      if (e.isBot && e.alive) { removeEntity(state, e.id); toRemove--; }
    }
  }
}

function removeBotSlot(state) {
  for (const e of state.entities.values()) {
    if (e.isBot && e.alive) {
      removeEntity(state, e.id);
      return;
    }
  }
}

function joinPlayer(ws) {
  const name = ws._name || 'Player';
  const hue = ws._hue != null ? ws._hue : Math.floor(Math.random() * 360);
  ws._joined = true;

  removeBotSlot(state);
  const identity = ws._identity || null;
  const entity = createEntity(state, { name, ws, address: ws._address, hue, identity });
  players.set(ws, { playerId: entity.id, address: ws._address });

  const player = ws._address ? getPlayer.get(ws._address) : null;
  ws.send(JSON.stringify({
    type: 'joined',
    id: entity.id,
    sessionEnd: state.sessionEnd,
    mapSize: MAP_SIZE,
    player: player || null,
  }));

  console.log(`Player joined: ${name} (id=${entity.id}${ws._address ? `, addr=${ws._address.slice(0, 8)}...` : ', guest'})`);
}

function broadcastState() {
  for (const [ws, info] of players) {
    if (ws.readyState !== 1) continue;

    // If tracked piece is dead/gone, switch to a surviving piece
    const tracked = state.entities.get(info.playerId);
    if (!tracked || !tracked.alive) {
      const alive = [...state.entities.values()]
        .find(e => e.alive && e.ownerId === (tracked?.ownerId || info.playerId));
      if (alive) {
        info.playerId = alive.id;
      }
    }

    const data = getStateForPlayer(state, info.playerId);
    if (data) {
      try { ws.send(JSON.stringify(data)); } catch (_) {}
    }
  }
}

function broadcastGameOver() {
  const data = JSON.stringify(getEndState(state));
  for (const ws of wss.clients) {
    if (ws.readyState !== 1) continue;
    try { ws.send(data); } catch (_) {}
  }
}

function broadcastToAll(msg) {
  const data = JSON.stringify(msg);
  for (const ws of wss.clients) {
    if (ws.readyState !== 1) continue;
    try { ws.send(data); } catch (_) {}
  }
}

let spectateTickCounter = 0;
function broadcastSpectatorState() {
  if (!state) return;
  // Only send every 5th tick (4x/sec instead of 20x/sec)
  if (++spectateTickCounter % 2 !== 0) return;

  // Check if there are any spectators first
  let hasSpectators = false;
  for (const ws of wss.clients) {
    if (ws.readyState === 1 && !ws._joined) { hasSpectators = true; break; }
  }
  if (!hasSpectators) return;

  const aliveEntities = [...state.entities.values()].filter(e => e.alive);
  let realCount = 0, botCount = 0;
  const entities = [];
  for (const e of aliveEntities) {
    if (e.isBot) botCount++; else realCount++;
    entities.push({
      id: e.id, oid: e.ownerId, x: Math.round(e.x), y: Math.round(e.y),
      r: Math.round(e.radius), name: e.name, hue: e.hue, alive: true,
      score: e.score, img: e.identity?.image && !e.identity.image.includes('N/A') && e.identity.image.startsWith('http') ? e.identity.image : null,
    });
  }
  const food = [...state.food.values()].map(f => ({
    id: f.id, x: Math.round(f.x), y: Math.round(f.y), hue: f.hue,
  }));
  const data = JSON.stringify({
    type: 'spectate', entities, food,
    time: Math.max(0, Math.ceil((state.sessionEnd - Date.now()) / 1000)),
    mapSize: MAP_SIZE, players: realCount, bots: botCount,
  });
  for (const ws of wss.clients) {
    if (ws.readyState !== 1 || ws._joined) continue;
    try { ws.send(data); } catch (_) {}
  }
}

// ── HTTP server ──

const clientHtml = readFileSync(join(__dirname, '..', 'client', 'index.html'), 'utf-8');
const faviconSvg = readFileSync(join(__dirname, '..', 'client', 'favicon.svg'), 'utf-8');
const ogImageSvg = readFileSync(join(__dirname, '..', 'client', 'og-image.svg'), 'utf-8');

const server = createServer((req, res) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
  };

  if (req.url === '/favicon.svg') {
    res.writeHead(200, { ...headers, 'Content-Type': 'image/svg+xml', 'Cache-Control': 'public, max-age=86400' });
    res.end(faviconSvg);
    return;
  }

  if (req.url?.startsWith('/api/img/')) {
    const id = parseInt(req.url.slice('/api/img/'.length));
    const cached = imageCache.get(id);
    if (cached) {
      res.writeHead(200, { ...headers, 'Content-Type': cached.contentType, 'Cache-Control': 'public, max-age=86400' });
      res.end(cached.buffer);
    } else {
      res.writeHead(404);
      res.end();
    }
    return;
  }

  if (req.url === '/og-image.png' || req.url === '/og-image.svg') {
    res.writeHead(200, { ...headers, 'Content-Type': 'image/svg+xml', 'Cache-Control': 'public, max-age=86400' });
    res.end(ogImageSvg);
    return;
  }

  if (req.url === '/api/identities') {
    res.writeHead(200, { ...headers, 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=300' });
    res.end(JSON.stringify(identities));
    return;
  }

  if (req.url === '/api/online') {
    const online = wss.clients.size;
    const playing = players.size;
    res.writeHead(200, { ...headers, 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ online, playing }));
    return;
  }

  if (req.url === '/api/leaderboard') {
    const top = getTopPlayers.all();
    res.writeHead(200, { ...headers, 'Content-Type': 'application/json' });
    res.end(JSON.stringify(top));
    return;
  }

  if (req.url?.startsWith('/api/player/')) {
    const address = req.url.slice('/api/player/'.length);
    const player = getPlayer.get(address);
    res.writeHead(200, { ...headers, 'Content-Type': 'application/json' });
    res.end(JSON.stringify(player || null));
    return;
  }

  if (req.url === '/leaderboard') {
    const top = getTopPlayers.all();
    const truncAddr = (a) => a && !a.startsWith('guest:') ? a.slice(0, 5) + '...' + a.slice(-4) : '';
    const medal = (i) => i === 0 ? '\ud83e\udd47' : i === 1 ? '\ud83e\udd48' : i === 2 ? '\ud83e\udd49' : `<span class="rank-num">${i+1}</span>`;
    const rows = top.map((p, i) => {
      const wallet = truncAddr(p.address);
      const walletHtml = wallet ? `<span class="wallet">${wallet}</span>` : '<span class="guest">guest</span>';
      return `<tr>
        <td class="rank">${medal(i)}</td>
        <td class="name-cell"><div class="name-main">${p.name.replace(/</g,'&lt;')}</div>${walletHtml}</td>
        <td class="stat xp">${p.xp.toLocaleString()}</td>
        <td class="stat">${p.best_score.toLocaleString()}</td>
        <td class="stat">${p.games_played}</td>
      </tr>`;
    }).join('');
    res.writeHead(200, { ...headers, 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Leaderboard \u2014 Tao Easter Event</title><link rel="icon" type="image/svg+xml" href="/favicon.svg">
<link href="https://fonts.googleapis.com/css2?family=DM+Mono:wght@400;500&family=Lexend:wght@300;400;600;700&display=swap" rel="stylesheet">
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:#0f0e17;color:#fffffe;font-family:'Lexend',sans-serif;min-height:100vh;
  background:radial-gradient(ellipse at 30% 20%,rgba(139,92,246,0.12),transparent 60%),
             radial-gradient(ellipse at 70% 80%,rgba(255,122,26,0.08),transparent 60%),#0f0e17}
.container{max-width:640px;margin:0 auto;padding:32px 20px}
h1{text-align:center;font-size:32px;font-weight:700;margin-bottom:6px;
  background:linear-gradient(135deg,#ff3b1a,#ff7a1a,#ffbf1a);-webkit-background-clip:text;-webkit-text-fill-color:transparent}
.subtitle{text-align:center;color:rgba(255,255,255,0.4);font-size:13px;margin-bottom:28px;font-weight:300}
.back{display:inline-flex;align-items:center;gap:6px;color:#ff7a1a;text-decoration:none;font-size:13px;margin-bottom:24px;opacity:0.8;transition:opacity 0.2s}
.back:hover{opacity:1}
.card{background:rgba(30,30,50,0.7);border:1px solid rgba(255,255,255,0.08);border-radius:16px;overflow:hidden;backdrop-filter:blur(12px)}
table{width:100%;border-collapse:collapse}
thead th{padding:12px 16px;text-align:left;font-size:10px;text-transform:uppercase;letter-spacing:1.5px;color:rgba(255,255,255,0.35);border-bottom:1px solid rgba(255,255,255,0.06)}
tbody tr{transition:background 0.15s}
tbody tr:hover{background:rgba(255,255,255,0.03)}
tbody tr:nth-child(1){background:linear-gradient(90deg,rgba(255,191,26,0.12),transparent)}
tbody tr:nth-child(2){background:linear-gradient(90deg,rgba(192,192,192,0.08),transparent)}
tbody tr:nth-child(3){background:linear-gradient(90deg,rgba(205,127,50,0.08),transparent)}
td{padding:14px 16px;border-bottom:1px solid rgba(255,255,255,0.04)}
td.rank{width:40px;text-align:center;font-size:18px}
.rank-num{font-family:'DM Mono',monospace;font-size:13px;color:#ff7a1a}
.name-cell{line-height:1.3}
.name-main{font-weight:600;font-size:14px}
.wallet{font-family:'DM Mono',monospace;font-size:10px;color:rgba(255,255,255,0.3)}
.guest{font-size:10px;color:rgba(255,255,255,0.2);font-style:italic}
td.stat{font-family:'DM Mono',monospace;font-size:13px;color:rgba(255,255,255,0.6);text-align:right}
td.xp{color:#00dbbc;font-weight:500}
th:nth-child(3),th:nth-child(4),th:nth-child(5){text-align:right}
.footer{text-align:center;margin-top:24px;font-size:11px;color:rgba(255,255,255,0.2)}
</style></head><body>
<div class="container">
  <a class="back" href="/">\u2190 Back to game</a>
  <h1>\ud83c\udfc6 Leaderboard</h1>
  <div class="subtitle">${top.length} player${top.length !== 1 ? 's' : ''} ranked</div>
  <div class="card">
    <table>
      <thead><tr><th></th><th>Player</th><th>XP</th><th>Best</th><th>Games</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </div>
  <div class="footer">Tao Easter Event \u2014 ee.taoswap.org</div>
</div></body></html>`);
    return;
  }

  res.writeHead(200, { ...headers, 'Content-Type': 'text/html; charset=utf-8' });
  res.end(clientHtml);
});

// ── WebSocket server ──

const wss = new WebSocketServer({ server, path: '/ws' });

// Heartbeat — detect dead connections every 15s
setInterval(() => {
  for (const ws of wss.clients) {
    if (ws._alive === false) {
      console.log(`Heartbeat timeout: ${ws._name || 'unknown'}`);
      ws.terminate();
      continue;
    }
    ws._alive = false;
    ws.ping();
  }
}, 15000);

wss.on('connection', (ws) => {
  ws._alive = true;
  ws.on('pong', () => { ws._alive = true; });
  ws._name = null;
  ws._joined = false;
  ws._address = null;
  ws._authenticated = false;

  // Send challenge with timestamp — valid for session duration + 1 min
  const timestamp = Date.now();
  const validUntil = timestamp + (SESSION_DURATION * 10) + 60000;
  const nonce = `Sign this to play Taoswap - EE.\n${timestamp}-${validUntil}\n${randomBytes(16).toString('hex')}`;
  ws._nonce = nonce;
  ws._authTimestamp = timestamp;
  ws._authValidUntil = validUntil;
  ws.send(JSON.stringify({ type: 'challenge', nonce }));

  ws.on('message', async (raw) => {
    try {
      const msg = JSON.parse(raw.toString());

      // Auth: guest (no wallet, no persistence)
      if (msg.type === 'auth_guest' && !ws._authenticated) {
        ws._address = null;
        ws._authenticated = true;
        ws._guest = true;
        ws.send(JSON.stringify({ type: 'auth_ok', address: null, guest: true, player: null }));
        return;
      }

      // Auth: wallet extension (SR25519 signRaw)
      if (msg.type === 'auth_wallet' && !ws._authenticated) {
        const { address, signature } = msg;
        if (!address || !signature) return;

        // Check timestamp validity
        if (Date.now() > ws._authValidUntil) {
          ws.send(JSON.stringify({ type: 'auth_error', message: 'Challenge expired' }));
          return;
        }

        const valid = verifyWalletSignature(address, signature, ws._nonce);
        if (!valid) {
          ws.send(JSON.stringify({ type: 'auth_error', message: 'Invalid signature' }));
          return;
        }

        ws._address = address;
        ws._authenticated = true;

        const player = getPlayer.get(address);
        ws.send(JSON.stringify({
          type: 'auth_ok',
          address,
          player: player || null,
        }));
        return;
      }

      // Claim guest account — link wallet to existing guest scores
      if (msg.type === 'confirm_claim' && ws._authenticated && ws._address) {
        const name = (msg.name || '').slice(0, 20);
        const guestKey = `guest:${name}`;
        const guest = getPlayer.get(guestKey);
        if (guest) {
          try {
            claimGuest.run(ws._address, guestKey);
            console.log(`Wallet ${ws._address.slice(0, 8)}... claimed guest "${name}" (${guest.xp} xp)`);
          } catch (_) {
            // If wallet already has a record, merge xp
            const existing = getPlayer.get(ws._address);
            if (existing) {
              db.prepare('UPDATE players SET xp = xp + ?, best_score = MAX(best_score, ?), games_played = games_played + ? WHERE address = ?')
                .run(guest.xp, guest.best_score, guest.games_played, ws._address);
              db.prepare('DELETE FROM players WHERE address = ?').run(guestKey);
            }
          }
        }
        // Now let the client re-send join
        ws.send(JSON.stringify({ type: 'claim_ok', name }));
        return;
      }

      // Join: requires auth
      if (msg.type === 'join' && !ws._joined) {
        if (!ws._authenticated) {
          ws.send(JSON.stringify({ type: 'auth_error', message: 'Must authenticate first' }));
          return;
        }

        // If game is over / between sessions, queue for next session
        if (!state || state.gameOver) {
          const hue = (msg.hue != null && msg.hue >= 0 && msg.hue < 360) ? msg.hue : Math.floor(Math.random() * 360);
          const name = (msg.name || 'Player').slice(0, 20);
          ws._name = name;
          ws._hue = hue;
          if (msg.identity) ws._identity = msg.identity;
          if (!waitingQueue.includes(ws)) waitingQueue.push(ws);
          ws.send(JSON.stringify({ type: 'waiting', message: 'Waiting for next session...' }));
          return;
        }

        // Check no other connection with same address (wallet only)
        if (ws._address) {
          for (const [otherWs, info] of players) {
            if (info.address === ws._address && otherWs !== ws) {
              otherWs.close();
              break;
            }
          }
        }

        let name = (msg.name || 'Player').slice(0, 20);

        // Wallet players: enforce unique persistent username
        if (ws._address) {
          const existing = getPlayer.get(ws._address);
          if (existing) {
            // Returning player — use their stored name
            name = existing.name;
          } else {
            // New wallet player — check name availability
            const taken = getPlayerByName.get(name);
            if (taken) {
              // If taken by a guest, offer to claim
              if (taken.address.startsWith('guest:')) {
                ws.send(JSON.stringify({ type: 'claim_guest', name, xp: taken.xp, best_score: taken.best_score, games_played: taken.games_played }));
                return;
              }
              ws.send(JSON.stringify({ type: 'join_error', message: `Name "${name}" is already taken` }));
              return;
            }
            // Register the player with initial stats
            upsertPlayer.run(ws._address, name, 0, 0);
          }
        }

        const hue = (msg.hue != null && msg.hue >= 0 && msg.hue < 360) ? msg.hue : Math.floor(Math.random() * 360);
        ws._name = name;
        ws._hue = hue;
        if (msg.identity) ws._identity = msg.identity;

        // Check player limit
        if (players.size >= MAX_REAL_PLAYERS) {
          if (!waitingQueue.includes(ws)) waitingQueue.push(ws);
          ws.send(JSON.stringify({ type: 'queued', position: waitingQueue.indexOf(ws) + 1 }));
          return;
        }

        joinPlayer(ws);
      }

      if (msg.type === 'input' && ws._joined) {
        const info = players.get(ws);
        const entity = state?.entities.get(info?.playerId);
        if (entity && entity.alive) {
          const tx = Number(msg.tx) || 0;
          const ty = Number(msg.ty) || 0;

          // Each piece moves toward the target from its own position
          for (const e of state.entities.values()) {
            if (e.ownerId === entity.ownerId && e.alive) {
              const dx = tx - e.x;
              const dy = ty - e.y;
              const len = Math.sqrt(dx * dx + dy * dy);
              // Slow down when close to target (smooth stop)
              const speed = Math.min(1, len / 100);
              if (len > 5) {
                e.dx = (dx / len) * speed;
                e.dy = (dy / len) * speed;
              } else {
                e.dx = 0;
                e.dy = 0;
              }
            }
          }
        }
      }

      if (msg.type === 'split' && ws._joined) {
        const info = players.get(ws);
        const entity = state?.entities.get(info?.playerId);
        if (entity && entity.alive) {
          const dx = Number(msg.dx) || 0;
          const dy = Number(msg.dy) || 0;
          const pieces = [...state.entities.values()]
            .filter(e => e.alive && e.ownerId === entity.ownerId);
          for (const piece of pieces) {
            splitEntity(state, piece.id, dx, dy);
          }
        }
      }
    } catch (_) {}
  });

  ws.on('close', () => {
    // Remove from queue if waiting
    const qIdx = waitingQueue.indexOf(ws);
    if (qIdx !== -1) waitingQueue.splice(qIdx, 1);

    const info = players.get(ws);
    if (info) {
      const entity = state?.entities.get(info.playerId);
      const ownerId = entity?.ownerId || info.playerId;
      for (const e of [...state.entities.values()]) {
        if (e.ownerId === ownerId) removeEntity(state, e.id);
      }
      players.delete(ws);
      console.log(`Player left: ${ws._name} (id=${info.playerId})`);
    }
  });
});

// ── Start ──

async function main() {
  await cryptoWaitReady();
  await fetchIdentities();
  startNewSession();

  setInterval(gameLoop, 1000 / TICK_RATE);
  setInterval(fetchIdentities, 10 * 60 * 1000);

  server.listen(PORT, () => {
    console.log(`[EE Taoswap v${VERSION}]`);
  });
}

main();
