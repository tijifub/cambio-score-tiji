// Cambio multiplayer game engine — pure, deterministic (given an RNG), no I/O.
// Card ranks & values match the rules already established in cambio-score.html:
//   2-7:  face value, no ability
//   8:    value 8,  ability = peekOwn (look at one of your own cards)
//   9:    value 9,  ability = peekOther (look at one of another player's cards)
//   10:   value 10, no ability
//   J:    value 10, ability = blindSwap (swap any two cards without looking)
//   Q:    value 10, ability = peekAndSwap (look at one card, then blind-swap any two)
//   K (red, Hearts/Diamonds):  value -1
//   K (black, Clubs/Spades):   value 15
//   A:    value 1, no ability
//   Joker: value 0, no ability
//
// Ability only triggers when the drawn (deck) card is discarded directly (not
// swapped into your hand) — matching "ability if you draw that card from the
// deck on your turn". Cards taken from the discard pile must be swapped into
// your hand and never trigger an ability.

export const SUITS = ["H", "D", "C", "S"];

export function buildDeck(numPlayers) {
  const numDecks = numPlayers >= 5 ? 2 : 1;
  const plainRanks = [
    { rank: "A", value: 1 },
    { rank: "2", value: 2 },
    { rank: "3", value: 3 },
    { rank: "4", value: 4 },
    { rank: "5", value: 5 },
    { rank: "6", value: 6 },
    { rank: "7", value: 7 },
    { rank: "8", value: 8, ability: "peekOwn" },
    { rank: "9", value: 9, ability: "peekOther" },
    { rank: "10", value: 10 },
    { rank: "J", value: 10, ability: "blindSwap" },
    { rank: "Q", value: 10, ability: "peekAndSwap" },
  ];
  const deck = [];
  let counter = 0;
  for (let d = 0; d < numDecks; d++) {
    for (const suit of SUITS) {
      for (const r of plainRanks) {
        deck.push({
          id: `c${counter++}`,
          suit,
          rank: r.rank,
          value: r.value,
          ability: r.ability || null,
        });
      }
      const kingValue = suit === "H" || suit === "D" ? -1 : 15;
      deck.push({
        id: `c${counter++}`,
        suit,
        rank: "K",
        value: kingValue,
        ability: null,
      });
    }
    deck.push({ id: `c${counter++}`, suit: null, rank: "JOKER", value: 0, ability: null });
    deck.push({ id: `c${counter++}`, suit: null, rank: "JOKER", value: 0, ability: null });
  }
  return deck;
}

export function shuffle(deck, rng = Math.random) {
  const arr = deck.slice();
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function emptyKnowledge(playerIds) {
  const k = {};
  for (const obs of playerIds) {
    k[obs] = {};
    for (const target of playerIds) {
      k[obs][target] = [false, false, false, false];
    }
  }
  return k;
}

function invalidateSlot(state, targetPlayerId, slotIndex) {
  for (const obs of Object.keys(state.knowledge)) {
    state.knowledge[obs][targetPlayerId][slotIndex] = false;
  }
}

function grantKnowledge(state, observerId, targetPlayerId, slotIndex) {
  state.knowledge[observerId][targetPlayerId][slotIndex] = true;
}

const HAND_SIZE = 4;

// players: [{id, name, total}] — total carried over across rounds (0 for a fresh game)
export function initGame(players, opts = {}) {
  if (players.length < 2 || players.length > 10) {
    throw new Error("Cambio supports 2-10 players");
  }
  return {
    playersMeta: players.map((p) => ({ id: p.id, name: p.name, total: p.total || 0 })),
    scoreLimit: opts.scoreLimit || 100,
    penaltyPoints: opts.penaltyPoints ?? 5,
    roundNumber: 0,
    startPlayerCursor: 0,
    phase: "lobby", // lobby | playing | gameEnd
    round: null,
    winnerId: null,
  };
}

export function startRound(game, rng = Math.random) {
  const ids = game.playersMeta.map((p) => p.id);
  const numPlayers = ids.length;
  const deck = shuffle(buildDeck(numPlayers), rng);

  const hands = {};
  for (const id of ids) hands[id] = [];
  for (let i = 0; i < HAND_SIZE; i++) {
    for (const id of ids) {
      hands[id].push(deck.pop());
    }
  }

  const knowledge = emptyKnowledge(ids);
  // Each player starts knowing their own bottom two cards (slots 2 and 3).
  for (const id of ids) {
    grantKnowledge({ knowledge }, id, id, 2);
    grantKnowledge({ knowledge }, id, id, 3);
  }

  const startIndex = game.startPlayerCursor % numPlayers;

  game.round = {
    hands,
    knowledge,
    drawPile: deck, // remaining cards after deal
    discardPile: [],
    order: ids,
    turnIndex: startIndex,
    phase: "awaitingDraw", // awaitingDraw | awaitingDrawnCardDecision | abilityPending | finalTurns | roundEnd
    drawnCard: null,
    drawnBy: null,
    drawnSource: null, // 'deck' | 'discard'
    pendingAbility: null, // { type, byPlayerId, peeked?: {playerId, slotIndex, card} }
    cambioCallerId: null,
    finalTurnsRemaining: 0,
    lastRoundResult: null,
  };
  game.phase = "playing";
  game.roundNumber += 1;
  return game;
}

function activePlayerId(game) {
  const r = game.round;
  return r.order[r.turnIndex];
}

function requireTurn(game, playerId) {
  if (activePlayerId(game) !== playerId) {
    throw new Error("Not your turn");
  }
}

function reshuffleIfNeeded(round, rng) {
  if (round.drawPile.length === 0) {
    if (round.discardPile.length <= 1) {
      return false; // nothing to reshuffle; caller should handle
    }
    const top = round.discardPile.pop();
    round.drawPile = shuffle(round.discardPile, rng);
    round.discardPile = [top];
  }
  return true;
}

export function drawFromDeck(game, playerId, rng = Math.random) {
  const r = game.round;
  requireTurn(game, playerId);
  if (r.phase !== "awaitingDraw") throw new Error("Not time to draw");
  if (r.drawPile.length === 0) reshuffleIfNeeded(r, rng);
  if (r.drawPile.length === 0) throw new Error("No cards left to draw");
  r.drawnCard = r.drawPile.pop();
  r.drawnBy = playerId;
  r.drawnSource = "deck";
  r.phase = "awaitingDrawnCardDecision";
  return r.drawnCard;
}

export function takeFromDiscard(game, playerId) {
  const r = game.round;
  requireTurn(game, playerId);
  if (r.phase !== "awaitingDraw") throw new Error("Not time to draw");
  if (r.discardPile.length === 0) throw new Error("Discard pile is empty");
  r.drawnCard = r.discardPile.pop();
  r.drawnBy = playerId;
  r.drawnSource = "discard";
  r.phase = "awaitingDrawnCardDecision";
  return r.drawnCard;
}

function advanceTurn(game) {
  const r = game.round;
  r.drawnCard = null;
  r.drawnBy = null;
  r.drawnSource = null;
  r.pendingAbility = null;

  if (r.cambioCallerId) {
    r.finalTurnsRemaining -= 1;
    if (r.finalTurnsRemaining <= 0) {
      r.phase = "roundEnd";
      return;
    }
  }
  r.turnIndex = (r.turnIndex + 1) % r.order.length;
  r.phase = "awaitingDraw";
}

export function swapDrawnIntoHand(game, playerId, slotIndex) {
  const r = game.round;
  if (r.drawnBy !== playerId || r.phase !== "awaitingDrawnCardDecision") {
    throw new Error("No drawn card to place");
  }
  if (slotIndex < 0 || slotIndex >= HAND_SIZE) throw new Error("Bad slot");
  const oldCard = r.hands[playerId][slotIndex];
  r.hands[playerId][slotIndex] = r.drawnCard;
  r.discardPile.push(oldCard);
  invalidateSlot(r, playerId, slotIndex);
  grantKnowledge(r, playerId, playerId, slotIndex); // the owner saw the card they just placed
  advanceTurn(game);
}

export function discardDrawnDirectly(game, playerId) {
  const r = game.round;
  if (r.drawnBy !== playerId || r.phase !== "awaitingDrawnCardDecision") {
    throw new Error("No drawn card to discard");
  }
  if (r.drawnSource !== "deck") {
    throw new Error("Cards taken from the discard pile must be swapped into your hand");
  }
  const card = r.drawnCard;
  r.discardPile.push(card);
  if (card.ability) {
    r.phase = "abilityPending";
    r.pendingAbility = { type: card.ability, byPlayerId: playerId, stage: card.ability === "peekAndSwap" ? "peek" : null };
    r.drawnCard = null;
    r.drawnBy = null;
    r.drawnSource = null;
  } else {
    advanceTurn(game);
  }
}

export function resolveAbilityPeekOwn(game, playerId, slotIndex) {
  const r = game.round;
  if (!r.pendingAbility || r.pendingAbility.type !== "peekOwn" || r.pendingAbility.byPlayerId !== playerId) {
    throw new Error("No peek-own ability pending");
  }
  grantKnowledge(r, playerId, playerId, slotIndex);
  advanceTurn(game);
}

export function resolveAbilityPeekOther(game, playerId, targetPlayerId, slotIndex) {
  const r = game.round;
  if (!r.pendingAbility || r.pendingAbility.type !== "peekOther" || r.pendingAbility.byPlayerId !== playerId) {
    throw new Error("No peek-other ability pending");
  }
  if (targetPlayerId === playerId) throw new Error("Must target another player");
  grantKnowledge(r, playerId, targetPlayerId, slotIndex);
  advanceTurn(game);
}

export function resolveAbilityBlindSwap(game, playerId, a, b) {
  const r = game.round;
  if (!r.pendingAbility || r.pendingAbility.type !== "blindSwap" || r.pendingAbility.byPlayerId !== playerId) {
    throw new Error("No blind-swap ability pending");
  }
  doBlindSwap(r, a, b);
  advanceTurn(game);
}

export function resolveAbilityQueenPeek(game, playerId, targetPlayerId, slotIndex) {
  const r = game.round;
  if (!r.pendingAbility || r.pendingAbility.type !== "peekAndSwap" || r.pendingAbility.stage !== "peek" || r.pendingAbility.byPlayerId !== playerId) {
    throw new Error("No queen-peek stage pending");
  }
  grantKnowledge(r, playerId, targetPlayerId, slotIndex);
  r.pendingAbility.stage = "swap";
}

export function resolveAbilityQueenSwap(game, playerId, a, b) {
  const r = game.round;
  if (!r.pendingAbility || r.pendingAbility.type !== "peekAndSwap" || r.pendingAbility.stage !== "swap" || r.pendingAbility.byPlayerId !== playerId) {
    throw new Error("No queen-swap stage pending");
  }
  doBlindSwap(r, a, b);
  advanceTurn(game);
}

// Some tables play the Queen's swap as optional. Support skipping it.
export function skipAbility(game, playerId) {
  const r = game.round;
  if (!r.pendingAbility || r.pendingAbility.byPlayerId !== playerId) {
    throw new Error("No ability pending");
  }
  advanceTurn(game);
}

function doBlindSwap(round, a, b) {
  if (a.playerId === b.playerId && a.slotIndex === b.slotIndex) {
    throw new Error("Must choose two different cards");
  }
  const cardA = round.hands[a.playerId][a.slotIndex];
  const cardB = round.hands[b.playerId][b.slotIndex];
  round.hands[a.playerId][a.slotIndex] = cardB;
  round.hands[b.playerId][b.slotIndex] = cardA;
  invalidateSlot(round, a.playerId, a.slotIndex);
  invalidateSlot(round, b.playerId, b.slotIndex);
}

export function callCambio(game, playerId) {
  const r = game.round;
  requireTurn(game, playerId);
  if (r.phase !== "awaitingDraw") throw new Error("Can only call Cambio at the start of your turn");
  if (r.cambioCallerId) throw new Error("Cambio already called");
  r.cambioCallerId = playerId;
  r.finalTurnsRemaining = r.order.length - 1;
  if (r.finalTurnsRemaining === 0) {
    r.phase = "roundEnd";
  } else {
    r.turnIndex = (r.turnIndex + 1) % r.order.length;
    r.phase = "awaitingDraw";
  }
}

// Computes round scores, applies Cambio bonus/penalty, updates cumulative
// totals, and reports whether the game is over.
export function finishRound(game) {
  const r = game.round;
  if (r.phase !== "roundEnd") throw new Error("Round is not over yet");

  const rawTotals = {};
  for (const id of r.order) {
    rawTotals[id] = r.hands[id].reduce((sum, c) => sum + c.value, 0);
  }
  const minRaw = Math.min(...Object.values(rawTotals));

  const results = {};
  for (const id of r.order) {
    let roundScore = rawTotals[id];
    let penalized = false;
    let bonused = false;
    if (r.cambioCallerId === id) {
      if (rawTotals[id] > minRaw) {
        roundScore += game.penaltyPoints;
        penalized = true;
      } else {
        roundScore -= game.penaltyPoints;
        bonused = true;
      }
    }
    results[id] = { rawTotal: rawTotals[id], roundScore, penalized, bonused, hand: r.hands[id] };
  }

  for (const meta of game.playersMeta) {
    meta.total += results[meta.id].roundScore;
  }

  r.lastRoundResult = results;
  r.phase = "finished";

  const over = game.playersMeta.some((p) => p.total >= game.scoreLimit);
  if (over) {
    const winner = game.playersMeta.reduce((a, b) => (a.total <= b.total ? a : b));
    game.winnerId = winner.id;
    game.phase = "gameEnd";
  } else {
    game.startPlayerCursor += 1;
    game.phase = "roundOver"; // caller should call startRound() again when ready
  }

  return results;
}

// Redacts full game state down to what a specific observer is allowed to see.
export function redactForObserver(game, observerId) {
  const base = {
    phase: game.phase,
    roundNumber: game.roundNumber,
    scoreLimit: game.scoreLimit,
    penaltyPoints: game.penaltyPoints,
    winnerId: game.winnerId,
    players: game.playersMeta.map((p) => ({ id: p.id, name: p.name, total: p.total })),
  };
  const r = game.round;
  if (!r) return base;

  const showAll = r.phase === "roundEnd" || r.phase === "finished";

  base.round = {
    phase: r.phase,
    turnPlayerId: r.order[r.turnIndex],
    order: r.order,
    discardTop: r.discardPile[r.discardPile.length - 1] || null,
    drawPileCount: r.drawPile.length,
    discardPileCount: r.discardPile.length,
    cambioCallerId: r.cambioCallerId,
    pendingAbility: r.pendingAbility,
    drawnBy: r.drawnBy,
    drawnSource: r.drawnSource,
    drawnCard: r.drawnBy === observerId || showAll ? r.drawnCard : r.drawnCard ? { hidden: true } : null,
    hands: {},
  };
  for (const id of r.order) {
    base.round.hands[id] = r.hands[id].map((card, idx) =>
      showAll || r.knowledge[observerId][id][idx] ? card : { hidden: true }
    );
  }
  if (showAll && r.lastRoundResult) {
    base.round.lastRoundResult = r.lastRoundResult;
  }
  return base;
}
