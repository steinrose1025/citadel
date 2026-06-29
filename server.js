/*
 * CITADEL — ネット対戦サーバー
 * Express で静的ファイル（index.html / game-logic.js）を配信し、
 * Socket.IO でロビー・部屋・手番進行・60秒の持ち時間を管理する。
 * 盤面のルールは game-logic.js をサーバー側でも読み込んで共有する。
 */
"use strict";

const path = require("path");
const http = require("http");
const express = require("express");
const { Server } = require("socket.io");

const G = require("./game-logic.js");

const PORT = process.env.PORT || 3000;
// 手番の持ち時間（既定60秒）。テスト等で TURN_MS 環境変数により上書き可能。
const TURN_MS = parseInt(process.env.TURN_MS || "60000", 10);

const app = express();
app.use(express.static(path.join(__dirname)));

const server = http.createServer(app);
const io = new Server(server);

/* ================= 部屋管理 ================= */
/** roomId -> room */
const rooms = new Map();
let roomSeq = 1;

function makeRoomId() {
  // 4桁の入りやすいコード（重複は避ける）
  let code;
  do {
    code = String(1000 + Math.floor(Math.random() * 9000));
  } while (rooms.has(code));
  return code;
}

function roomPublic(room) {
  let count = 0;
  if (room.players.blue) count++;
  if (room.players.red) count++;
  return {
    id: room.id,
    name: room.name,
    hostName: room.hostName,
    count,
    maxMoves: room.maxMoves,
    started: room.started,
    over: room.over,
  };
}

function openRoomList() {
  const list = [];
  for (const room of rooms.values()) {
    const count = (room.players.blue ? 1 : 0) + (room.players.red ? 1 : 0);
    if (!room.started && count < 2) list.push(roomPublic(room));
  }
  return list;
}

function broadcastRooms() {
  io.to("lobby").emit("rooms", openRoomList());
}

function clearTimer(room) {
  if (room.timer) {
    clearTimeout(room.timer);
    room.timer = null;
  }
}

function names(room) {
  return {
    blue: room.players.blue ? room.players.blue.name : "—",
    red: room.players.red ? room.players.red.name : "—",
  };
}

function emitState(room, extra) {
  const payload = Object.assign(
    {
      board: room.board,
      current: room.current,
      moveCount: room.moveCount,
      maxMoves: room.maxMoves,
      over: room.over,
      names: names(room),
      remainingMs: room.deadline ? Math.max(0, room.deadline - Date.now()) : null,
    },
    extra || {}
  );
  io.to(room.id).emit("state", payload);
}

function setTurnTimer(room) {
  clearTimer(room);
  if (room.over) return;
  room.deadline = Date.now() + TURN_MS;
  room.timer = setTimeout(() => onTimeout(room), TURN_MS);
}

function onTimeout(room) {
  if (room.over) return;
  const loser = room.current;
  const winner = G.other(loser);
  endGame(room, winner, "timeout");
}

function endGame(room, winner, reason) {
  room.over = true;
  clearTimer(room);
  room.deadline = null;
  const t = G.computeTerritory(room.board);
  const territory = G.countTerritory(t);
  io.to(room.id).emit("gameOver", { winner, reason, territory });
  broadcastRooms();
}

/** 1手を適用して状態を進める（サーバー権威） */
function applyServerMove(room, color, i) {
  const mv = G.moveFor(room.board, color, i);
  if (!mv) return false;

  G.applyMove(room.board, mv, color);
  const destroyed = G.resolve(room.board);
  room.moveCount++;

  room.current = G.other(color);

  // 相手に有効手が無ければパス（盤面が詰みかけの稀ケース）
  if (
    G.validMoves(room.board, room.current).length === 0 &&
    G.validMoves(room.board, G.other(room.current)).length > 0
  ) {
    room.current = G.other(room.current);
  }

  // 終了判定
  const reached = room.maxMoves > 0 && room.moveCount >= room.maxMoves;
  const noMoves =
    G.validMoves(room.board, "blue").length === 0 &&
    G.validMoves(room.board, "red").length === 0;

  if (reached || noMoves) {
    const t = G.computeTerritory(room.board);
    const { blue, red } = G.countTerritory(t);
    const winner = blue > red ? "blue" : red > blue ? "red" : null;
    emitState(room, { lastMove: { i, player: color }, destroyed });
    endGame(room, winner, "territory");
  } else {
    setTurnTimer(room);
    emitState(room, { lastMove: { i, player: color }, destroyed });
  }
  return true;
}

function startGame(room) {
  room.board = G.makeBoard();
  room.current = "blue";
  room.moveCount = 0;
  room.over = false;
  room.started = true;
  room.rematch = { blue: false, red: false };
  setTurnTimer(room);
  emitState(room);
  broadcastRooms();
}

function leaveRoom(socket) {
  const roomId = socket.data.roomId;
  if (!roomId) return;
  const room = rooms.get(roomId);
  socket.data.roomId = null;
  socket.data.color = null;
  socket.leave(roomId);
  if (!room) return;

  const color = room.players.blue && room.players.blue.id === socket.id ? "blue"
    : room.players.red && room.players.red.id === socket.id ? "red" : null;
  if (color) room.players[color] = null;

  const count = (room.players.blue ? 1 : 0) + (room.players.red ? 1 : 0);

  if (room.started && !room.over && count === 1) {
    // 対戦中の離脱 → 残った側の勝ち
    const winner = room.players.blue ? "blue" : "red";
    endGame(room, winner, "disconnect");
    io.to(room.id).emit("opponentLeft");
  }

  if (count === 0) {
    clearTimer(room);
    rooms.delete(room.id);
  }
  broadcastRooms();
}

/* ================= Socket.IO ================= */
io.on("connection", (socket) => {
  socket.data.name = "";
  socket.data.roomId = null;
  socket.data.color = null;

  socket.on("setName", (name, cb) => {
    socket.data.name = String(name || "").slice(0, 16).trim() || "プレイヤー";
    socket.join("lobby");
    if (typeof cb === "function") cb({ ok: true, name: socket.data.name });
    socket.emit("rooms", openRoomList());
  });

  socket.on("listRooms", () => {
    socket.emit("rooms", openRoomList());
  });

  socket.on("createRoom", (opts, cb) => {
    if (!socket.data.name) {
      if (typeof cb === "function") cb({ ok: false, error: "名前が未設定です" });
      return;
    }
    leaveRoom(socket);
    const id = makeRoomId();
    let maxMoves = parseInt((opts && opts.maxMoves) || 36, 10);
    if (![24, 36, 48].includes(maxMoves)) maxMoves = 36;
    const room = {
      id,
      seq: roomSeq++,
      name: String((opts && opts.name) || "").slice(0, 24).trim() || `${socket.data.name} の部屋`,
      hostName: socket.data.name,
      players: { blue: { id: socket.id, name: socket.data.name }, red: null },
      board: G.makeBoard(),
      current: "blue",
      moveCount: 0,
      maxMoves,
      over: false,
      started: false,
      deadline: null,
      timer: null,
      rematch: { blue: false, red: false },
    };
    rooms.set(id, room);
    socket.leave("lobby");
    socket.join(id);
    socket.data.roomId = id;
    socket.data.color = "blue";
    if (typeof cb === "function") cb({ ok: true, roomId: id });
    socket.emit("joined", { roomId: id, color: "blue", room: roomPublic(room) });
    emitState(room);
    broadcastRooms();
  });

  socket.on("joinRoom", (roomId, cb) => {
    if (!socket.data.name) {
      if (typeof cb === "function") cb({ ok: false, error: "名前が未設定です" });
      return;
    }
    const room = rooms.get(String(roomId));
    if (!room) {
      if (typeof cb === "function") cb({ ok: false, error: "部屋が見つかりません" });
      return;
    }
    const count = (room.players.blue ? 1 : 0) + (room.players.red ? 1 : 0);
    if (room.started || count >= 2) {
      if (typeof cb === "function") cb({ ok: false, error: "満室、または対戦中です" });
      return;
    }
    leaveRoom(socket);
    const color = room.players.blue ? "red" : "blue";
    room.players[color] = { id: socket.id, name: socket.data.name };
    socket.leave("lobby");
    socket.join(room.id);
    socket.data.roomId = room.id;
    socket.data.color = color;
    if (typeof cb === "function") cb({ ok: true, roomId: room.id });
    socket.emit("joined", { roomId: room.id, color, room: roomPublic(room) });

    if (room.players.blue && room.players.red) {
      startGame(room);
    } else {
      emitState(room);
    }
    broadcastRooms();
  });

  socket.on("move", (data) => {
    const room = rooms.get(socket.data.roomId);
    if (!room || room.over || !room.started) return;
    const color = socket.data.color;
    if (color !== room.current) return; // 自分の手番でない
    const i = data && typeof data.i === "number" ? data.i : -1;
    if (i < 0 || i >= G.CELLS) return;
    const ok = applyServerMove(room, color, i);
    if (!ok) socket.emit("errorMsg", "その手は打てません");
  });

  socket.on("rematch", () => {
    const room = rooms.get(socket.data.roomId);
    if (!room || !room.over) return;
    const color = socket.data.color;
    if (!color) return;
    room.rematch[color] = true;
    io.to(room.id).emit("rematchOffer", { from: color });
    if (room.rematch.blue && room.rematch.red &&
        room.players.blue && room.players.red) {
      startGame(room);
    }
  });

  socket.on("leaveRoom", () => {
    leaveRoom(socket);
    socket.join("lobby");
    socket.emit("rooms", openRoomList());
  });

  socket.on("disconnect", () => {
    leaveRoom(socket);
  });
});

server.listen(PORT, () => {
  console.log(`CITADEL server running on http://localhost:${PORT}`);
});
