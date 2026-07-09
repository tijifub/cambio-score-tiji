// Pure message-dispatch layer between the wire protocol (WebSocket JSON
// messages) and the Cambio game engine. Kept separate from any Durable
// Object / WebSocket plumbing so it can be unit tested with plain objects.

import {
  initGame,
  startRound,
  drawFromDeck,
  takeFromDiscard,
  swapDrawnIntoHand,
  discardDrawnDirectly,
  resolveAbilityPeekOwn,
  resolveAbilityPeekOther,
  resolveAbilityBlindSwap,
  resolveAbilityQueenPeek,
  resolveAbilityQueenSwap,
  skipAbility,
  callCambio,
  finishRound,
} from "./cambio-engine.mjs";

// Creates a fresh room object. hostId is the player who can start the game
// and configure scoreLimit/penaltyPoints.
export function createRoom(code, hostId) {
  return {
    code,
    hostId,
    players: [], // [{id, name, total, connected}]
    game: null, // set once the host starts the game
  };
}

export function addPlayer(room, playerId, name) {
  if (room.game && room.game.phase !== "lobby") {
    throw new Error("Game already in progress");
  }
  const existing = room.players.find((p) => p.id === playerId);
  if (existing) {
    existing.name = name || existing.name;
    existing.connected = true;
    return;
  }
  if (room.players.length >= 10) throw new Error("Room is full (max 10 players)");
  room.players.push({ id: playerId, name: name || "Player", total: 0, connected: true });
}

export function removePlayer(room, playerId) {
  const p = room.players.find((pl) => pl.id === playerId);
  if (p) p.connected = false;
}

// Applies one client message to the room. Returns { ok: true } or
// { ok: false, error }. Mutates room/room.game in place on success.
export function applyClientMessage(room, playerId, message, rng = Math.random) {
  try {
    switch (message.type) {
      case "startGame": {
        if (playerId !== room.hostId) throw new Error("Only the host can start the game");
        if (room.players.length < 2) throw new Error("Need at least 2 players");
        room.game = initGame(
          room.players.map((p) => ({ id: p.id, name: p.name, total: 0 })),
          { scoreLimit: message.scoreLimit, penaltyPoints: message.penaltyPoints }
        );
        startRound(room.game, rng);
        return { ok: true };
      }
      case "nextRound": {
        if (!room.game || room.game.phase !== "roundOver") throw new Error("Not ready for next round");
        if (playerId !== room.hostId) throw new Error("Only the host can start the next round");
        startRound(room.game, rng);
        return { ok: true };
      }
      case "draw":
        requireGame(room);
        drawFromDeck(room.game, playerId, rng);
        return { ok: true };
      case "takeDiscard":
        requireGame(room);
        takeFromDiscard(room.game, playerId);
        return { ok: true };
      case "swap":
        requireGame(room);
        swapDrawnIntoHand(room.game, playerId, message.slotIndex);
        maybeAutoFinish(room);
        return { ok: true };
      case "discardDrawn": {
        requireGame(room);
        discardDrawnDirectly(room.game, playerId);
        maybeAutoFinish(room);
        return { ok: true };
      }
      case "peekOwn":
        requireGame(room);
        resolveAbilityPeekOwn(room.game, playerId, message.slotIndex);
        maybeAutoFinish(room);
        return { ok: true };
      case "peekOther":
        requireGame(room);
        resolveAbilityPeekOther(room.game, playerId, message.targetPlayerId, message.slotIndex);
        maybeAutoFinish(room);
        return { ok: true };
      case "blindSwap":
        requireGame(room);
        resolveAbilityBlindSwap(room.game, playerId, message.a, message.b);
        maybeAutoFinish(room);
        return { ok: true };
      case "queenPeek":
        requireGame(room);
        resolveAbilityQueenPeek(room.game, playerId, message.targetPlayerId, message.slotIndex);
        return { ok: true };
      case "queenSwap":
        requireGame(room);
        resolveAbilityQueenSwap(room.game, playerId, message.a, message.b);
        maybeAutoFinish(room);
        return { ok: true };
      case "skipAbility":
        requireGame(room);
        skipAbility(room.game, playerId);
        maybeAutoFinish(room);
        return { ok: true };
      case "callCambio":
        requireGame(room);
        callCambio(room.game, playerId);
        maybeAutoFinish(room);
        return { ok: true };
      default:
        throw new Error("Unknown message type: " + message.type);
    }
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function requireGame(room) {
  if (!room.game || (room.game.phase !== "playing" && room.game.phase !== "gameEnd")) {
    throw new Error("Game is not in progress");
  }
}

// If the round just ended (last final turn taken), score it automatically.
function maybeAutoFinish(room) {
  if (room.game && room.game.round && room.game.round.phase === "roundEnd") {
    finishRound(room.game);
  }
}
