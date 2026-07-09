import assert from "node:assert/strict";
import { createRoom, addPlayer, removePlayer, applyClientMessage } from "./cambio-room-logic.mjs";
import { redactForObserver } from "./cambio-engine.mjs";

let passed = 0;
function check(name, fn) {
  try {
    fn();
    passed++;
  } catch (e) {
    console.error("FAIL:", name, "-", e.message, e.stack);
    process.exitCode = 1;
  }
}

function seededRng(seed) {
  let s = seed;
  return function () {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
}

check("full room lifecycle: create, join, start, play a full round, end game", () => {
  const room = createRoom("ABCD", "host1");
  addPlayer(room, "host1", "Tanya");
  addPlayer(room, "p2", "Max");
  addPlayer(room, "p3", "Alex");

  let res = applyClientMessage(room, "p2", { type: "startGame" }); // not host
  assert.equal(res.ok, false);

  res = applyClientMessage(room, "host1", { type: "startGame", scoreLimit: 1000, penaltyPoints: 5 }, seededRng(3));
  assert.equal(res.ok, true);
  assert.equal(room.game.phase, "playing");
  assert.equal(room.game.round.hands["host1"].length, 4);

  // full round: everyone just draws and discards (using deck top forced non-ability cards where possible)
  let guard = 0;
  while (room.game.phase === "playing" && guard < 60) {
    const active = room.game.round.order[room.game.round.turnIndex];
    const r1 = applyClientMessage(room, active, { type: "draw" }, seededRng(guard + 1));
    assert.equal(r1.ok, true, "draw should succeed: " + r1.error);
    const drawn = room.game.round.drawnCard;
    if (drawn.ability) {
      // discard it to trigger ability, then resolve trivially
      applyClientMessage(room, active, { type: "discardDrawn" });
      const pending = room.game.round.pendingAbility;
      if (pending) {
        if (pending.type === "peekOwn") applyClientMessage(room, active, { type: "peekOwn", slotIndex: 0 });
        else if (pending.type === "peekOther") {
          const target = room.game.round.order.find((id) => id !== active);
          applyClientMessage(room, active, { type: "peekOther", targetPlayerId: target, slotIndex: 0 });
        } else if (pending.type === "blindSwap") {
          applyClientMessage(room, active, {
            type: "blindSwap",
            a: { playerId: active, slotIndex: 0 },
            b: { playerId: active, slotIndex: 1 },
          });
        } else if (pending.type === "peekAndSwap") {
          applyClientMessage(room, active, { type: "queenPeek", targetPlayerId: active, slotIndex: 0 });
          applyClientMessage(room, active, {
            type: "queenSwap",
            a: { playerId: active, slotIndex: 0 },
            b: { playerId: active, slotIndex: 1 },
          });
        }
      }
    } else {
      applyClientMessage(room, active, { type: "swap", slotIndex: 0 });
    }
    guard++;
    if (guard === 5) {
      // call cambio on whoever's turn it is, mid-loop
      const caller = room.game.round.order[room.game.round.turnIndex];
      const r2 = applyClientMessage(room, caller, { type: "callCambio" });
      assert.equal(r2.ok, true, r2.error);
    }
  }
  assert.ok(guard < 60, "round should have ended within guard limit");
  assert.ok(room.game.phase === "roundOver" || room.game.phase === "gameEnd");

  // scores should have been tallied for every player
  room.game.playersMeta.forEach((p) => assert.equal(typeof p.total, "number"));
});

check("addPlayer rejects joining mid-game and enforces max 10", () => {
  const room = createRoom("X", "h");
  for (let i = 0; i < 10; i++) addPlayer(room, "p" + i, "P" + i);
  assert.throws(() => addPlayer(room, "p10", "Overflow"));

  const room2 = createRoom("Y", "h2");
  addPlayer(room2, "h2", "Host");
  addPlayer(room2, "b", "Bob");
  applyClientMessage(room2, "h2", { type: "startGame" }, seededRng(9));
  assert.throws(() => addPlayer(room2, "late", "Latecomer"));
});

check("removePlayer marks disconnected without deleting player/state", () => {
  const room = createRoom("Z", "h3");
  addPlayer(room, "h3", "Host");
  addPlayer(room, "b2", "Bob");
  removePlayer(room, "b2");
  const p = room.players.find((p) => p.id === "b2");
  assert.equal(p.connected, false);
  assert.equal(room.players.length, 2, "player record kept for reconnect");
});

check("actions before game start are rejected", () => {
  const room = createRoom("W", "h4");
  addPlayer(room, "h4", "Host");
  addPlayer(room, "b3", "Bob");
  const res = applyClientMessage(room, "h4", { type: "draw" });
  assert.equal(res.ok, false);
});

check("redaction never leaks another player's hidden cards through the room state", () => {
  const room = createRoom("V", "h5");
  addPlayer(room, "h5", "Host");
  addPlayer(room, "b4", "Bob");
  applyClientMessage(room, "h5", { type: "startGame" }, seededRng(11));
  const asHost = redactForObserver(room.game, "h5");
  const asBob = redactForObserver(room.game, "b4");
  // host should not see bob's slot 0/1 (unpeeked)
  assert.ok(asHost.round.hands["b4"][0].hidden);
  assert.ok(asHost.round.hands["b4"][1].hidden);
  // bob should not see host's slot 0/1 either
  assert.ok(asBob.round.hands["h5"][0].hidden);
  assert.ok(asBob.round.hands["h5"][1].hidden);
});

console.log(`\n${passed} checks passed.`);
console.log(process.exitCode ? "SOME CHECKS FAILED" : "ALL CHECKS PASSED");
