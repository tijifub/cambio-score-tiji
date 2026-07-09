// Cloudflare Worker + Durable Object backend for Cambio multiplayer.
// One Durable Object instance = one game room, addressed by room code.
import { createRoom, addPlayer, removePlayer, applyClientMessage } from "./cambio-room-logic.mjs";
import { redactForObserver } from "./cambio-engine.mjs";

export class GameRoom {
  constructor(state, env) {
    this.state = state;
    this.sockets = new Map(); // playerId -> WebSocket
    this.room = null;
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (request.headers.get("Upgrade") === "websocket") {
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      this.handleSession(server, url);
      return new Response(null, { status: 101, webSocket: client });
    }
    return new Response("expected websocket", { status: 400 });
  }

  handleSession(ws, url) {
    ws.accept();
    let playerId = null;

    ws.addEventListener("message", (evt) => {
      let msg;
      try {
        msg = JSON.parse(evt.data);
      } catch (e) {
        return;
      }

      if (msg.type === "hello") {
        playerId = msg.playerId;
        const code = url.searchParams.get("code") || "ROOM";
        if (!this.room) this.room = createRoom(code, playerId);
        try {
          addPlayer(this.room, playerId, msg.name);
        } catch (e) {
          ws.send(JSON.stringify({ type: "error", error: e.message }));
          return;
        }
        this.sockets.set(playerId, ws);
        this.broadcastState();
        return;
      }

      if (!playerId || !this.room) return;
      const result = applyClientMessage(this.room, playerId, msg);
      if (!result.ok) {
        ws.send(JSON.stringify({ type: "error", error: result.error }));
      } else {
        this.broadcastState();
      }
    });

    const onLeave = () => {
      if (playerId && this.room) {
        removePlayer(this.room, playerId);
        this.sockets.delete(playerId);
        this.broadcastState();
      }
    };
    ws.addEventListener("close", onLeave);
    ws.addEventListener("error", onLeave);
  }

  broadcastState() {
    if (!this.room) return;
    for (const [pid, sock] of this.sockets) {
      const state = this.room.game
        ? { ...redactForObserver(this.room.game, pid), code: this.room.code, hostId: this.room.hostId }
        : { phase: "lobby", code: this.room.code, hostId: this.room.hostId, players: this.room.players };
      try {
        sock.send(JSON.stringify({ type: "state", state }));
      } catch (e) {
        // socket may be dead; it'll be cleaned up on its own close/error event
      }
    }
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const code = (url.searchParams.get("code") || "ROOM").toUpperCase();
    const id = env.GAME_ROOM.idFromName(code);
    const stub = env.GAME_ROOM.get(id);
    return stub.fetch(request);
  },
};
