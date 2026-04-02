// gameState.js — Authoritative game state & tick logic

const MAP_SIZE = 6789;
const MAX_ENTITIES = 25;
const TICK_RATE = 30;
const SESSION_DURATION = 4 * 60 * 1000; // 4 minutes
const BASE_SPEED = 200; // px/sec at min size
const MIN_RADIUS = 20;  // absolute minimum (speed calc, decay threshold)
const SPAWN_RADIUS = 28; // starting size for new/respawned eggs
const MAX_RADIUS = 1000;
const FOOD_COUNT = 1000;
const FOOD_RADIUS = 6;
const EGG_RATIO = 1.25; // ry = radius * EGG_RATIO (egg is taller than wide)
const HITBOX_SHRINK = 0.85; // hitbox is 85% of visual egg size

// Check if center of `small` is inside the shrunken egg hitbox of `big`
function isInsideEggHitbox(big, small) {
  const dx = small.x - big.x;
  const dy = small.y - big.y;
  const rx = big.radius * HITBOX_SHRINK;
  const ry = big.radius * EGG_RATIO * HITBOX_SHRINK;
  return (dx * dx) / (rx * rx) + (dy * dy) / (ry * ry) < 1;
}

// Ellipse-aware distance normalized to radius units (for merge/push-apart)
function eggDist(dx, dy) {
  const sdy = dy / EGG_RATIO;
  return Math.sqrt(dx * dx + sdy * sdy);
}
const VIEWPORT_W = 1920;
const VIEWPORT_H = 1080;

// Split constants
const SPLIT_MIN_MASS = MIN_RADIUS * MIN_RADIUS * 4; // need 2x min size to split
const SPLIT_BOOST = 1800; // initial burst speed px/sec
const SPLIT_BOOST_DECAY = 0.96; // per tick multiplier (higher = slides further)
const SPLIT_MERGE_DELAY = 8000; // ms before pieces can merge
const SPLIT_MAX_PIECES = 16; // max pieces per player

let nextId = 1;

// ── Spatial grid for food (fast collision lookups) ──
const GRID_CELL = 200;
const GRID_COLS = Math.ceil(MAP_SIZE / GRID_CELL);

function foodGridKey(x, y) {
  return (Math.floor(y / GRID_CELL)) * GRID_COLS + Math.floor(x / GRID_CELL);
}

function addFoodToGrid(state, f) {
  const key = foodGridKey(f.x, f.y);
  if (!state.foodGrid[key]) state.foodGrid[key] = [];
  state.foodGrid[key].push(f);
}

function removeFoodFromGrid(state, f) {
  const key = foodGridKey(f.x, f.y);
  const cell = state.foodGrid[key];
  if (cell) {
    const idx = cell.indexOf(f);
    if (idx !== -1) cell.splice(idx, 1);
  }
}

function getFoodInRange(state, cx, cy, range) {
  const result = [];
  const minCol = Math.max(0, Math.floor((cx - range) / GRID_CELL));
  const maxCol = Math.min(GRID_COLS - 1, Math.floor((cx + range) / GRID_CELL));
  const minRow = Math.max(0, Math.floor((cy - range) / GRID_CELL));
  const maxRow = Math.min(GRID_COLS - 1, Math.floor((cy + range) / GRID_CELL));
  for (let row = minRow; row <= maxRow; row++) {
    for (let col = minCol; col <= maxCol; col++) {
      const cell = state.foodGrid[row * GRID_COLS + col];
      if (cell) for (const f of cell) result.push(f);
    }
  }
  return result;
}

export function createGameState(identities) {
  const state = {
    entities: new Map(),   // id -> entity
    food: new Map(),       // id -> { id, x, y, hue }
    foodGrid: {},          // spatial grid for food
    identities,            // fetched bittensor identities
    sessionStart: Date.now(),
    sessionEnd: Date.now() + SESSION_DURATION,
    gameOver: false,
    leaderboard: [],       // final leaderboard
  };

  // Spawn initial food
  for (let i = 0; i < FOOD_COUNT; i++) {
    spawnFood(state);
  }

  return state;
}

// ── Entity helpers ──

function randomPos(margin = 100) {
  return {
    x: margin + Math.random() * (MAP_SIZE - margin * 2),
    y: margin + Math.random() * (MAP_SIZE - margin * 2),
  };
}

function pickIdentity(identities) {
  if (!identities || identities.length === 0) return null;
  return identities[Math.floor(Math.random() * identities.length)];
}

export function createEntity(state, { name, isBot = false, ws = null, ownerId = null, address = null, x, y, radius, mass, hue, identity, score = 0, kills = 0 }) {
  const id = nextId++;
  const pos = (x != null && y != null) ? { x, y } : randomPos();
  const ident = identity || (isBot ? pickIdentity(state.identities) : null);

  const entity = {
    id,
    ownerId: ownerId || id, // for split: all pieces share the original player's ownerId
    name: name || (ident ? ident.name : `Egg#${id}`),
    x: pos.x,
    y: pos.y,
    radius: radius || SPAWN_RADIUS,
    mass: mass || SPAWN_RADIUS * SPAWN_RADIUS,
    dx: 0,
    dy: 0,
    boostVx: 0, // split boost velocity
    boostVy: 0,
    isBot,
    ws,
    address,
    alive: true,
    identity: ident,
    hue: hue != null ? hue : Math.floor(Math.random() * 360),
    score,
    kills,
    splitTime: 0, // when this piece was split off (for merge delay)
  };

  state.entities.set(id, entity);
  return entity;
}

export function removeEntity(state, id) {
  state.entities.delete(id);
}

// ── Split ──

export function splitEntity(state, entityId, dx, dy) {
  const entity = state.entities.get(entityId);
  if (!entity || !entity.alive) return;

  // Can't split if too small
  if (entity.mass < SPLIT_MIN_MASS) return;

  // Count current pieces for this owner
  const pieceCount = [...state.entities.values()]
    .filter(e => e.alive && e.ownerId === entity.ownerId).length;
  if (pieceCount >= SPLIT_MAX_PIECES) return;

  // Split mass 50/50
  const halfMass = entity.mass / 2;
  const halfRadius = Math.sqrt(halfMass);

  entity.mass = halfMass;
  entity.radius = halfRadius;

  // Normalize direction
  const len = Math.sqrt(dx * dx + dy * dy) || 1;
  const ndx = dx / len;
  const ndy = dy / len;

  // Create the ejected piece
  const piece = createEntity(state, {
    name: entity.name,
    isBot: entity.isBot,
    ws: entity.ws,
    ownerId: entity.ownerId,
    address: entity.address,
    x: entity.x + ndx * halfRadius * 2,
    y: entity.y + ndy * halfRadius * 2,
    radius: halfRadius,
    mass: halfMass,
    hue: entity.hue,
    identity: entity.identity,
    score: 0, // score stays on original
    kills: 0,
  });

  piece.dx = entity.dx;
  piece.dy = entity.dy;
  piece.boostVx = ndx * SPLIT_BOOST;
  piece.boostVy = ndy * SPLIT_BOOST;
  const now = Date.now();
  piece.splitTime = now;
  entity.splitTime = now; // both pieces need the same split time

  return piece;
}

// ── Food ──

function spawnFood(state) {
  const id = nextId++;
  const pos = randomPos(20);
  const f = { id, x: pos.x, y: pos.y, hue: Math.floor(Math.random() * 360) };
  state.food.set(id, f);
  addFoodToGrid(state, f);
}

// ── Tick ──

export function tick(state, dt) {
  if (state.gameOver) return;

  const now = Date.now();
  const remaining = state.sessionEnd - now;

  if (remaining <= 0) {
    endSession(state);
    return;
  }

  const dtSec = dt / 1000;

  // Move entities
  for (const e of state.entities.values()) {
    if (!e.alive) continue;

    // Speed decreases as you grow (gentler curve with pow 0.4)
    const speedMult = Math.max(0.4, MIN_RADIUS / Math.pow(e.radius, 0.4));
    const speed = BASE_SPEED * speedMult;

    // Apply split boost
    if (e.boostVx !== 0 || e.boostVy !== 0) {
      e.x += e.boostVx * dtSec;
      e.y += e.boostVy * dtSec;
      e.boostVx *= SPLIT_BOOST_DECAY;
      e.boostVy *= SPLIT_BOOST_DECAY;
      if (Math.abs(e.boostVx) < 5 && Math.abs(e.boostVy) < 5) {
        e.boostVx = 0;
        e.boostVy = 0;
      }
    }

    e.x += e.dx * speed * dtSec;
    e.y += e.dy * speed * dtSec;

    // Clamp to map (use egg height = radius * 1.25 for vertical)
    e.x = Math.max(e.radius, Math.min(MAP_SIZE - e.radius, e.x));
    const eggH = e.radius * 1.25;
    e.y = Math.max(eggH, Math.min(MAP_SIZE - eggH, e.y));

    // Slow mass decay for large entities
    if (e.mass > SPAWN_RADIUS * SPAWN_RADIUS * 2) {
      e.mass *= (1 - 0.002 * dtSec);
      e.radius = Math.sqrt(e.mass);
    }
  }

  // Push apart same-owner pieces that haven't merged yet
  pushApartSameOwner(state, now);

  // Entity vs food collision (spatial grid lookup — no shrink, food is easy to pick up)
  for (const e of state.entities.values()) {
    if (!e.alive) continue;
    const range = e.radius * EGG_RATIO + FOOD_RADIUS;
    const nearby = getFoodInRange(state, e.x, e.y, range);
    for (const f of nearby) {
      const dx = f.x - e.x;
      const dy = f.y - e.y;
      const rx = e.radius * 0.9;
      const ry = e.radius * EGG_RATIO * 0.95;
      if ((dx * dx) / (rx * rx) + (dy * dy) / (ry * ry) < 1) {
        e.mass += FOOD_RADIUS * FOOD_RADIUS;
        e.radius = Math.min(MAX_RADIUS, Math.sqrt(e.mass));
        e.score += 1;
        removeFoodFromGrid(state, f);
        state.food.delete(f.id);
        spawnFood(state);
      }
    }
  }

  // Entity vs entity collision
  const entities = [...state.entities.values()].filter(e => e.alive);
  for (let i = 0; i < entities.length; i++) {
    for (let j = i + 1; j < entities.length; j++) {
      const a = entities[i];
      const b = entities[j];
      if (!a.alive || !b.alive) continue;

      const dx = a.x - b.x;
      const dy = a.y - b.y;

      // Same owner → merge if delay passed
      if (a.ownerId === b.ownerId) {
        const mergeReady =
          (now - a.splitTime > SPLIT_MERGE_DELAY) &&
          (now - b.splitTime > SPLIT_MERGE_DELAY);
        const mergeDist = eggDist(dx, dy);
        if (mergeReady && mergeDist < (a.radius + b.radius) * 0.6) {
          mergeEntities(state, a, b);
        }
        continue;
      }

      // Eat: small egg's center must be inside big egg's shrunken hitbox
      if (a.radius > b.radius * 1.15) {
        if (isInsideEggHitbox(a, b)) eatEntity(state, a, b);
      } else if (b.radius > a.radius * 1.15) {
        if (isInsideEggHitbox(b, a)) eatEntity(state, b, a);
      }
    }
  }

  // Cache top5 + player/bot counts (computed once per tick, reused by all getStateForPlayer calls)
  const ownerScores = new Map();
  let realCount = 0, botCount = 0;
  for (const e of state.entities.values()) {
    if (!e.alive) continue;
    if (e.isBot) botCount++; else realCount++;
    const existing = ownerScores.get(e.ownerId);
    if (existing) { existing.score += e.score; existing.kills += e.kills; }
    else ownerScores.set(e.ownerId, { name: e.name, score: e.score, kills: e.kills, hue: e.hue, img: e.identity?.image && e.identity.image !== 'N/A' && !e.identity.image.includes('/N/A') ? e.identity.image : null });
  }
  state._top5 = [...ownerScores.values()].sort((a, b) => b.score - a.score).slice(0, 5)
    .map((e, i) => ({ rank: i + 1, name: e.name, score: e.score, kills: e.kills, hue: e.hue, img: e.img }));
  state._realCount = realCount;
  state._botCount = botCount;
}

// Push apart or attract same-owner pieces
function pushApartSameOwner(state, now) {
  const entities = [...state.entities.values()].filter(e => e.alive);
  for (let i = 0; i < entities.length; i++) {
    for (let j = i + 1; j < entities.length; j++) {
      const a = entities[i];
      const b = entities[j];
      if (a.ownerId !== b.ownerId) continue;

      const mergeReady =
        (now - a.splitTime > SPLIT_MERGE_DELAY) &&
        (now - b.splitTime > SPLIT_MERGE_DELAY);

      const dx = a.x - b.x;
      const dy = a.y - b.y;
      const rawDist = Math.sqrt(dx * dx + dy * dy) || 1;
      const nx = dx / rawDist;
      const ny = dy / rawDist;

      if (mergeReady) {
        // Attract towards each other for merge
        const attract = 2;
        a.x -= nx * attract;
        a.y -= ny * attract;
        b.x += nx * attract;
        b.y += ny * attract;
      } else {
        // Solid hitbox — eggs can touch but not overlap
        // Use elliptical check: are the two egg shapes overlapping?
        // Approximate by checking if center-to-center distance < sum of radii in that direction
        const angle = Math.atan2(dy, dx);
        const cosA = Math.cos(angle);
        const sinA = Math.sin(angle);
        // Effective radius of each egg in the direction of the other
        const rA = (a.radius * a.radius * EGG_RATIO) / Math.sqrt((a.radius * sinA) ** 2 + (a.radius * EGG_RATIO * cosA) ** 2);
        const rB = (b.radius * b.radius * EGG_RATIO) / Math.sqrt((b.radius * sinA) ** 2 + (b.radius * EGG_RATIO * cosA) ** 2);
        const minDist = rA + rB;
        if (rawDist < minDist) {
          const overlap = minDist - rawDist;
          a.x += nx * overlap * 0.5;
          a.y += ny * overlap * 0.5;
          b.x -= nx * overlap * 0.5;
          b.y -= ny * overlap * 0.5;
        }
      }
    }
  }
}

function mergeEntities(state, a, b) {
  if (!a.alive || !b.alive) return;
  // Bigger absorbs smaller
  const [big, small] = a.mass >= b.mass ? [a, b] : [b, a];
  big.mass += small.mass;
  big.radius = Math.min(MAX_RADIUS, Math.sqrt(big.mass));
  big.score += small.score;
  big.kills += small.kills;
  big.splitTime = 0; // reset so merged entity can split again
  small.alive = false;
  // Don't delete immediately — let broadcastState handle the transition
  setTimeout(() => removeEntity(state, small.id), 100);
}

function eatEntity(state, eater, eaten) {
  eaten.alive = false;

  // Transfer score/kills to the owner's main piece
  const eaterOwnerPieces = [...state.entities.values()]
    .filter(e => e.alive && e.ownerId === eater.ownerId);
  const mainPiece = eaterOwnerPieces.length > 0 ? eaterOwnerPieces[0] : eater;

  eater.mass += eaten.mass * 0.7;
  eater.radius = Math.min(MAX_RADIUS, Math.sqrt(eater.mass));
  mainPiece.score += eaten.score + 10;
  mainPiece.kills += 1;

  // Check if this player still has other alive pieces
  const hasAlive = [...state.entities.values()]
    .some(e => e.ownerId === eaten.ownerId && e.alive);

  if (hasAlive) {
    // Just a split piece eaten — remove it, player continues with remaining pieces
    removeEntity(state, eaten.id);
    return;
  }

  // All pieces dead — notify and respawn after delay
  if (!eaten.isBot) {
    const eatenWs = eaten.ws || [...state.entities.values()]
      .find(e => e.ownerId === eaten.ownerId && e.ws)?.ws;
    if (eatenWs) {
      try {
        eatenWs.send(JSON.stringify({
          type: 'eaten',
          by: { name: eater.name, id: eater.id },
        }));
      } catch (_) {}
    }
  }

  // Respawn after delay — keep entity hidden until respawn
  setTimeout(() => {
    if (eaten.isBot) {
      removeEntity(state, eaten.id);
    } else {
      respawnEntity(state, eaten);
    }
  }, 3000);
}

function respawnEntity(state, entity) {
  const pos = randomPos();
  entity.x = pos.x;
  entity.y = pos.y;
  entity.radius = SPAWN_RADIUS;
  entity.mass = SPAWN_RADIUS * SPAWN_RADIUS;
  entity.dx = 0;
  entity.dy = 0;
  entity.boostVx = 0;
  entity.boostVy = 0;
  entity.alive = true;
  entity.ownerId = entity.id; // reset ownerId
  entity.splitTime = 0;
  entity.score = Math.max(0, Math.floor(entity.score * 0.3));
}

function endSession(state) {
  state.gameOver = true;

  // Aggregate scores per ownerId
  const ownerScores = new Map();
  for (const e of state.entities.values()) {
    const existing = ownerScores.get(e.ownerId);
    if (existing) {
      existing.score += e.score;
      existing.kills += e.kills;
      existing.mass += e.mass;
    } else {
      ownerScores.set(e.ownerId, {
        name: e.name,
        score: e.score,
        kills: e.kills,
        mass: e.mass,
        isBot: e.isBot,
        identity: e.identity,
        address: e.address,
        hue: e.hue,
      });
    }
  }

  state.leaderboard = [...ownerScores.values()]
    .sort((a, b) => b.score - a.score)
    .map((e, i) => ({
      rank: i + 1,
      name: e.name,
      score: e.score,
      kills: e.kills,
      isBot: e.isBot,
      identity: e.identity,
      address: e.address || null,
      hue: e.hue,
    }));
}

// ── State serialization (delta for nearby entities) ──

export function getStateForPlayer(state, playerId) {
  const player = state.entities.get(playerId);
  if (!player) return null;

  // Find all pieces owned by this player for camera center
  const myPieces = [...state.entities.values()]
    .filter(e => e.alive && e.ownerId === player.ownerId);

  // Camera center = center of mass of all pieces
  let cx = player.x, cy = player.y, totalMass = player.mass;
  if (myPieces.length > 0) {
    cx = 0; cy = 0; totalMass = 0;
    for (const p of myPieces) {
      cx += p.x * p.mass;
      cy += p.y * p.mass;
      totalMass += p.mass;
    }
    cx /= totalMass;
    cy /= totalMass;
  }

  const maxR = myPieces.reduce((m, p) => Math.max(m, p.radius), MIN_RADIUS);

  // Viewport bounds (extended for smooth edges)
  const viewW = VIEWPORT_W * (1 + maxR / 80);
  const viewH = VIEWPORT_H * (1 + maxR / 80);
  const left = cx - viewW / 2;
  const right = cx + viewW / 2;
  const top = cy - viewH / 2;
  const bottom = cy + viewH / 2;

  const nearbyEntities = [];
  for (const e of state.entities.values()) {
    if (e.x + e.radius > left && e.x - e.radius < right &&
        e.y + e.radius > top && e.y - e.radius < bottom) {
      const mergeReady = e.splitTime > 0 && (Date.now() - e.splitTime > SPLIT_MERGE_DELAY);
      nearbyEntities.push({
        id: e.id,
        oid: e.ownerId,
        x: Math.round(e.x),
        y: Math.round(e.y),
        r: Math.round(e.radius * 10) / 10,
        name: e.name,
        hue: e.hue,
        alive: e.alive,
        score: e.score,
        img: e.identity?.image && e.identity.image !== 'N/A' && !e.identity.image.includes('/N/A') ? e.identity.image : null,
        mr: mergeReady ? 1 : 0,
      });
    }
  }

  const nearbyFood = [];
  for (const f of state.food.values()) {
    if (f.x > left && f.x < right && f.y > top && f.y < bottom) {
      nearbyFood.push({
        id: f.id,
        x: Math.round(f.x),
        y: Math.round(f.y),
        hue: f.hue,
      });
    }
  }

  // Use cached top5 from tick()
  const top5 = state._top5 || [];

  // Aggregate self score across pieces
  const selfScore = myPieces.reduce((s, p) => s + p.score, 0);
  const selfKills = myPieces.reduce((s, p) => s + p.kills, 0);

  return {
    type: 'state',
    self: {
      id: player.id,
      oid: player.ownerId,
      x: Math.round(cx),
      y: Math.round(cy),
      r: Math.round(maxR),
      score: selfScore,
      kills: selfKills,
      alive: player.alive,
    },
    entities: nearbyEntities,
    food: nearbyFood,
    top5,
    time: Math.max(0, Math.ceil((state.sessionEnd - Date.now()) / 1000)),
    mapSize: MAP_SIZE,
    players: state._realCount || 0,
    bots: state._botCount || 0,
  };
}

export function getEndState(state) {
  return {
    type: 'gameOver',
    leaderboard: state.leaderboard,
  };
}

export { MAP_SIZE, MAX_ENTITIES, TICK_RATE, SESSION_DURATION, getFoodInRange };
