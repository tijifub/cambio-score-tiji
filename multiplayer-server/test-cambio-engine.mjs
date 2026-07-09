import assert from "node:assert/strict";
import {
  buildDeck,
  shuffle,
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
  callCambio,
  finishRound,
  redactForObserver,
} from "./cambio-engine.mjs";

let passed = 0;
function check(name, fn) {
  try {
    fn();
    passed++;
  } catch (e) {
    console.error("FAIL:", name, "-", e.message);
    process.exitCode = 1;
  }
}

// deterministic RNG (LCG) so tests are reproducible
function seededRng(seed) {
  let s = seed;
  return function () {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
}

/* ---------- Deck composition ---------- */

check("1 deck for 2-4 players: 54 cards, 2 jokers, correct king values", () => {
  const deck = buildDeck(3);
  assert.equal(deck.length, 54);
  const jokers = deck.filter((c) => c.rank === "JOKER");
  assert.equal(jokers.length, 2);
  const redKings = deck.filter((c) => c.rank === "K" && (c.suit === "H" || c.suit === "D"));
  const blackKings = deck.filter((c) => c.rank === "K" && (c.suit === "C" || c.suit === "S"));
  assert.equal(redKings.length, 2);
  assert.equal(blackKings.length, 2);
  redKings.forEach((k) => assert.equal(k.value, -1));
  blackKings.forEach((k) => assert.equal(k.value, 15));
});

check("2 decks for 5+ players: 108 cards, 4 jokers", () => {
  const deck = buildDeck(6);
  assert.equal(deck.length, 108);
  assert.equal(deck.filter((c) => c.rank === "JOKER").length, 4);
});

check("ability assignment matches rules", () => {
  const deck = buildDeck(3);
  const byRank = (r) => deck.find((c) => c.rank === r);
  assert.equal(byRank("8").ability, "peekOwn");
  assert.equal(byRank("9").ability, "peekOther");
  assert.equal(byRank("J").ability, "blindSwap");
  assert.equal(byRank("Q").ability, "peekAndSwap");
  assert.equal(byRank("10").ability, null);
  assert.equal(byRank("A").ability, null);
  assert.equal(byRank("A").value, 1);
  assert.equal(deck.find((c) => c.rank === "JOKER").value, 0);
});

check("shuffle is a permutation (same cards, different-ish order)", () => {
  const deck = buildDeck(3);
  const shuffled = shuffle(deck, seededRng(42));
  assert.equal(shuffled.length, deck.length);
  const idsBefore = new Set(deck.map((c) => c.id));
  const idsAfter = new Set(shuffled.map((c) => c.id));
  assert.equal(idsBefore.size, idsAfter.size);
  for (const id of idsBefore) assert.ok(idsAfter.has(id));
});

/* ---------- Game setup ---------- */

function makeGame(numPlayers, opts) {
  const players = [];
  for (let i = 0; i < numPlayers; i++) players.push({ id: "p" + i, name: "Player " + i });
  const game = initGame(players, opts);
  startRound(game, seededRng(7));
  return game;
}

check("startRound deals 4 cards to each player and sets up draw pile", () => {
  const game = makeGame(4);
  for (const id of game.round.order) {
    assert.equal(game.round.hands[id].length, 4);
  }
  const totalDealt = 4 * 4;
  assert.equal(game.round.drawPile.length, 54 - totalDealt);
  assert.equal(game.round.phase, "awaitingDraw");
});

check("each player starts knowing their own bottom two cards only", () => {
  const game = makeGame(3);
  const redacted = redactForObserver(game, "p0");
  const myHand = redacted.round.hands["p0"];
  assert.ok(myHand[0].hidden, "slot 0 should be hidden from self initially");
  assert.ok(myHand[1].hidden, "slot 1 should be hidden from self initially");
  assert.ok(!myHand[2].hidden, "slot 2 should be known to self initially");
  assert.ok(!myHand[3].hidden, "slot 3 should be known to self initially");
  // and player p0 should see nothing of p1's hand
  const otherHand = redacted.round.hands["p1"];
  otherHand.forEach((c) => assert.ok(c.hidden));
});

/* ---------- Draw / swap / discard flow ---------- */

check("draw from deck then swap into hand updates hand and discard, advances turn", () => {
  const game = makeGame(3);
  const active = game.round.order[game.round.turnIndex];
  const drawn = drawFromDeck(game, active, seededRng(1));
  assert.equal(game.round.drawnCard.id, drawn.id);
  swapDrawnIntoHand(game, active, 0);
  assert.equal(game.round.hands[active][0].id, drawn.id);
  // owner should now know that slot
  const redacted = redactForObserver(game, active);
  assert.ok(!redacted.round.hands[active][0].hidden);
  // turn advanced
  assert.notEqual(game.round.turnIndex, game.round.order.indexOf(active));
  assert.equal(game.round.phase, "awaitingDraw");
});

check("wrong player cannot act out of turn", () => {
  const game = makeGame(3);
  const active = game.round.order[game.round.turnIndex];
  const other = game.round.order.find((id) => id !== active);
  assert.throws(() => drawFromDeck(game, other));
});

check("discarding a non-ability card directly just advances the turn", () => {
  const game = makeGame(3);
  const active = game.round.order[game.round.turnIndex];
  // force a known non-ability draw by manipulating draw pile top
  game.round.drawPile.push({ id: "forced", suit: "H", rank: "3", value: 3, ability: null });
  drawFromDeck(game, active);
  discardDrawnDirectly(game, active);
  assert.equal(game.round.phase, "awaitingDraw");
  assert.equal(game.round.discardPile[game.round.discardPile.length - 1].id, "forced");
});

check("discarding an ability card (8) opens peekOwn ability, resolves on peek", () => {
  const game = makeGame(3);
  const active = game.round.order[game.round.turnIndex];
  game.round.drawPile.push({ id: "forced8", suit: "H", rank: "8", value: 8, ability: "peekOwn" });
  drawFromDeck(game, active);
  discardDrawnDirectly(game, active);
  assert.equal(game.round.phase, "abilityPending");
  assert.equal(game.round.pendingAbility.type, "peekOwn");
  resolveAbilityPeekOwn(game, active, 1);
  const redacted = redactForObserver(game, active);
  assert.ok(!redacted.round.hands[active][1].hidden);
  assert.equal(game.round.phase, "awaitingDraw");
});

check("peekOther lets only the acting player see the target's card", () => {
  const game = makeGame(3);
  const active = game.round.order[game.round.turnIndex];
  const target = game.round.order.find((id) => id !== active);
  game.round.drawPile.push({ id: "forced9", suit: "H", rank: "9", value: 9, ability: "peekOther" });
  drawFromDeck(game, active);
  discardDrawnDirectly(game, active);
  resolveAbilityPeekOther(game, active, target, 0);

  const asActive = redactForObserver(game, active);
  assert.ok(!asActive.round.hands[target][0].hidden);

  const thirdPlayer = game.round.order.find((id) => id !== active && id !== target);
  const asThird = redactForObserver(game, thirdPlayer);
  assert.ok(asThird.round.hands[target][0].hidden, "third player must not see the peeked card");

  const asTarget = redactForObserver(game, target);
  assert.ok(asTarget.round.hands[target][0].hidden, "the target itself did not gain knowledge from being peeked at");
});

check("peekOther rejects targeting yourself", () => {
  const game = makeGame(3);
  const active = game.round.order[game.round.turnIndex];
  game.round.drawPile.push({ id: "forced9b", suit: "H", rank: "9", value: 9, ability: "peekOther" });
  drawFromDeck(game, active);
  discardDrawnDirectly(game, active);
  assert.throws(() => resolveAbilityPeekOther(game, active, active, 0));
});

check("blindSwap (Jack) swaps two cards and invalidates knowledge for both slots", () => {
  const game = makeGame(3);
  const active = game.round.order[game.round.turnIndex];
  const [a, b, c] = game.round.order;
  // give active knowledge of a's slot0 and b's slot0 to prove invalidation happens
  game.round.knowledge[active][a][0] = true;
  game.round.knowledge[active][b][0] = true;
  const beforeA = game.round.hands[a][0];
  const beforeB = game.round.hands[b][0];

  game.round.drawPile.push({ id: "forcedJ", suit: "H", rank: "J", value: 10, ability: "blindSwap" });
  drawFromDeck(game, active);
  discardDrawnDirectly(game, active);
  resolveAbilityBlindSwap(game, active, { playerId: a, slotIndex: 0 }, { playerId: b, slotIndex: 0 });

  assert.equal(game.round.hands[a][0].id, beforeB.id);
  assert.equal(game.round.hands[b][0].id, beforeA.id);
  assert.equal(game.round.knowledge[active][a][0], false, "swap should be blind - no new knowledge");
  assert.equal(game.round.knowledge[active][b][0], false);
});

check("peekAndSwap (Queen) requires peek stage then swap stage", () => {
  const game = makeGame(3);
  const active = game.round.order[game.round.turnIndex];
  const target = game.round.order.find((id) => id !== active);
  game.round.drawPile.push({ id: "forcedQ", suit: "H", rank: "Q", value: 10, ability: "peekAndSwap" });
  drawFromDeck(game, active);
  discardDrawnDirectly(game, active);
  assert.equal(game.round.pendingAbility.stage, "peek");
  assert.throws(() => resolveAbilityQueenSwap(game, active, { playerId: active, slotIndex: 0 }, { playerId: target, slotIndex: 0 }), /swap stage pending/);
  resolveAbilityQueenPeek(game, active, target, 2);
  assert.equal(game.round.pendingAbility.stage, "swap");
  resolveAbilityQueenSwap(game, active, { playerId: active, slotIndex: 0 }, { playerId: target, slotIndex: 1 });
  assert.equal(game.round.phase, "awaitingDraw");
});

check("taking from discard must be swapped in, cannot be re-discarded", () => {
  const game = makeGame(3);
  const active = game.round.order[game.round.turnIndex];
  game.round.discardPile.push({ id: "discardTop", suit: "H", rank: "5", value: 5, ability: null });
  takeFromDiscard(game, active);
  assert.throws(() => discardDrawnDirectly(game, active), /discard pile/i);
  swapDrawnIntoHand(game, active, 0);
  assert.equal(game.round.hands[active][0].id, "discardTop");
});

/* ---------- Cambio call + scoring ---------- */

check("Cambio caller with the lowest hand gets a bonus (penalty subtracted)", () => {
  const game = makeGame(3, { scoreLimit: 1000, penaltyPoints: 5 });
  const [p0, p1, p2] = game.round.order;
  // rig hands: p0 lowest
  game.round.hands[p0] = [
    { id: "a", suit: "H", rank: "2", value: 2, ability: null },
    { id: "b", suit: "H", rank: "2", value: 2, ability: null },
    { id: "c", suit: "H", rank: "2", value: 2, ability: null },
    { id: "d", suit: "H", rank: "2", value: 2, ability: null },
  ]; // total 8
  game.round.hands[p1] = [
    { id: "e", suit: "H", rank: "K", value: 15, ability: null },
    { id: "f", suit: "H", rank: "K", value: 15, ability: null },
    { id: "g", suit: "H", rank: "K", value: 15, ability: null },
    { id: "h", suit: "H", rank: "K", value: 15, ability: null },
  ]; // total 60
  game.round.hands[p2] = [
    { id: "i", suit: "H", rank: "9", value: 9, ability: null },
    { id: "j", suit: "H", rank: "9", value: 9, ability: null },
    { id: "k", suit: "H", rank: "9", value: 9, ability: null },
    { id: "l", suit: "H", rank: "9", value: 9, ability: null },
  ]; // total 36

  game.round.turnIndex = game.round.order.indexOf(p0);
  callCambio(game, p0);
  // p1 and p2 each get a final turn: just draw+swap-into-same-slot to pass quickly
  let guard = 0;
  while (game.round.phase !== "roundEnd" && guard < 20) {
    const cur = game.round.order[game.round.turnIndex];
    game.round.drawPile.push({ id: "filler" + guard, suit: "H", rank: "2", value: 2, ability: null });
    drawFromDeck(game, cur);
    // swap into slot 0 to keep totals simple/predictable isn't needed; just discard to avoid mutating rigged hands... but discard requires deck source ok.
    discardDrawnDirectly(game, cur);
    guard++;
  }
  assert.equal(game.round.phase, "roundEnd");

  const results = finishRound(game);
  assert.equal(results[p0].rawTotal, 8);
  assert.equal(results[p0].bonused, true);
  assert.equal(results[p0].roundScore, 3); // 8 - 5
  const p0meta = game.playersMeta.find((p) => p.id === p0);
  assert.equal(p0meta.total, 3);
});

check("Cambio caller who does NOT have the lowest hand gets a penalty added", () => {
  const game = makeGame(3, { scoreLimit: 1000, penaltyPoints: 5 });
  const [p0, p1, p2] = game.round.order;
  game.round.hands[p0] = [
    { id: "a", suit: "H", rank: "K", value: 15, ability: null },
    { id: "b", suit: "H", rank: "K", value: 15, ability: null },
    { id: "c", suit: "H", rank: "K", value: 15, ability: null },
    { id: "d", suit: "H", rank: "K", value: 15, ability: null },
  ]; // 60 - caller, but NOT lowest
  game.round.hands[p1] = [
    { id: "e", suit: "H", rank: "A", value: 1, ability: null },
    { id: "f", suit: "H", rank: "A", value: 1, ability: null },
    { id: "g", suit: "H", rank: "A", value: 1, ability: null },
    { id: "h", suit: "H", rank: "A", value: 1, ability: null },
  ]; // 4 - lowest
  game.round.hands[p2] = [
    { id: "i", suit: "H", rank: "9", value: 9, ability: null },
    { id: "j", suit: "H", rank: "9", value: 9, ability: null },
    { id: "k", suit: "H", rank: "9", value: 9, ability: null },
    { id: "l", suit: "H", rank: "9", value: 9, ability: null },
  ]; // 36

  game.round.turnIndex = game.round.order.indexOf(p0);
  callCambio(game, p0);
  let guard = 0;
  while (game.round.phase !== "roundEnd" && guard < 20) {
    const cur = game.round.order[game.round.turnIndex];
    game.round.drawPile.push({ id: "filler2_" + guard, suit: "H", rank: "2", value: 2, ability: null });
    drawFromDeck(game, cur);
    discardDrawnDirectly(game, cur);
    guard++;
  }
  const results = finishRound(game);
  assert.equal(results[p0].penalized, true);
  assert.equal(results[p0].roundScore, 65); // 60 + 5
});

check("tie for lowest counts as a correct call (bonus, not penalty)", () => {
  const game = makeGame(2, { scoreLimit: 1000, penaltyPoints: 5 });
  const [p0, p1] = game.round.order;
  game.round.hands[p0] = [
    { id: "a", suit: "H", rank: "2", value: 2, ability: null },
    { id: "b", suit: "H", rank: "2", value: 2, ability: null },
    { id: "c", suit: "H", rank: "2", value: 2, ability: null },
    { id: "d", suit: "H", rank: "2", value: 2, ability: null },
  ]; // 8
  game.round.hands[p1] = [
    { id: "e", suit: "H", rank: "2", value: 2, ability: null },
    { id: "f", suit: "H", rank: "2", value: 2, ability: null },
    { id: "g", suit: "H", rank: "2", value: 2, ability: null },
    { id: "h", suit: "H", rank: "2", value: 2, ability: null },
  ]; // 8 tie
  game.round.turnIndex = game.round.order.indexOf(p0);
  callCambio(game, p0);
  let guard = 0;
  while (game.round.phase !== "roundEnd" && guard < 10) {
    const cur = game.round.order[game.round.turnIndex];
    game.round.drawPile.push({ id: "filler3_" + guard, suit: "H", rank: "2", value: 2, ability: null });
    drawFromDeck(game, cur);
    discardDrawnDirectly(game, cur);
    guard++;
  }
  const results = finishRound(game);
  assert.equal(results[p0].bonused, true);
  assert.equal(results[p0].roundScore, 3); // 8 - 5
});

check("game ends and picks lowest-total winner once someone crosses the score limit", () => {
  const game = makeGame(2, { scoreLimit: 20, penaltyPoints: 5 });
  const [p0, p1] = game.round.order;
  game.round.hands[p0] = [
    { id: "a", suit: "H", rank: "K", value: 15, ability: null },
    { id: "b", suit: "H", rank: "K", value: 15, ability: null },
    { id: "c", suit: "H", rank: "A", value: 1, ability: null },
    { id: "d", suit: "H", rank: "A", value: 1, ability: null },
  ]; // 32
  game.round.hands[p1] = [
    { id: "e", suit: "H", rank: "2", value: 2, ability: null },
    { id: "f", suit: "H", rank: "2", value: 2, ability: null },
    { id: "g", suit: "H", rank: "2", value: 2, ability: null },
    { id: "h", suit: "H", rank: "2", value: 2, ability: null },
  ]; // 8
  game.round.turnIndex = game.round.order.indexOf(p1);
  callCambio(game, p1);
  let guard = 0;
  while (game.round.phase !== "roundEnd" && guard < 10) {
    const cur = game.round.order[game.round.turnIndex];
    game.round.drawPile.push({ id: "filler4_" + guard, suit: "H", rank: "2", value: 2, ability: null });
    drawFromDeck(game, cur);
    discardDrawnDirectly(game, cur);
    guard++;
  }
  finishRound(game);
  assert.equal(game.phase, "gameEnd");
  assert.equal(game.winnerId, p1);
});

check("cannot call Cambio twice in the same round", () => {
  const game = makeGame(3);
  const active = game.round.order[game.round.turnIndex];
  callCambio(game, active);
  const next = game.round.order[game.round.turnIndex];
  assert.throws(() => callCambio(game, next));
});

console.log(`\n${passed} checks passed.`);
if (process.exitCode) {
  console.log("SOME CHECKS FAILED");
} else {
  console.log("ALL CHECKS PASSED");
}
