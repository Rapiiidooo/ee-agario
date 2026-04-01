// bot.js — Simple bot AI

import { MAP_SIZE, getFoodInRange } from './gameState.js';

const WANDER_CHANGE = 3000; // ms between direction changes
const FLEE_DISTANCE_MULT = 4; // flee if big entity within radius * this
const EDGE_MARGIN = 300; // start steering away from edges at this distance

export function updateBots(state) {
  const now = Date.now();
  const allEntities = [...state.entities.values()].filter(e => e.alive);

  for (const bot of allEntities) {
    if (!bot.isBot || !bot.alive) continue;

    // Initialize bot AI state
    if (!bot._ai) {
      bot._ai = {
        mode: 'wander',
        targetId: null,
        wanderAngle: Math.random() * Math.PI * 2,
        nextWander: now + Math.random() * WANDER_CHANGE,
      };
    }

    const ai = bot._ai;

    // Find nearest threats and prey
    let nearestPrey = null;
    let nearestPreyDist = Infinity;
    let nearestThreat = null;
    let nearestThreatDist = Infinity;

    for (const other of allEntities) {
      if (other.id === bot.id || !other.alive) continue;
      if (other.ownerId === bot.ownerId) continue; // skip own split pieces
      const dx = other.x - bot.x;
      const dy = other.y - bot.y;
      const dist = Math.sqrt(dx * dx + dy * dy);

      // Prey: we're significantly bigger
      if (bot.radius > other.radius * 1.2 && dist < bot.radius * 8) {
        if (dist < nearestPreyDist) {
          nearestPrey = other;
          nearestPreyDist = dist;
        }
      }

      // Threat: they're significantly bigger
      if (other.radius > bot.radius * 1.2 && dist < other.radius * FLEE_DISTANCE_MULT) {
        if (dist < nearestThreatDist) {
          nearestThreat = other;
          nearestThreatDist = dist;
        }
      }
    }

    // Also chase nearby food if nothing better to do
    let nearestFood = null;
    let nearestFoodDist = Infinity;
    const nearbyFood = getFoodInRange(state, bot.x, bot.y, 400);
    for (const food of nearbyFood) {
      const dx = food.x - bot.x;
      const dy = food.y - bot.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist < nearestFoodDist) {
        nearestFood = food;
        nearestFoodDist = dist;
      }
    }

    // Decision: flee > chase prey > chase food > wander
    if (nearestThreat) {
      ai.mode = 'flee';
      const dx = bot.x - nearestThreat.x;
      const dy = bot.y - nearestThreat.y;
      const dist = Math.sqrt(dx * dx + dy * dy) || 1;
      bot.dx = dx / dist;
      bot.dy = dy / dist;
    } else if (nearestPrey && nearestPreyDist < bot.radius * 6) {
      ai.mode = 'chase';
      const dx = nearestPrey.x - bot.x;
      const dy = nearestPrey.y - bot.y;
      const dist = Math.sqrt(dx * dx + dy * dy) || 1;
      bot.dx = dx / dist;
      bot.dy = dy / dist;
    } else if (nearestFood && nearestFoodDist < 400) {
      ai.mode = 'eat';
      const dx = nearestFood.x - bot.x;
      const dy = nearestFood.y - bot.y;
      const dist = Math.sqrt(dx * dx + dy * dy) || 1;
      bot.dx = dx / dist;
      bot.dy = dy / dist;
    } else {
      ai.mode = 'wander';
      if (now > ai.nextWander) {
        ai.wanderAngle += (Math.random() - 0.5) * Math.PI * 0.8;
        ai.nextWander = now + WANDER_CHANGE + Math.random() * 2000;
      }
      bot.dx = Math.cos(ai.wanderAngle) * 0.6;
      bot.dy = Math.sin(ai.wanderAngle) * 0.6;
    }

    // Steer away from edges — applies in ALL modes
    const edgeForceX = edgeRepulsion(bot.x, EDGE_MARGIN, MAP_SIZE);
    const edgeForceY = edgeRepulsion(bot.y, EDGE_MARGIN, MAP_SIZE);

    if (edgeForceX !== 0 || edgeForceY !== 0) {
      // In flee/chase/eat modes, blend edge avoidance with current direction
      // Stronger edge force when closer to wall
      bot.dx += edgeForceX;
      bot.dy += edgeForceY;

      // Update wander angle so bot doesn't immediately turn back into the wall
      if (ai.mode === 'wander') {
        ai.wanderAngle = Math.atan2(bot.dy, bot.dx);
      }
    }

    // Normalize
    const len = Math.sqrt(bot.dx * bot.dx + bot.dy * bot.dy) || 1;
    bot.dx /= len;
    bot.dy /= len;
  }
}

// Returns a steering force away from the edge (0 if not near edge)
function edgeRepulsion(pos, margin, mapSize) {
  if (pos < margin) return (margin - pos) / margin; // 0→1 as pos approaches 0
  if (pos > mapSize - margin) return -(pos - (mapSize - margin)) / margin; // 0→-1 as pos approaches mapSize
  return 0;
}
