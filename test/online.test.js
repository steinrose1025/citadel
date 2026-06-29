/*
 * ネット対戦サーバーの結合テスト
 * 実行: TURN_MS を短くしてサーバーを別プロセスで起動し、socket.io-client で2人を接続して検証する。
 *   node --test test/online.test.js
 */
"use strict";

const test = require("node:test");
const assert = require("node:assert");
const { spawn } = require("node:child_process");
const path = require("node:path");
const { io } = require("socket.io-client");

const PORT = 4123;
const URL = `http://localhost:${PORT}`;
let serverProc;

function waitFor(socket, event) {
  return new Promise((resolve) => socket.once(event, resolve));
}
function waitForState(socket, predicate) {
  return new Promise((resolve) => {
    const handler = (s) => {
      if (predicate(s)) {
        socket.off("state", handler);
        resolve(s);
      }
    };
    socket.on("state", handler);
  });
}
function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

test.before(async () => {
  serverProc = spawn("node", [path.join(__dirname, "..", "server.js")], {
    env: { ...process.env, PORT: String(PORT), TURN_MS: "1500" },
    stdio: "ignore",
  });
  // サーバー起動待ち
  await delay(800);
});

test.after(() => {
  if (serverProc) serverProc.kill();
});

test("名前設定 → 部屋作成 → 入室で対戦開始", async () => {
  const a = io(URL); // ホスト（青）
  const b = io(URL); // 参加者（赤）
  await Promise.all([waitFor(a, "connect"), waitFor(b, "connect")]);

  await new Promise((res) => a.emit("setName", "アリス", res));
  await new Promise((res) => b.emit("setName", "ボブ", res));

  const created = await new Promise((res) => a.emit("createRoom", { maxMoves: 36 }, res));
  assert.ok(created.ok, "部屋作成に成功する");
  const roomId = created.roomId;

  // 参加者にロビー一覧が届き、その部屋が見える
  const roomsForB = await waitFor(b, "rooms");
  assert.ok(roomsForB.some((r) => r.id === roomId), "ロビーに作成した部屋が出る");

  // 入室すると両者に state が配信され対戦開始（両者の名前が揃った state を待つ）
  const aState = waitForState(a, (st) => st.names.blue !== "—" && st.names.red !== "—");
  const joined = await new Promise((res) => b.emit("joinRoom", roomId, res));
  assert.ok(joined.ok, "入室に成功する");
  const s = await aState;
  assert.strictEqual(s.current, "blue", "先手は青");
  assert.strictEqual(s.names.blue, "アリス");
  assert.strictEqual(s.names.red, "ボブ");
  assert.ok(s.remainingMs > 0 && s.remainingMs <= 1500, "持ち時間がセットされる");

  a.disconnect();
  b.disconnect();
});

test("手番でない側の手は無視され、正しい手は反映される", async () => {
  const a = io(URL);
  const b = io(URL);
  await Promise.all([waitFor(a, "connect"), waitFor(b, "connect")]);
  await new Promise((res) => a.emit("setName", "A", res));
  await new Promise((res) => b.emit("setName", "B", res));
  const created = await new Promise((res) => a.emit("createRoom", { maxMoves: 36 }, res));
  const startA = waitFor(a, "state");
  await new Promise((res) => b.emit("joinRoom", created.roomId, res));
  await startA;

  // 赤(b)は手番でないので無視される
  b.emit("move", { i: 0 });
  await delay(200);

  // 青(a)が打つと state が更新される
  const updated = waitFor(b, "state");
  a.emit("move", { i: 0 });
  const s = await updated;
  assert.strictEqual(s.board[0].owner, "blue", "青の城が建つ");
  assert.strictEqual(s.current, "red", "手番が赤に移る");
  assert.deepStrictEqual(s.lastMove, { i: 0, player: "blue" });

  a.disconnect();
  b.disconnect();
});

test("持ち時間超過で時間切れ敗北になる", async () => {
  const a = io(URL);
  const b = io(URL);
  await Promise.all([waitFor(a, "connect"), waitFor(b, "connect")]);
  await new Promise((res) => a.emit("setName", "A", res));
  await new Promise((res) => b.emit("setName", "B", res));
  const created = await new Promise((res) => a.emit("createRoom", { maxMoves: 36 }, res));
  const startA = waitFor(a, "state");
  await new Promise((res) => b.emit("joinRoom", created.roomId, res));
  await startA;

  // 誰も打たずに TURN_MS(1500ms) を超過 → 先手(青=a)の時間切れ、赤(b)の勝ち
  const over = await waitFor(a, "gameOver");
  assert.strictEqual(over.reason, "timeout");
  assert.strictEqual(over.winner, "red", "時間切れした青の相手(赤)が勝つ");

  a.disconnect();
  b.disconnect();
});

test("対戦中の部屋はロビーに出て、観戦すると盤面を受信できる", async () => {
  const a = io(URL);
  const b = io(URL);
  await Promise.all([waitFor(a, "connect"), waitFor(b, "connect")]);
  await new Promise((res) => a.emit("setName", "A", res));
  await new Promise((res) => b.emit("setName", "B", res));
  const created = await new Promise((res) => a.emit("createRoom", { maxMoves: 36 }, res));
  const startA = waitForState(a, (s) => s.names.blue !== "—" && s.names.red !== "—");
  await new Promise((res) => b.emit("joinRoom", created.roomId, res));
  await startA;

  // 観戦者 c
  const c = io(URL);
  await waitFor(c, "connect");
  await new Promise((res) => c.emit("setName", "観戦者", res));

  // ロビー一覧に対戦中の部屋が出る
  const rooms = await new Promise((res) => { c.emit("listRooms"); c.once("rooms", res); });
  const target = rooms.find((r) => r.id === created.roomId);
  assert.ok(target && target.started && !target.over, "対戦中の部屋が一覧に出る");

  // 観戦開始 → joined(spectator) と現在のstateを受信
  const joinedP = waitFor(c, "joined");
  const stateP = waitFor(c, "state");
  const sp = await new Promise((res) => c.emit("spectateRoom", created.roomId, res));
  assert.ok(sp.ok, "観戦に成功する");
  const j = await joinedP;
  assert.strictEqual(j.color, null, "観戦者は手番色を持たない");
  assert.strictEqual(j.spectator, true);
  await stateP;

  // 観戦者が move しても無視される（盤面は a の手でのみ進む）
  const upd = waitForState(c, (s) => s.board[0].owner === "blue");
  c.emit("move", { i: 5 });          // 無視される想定
  a.emit("move", { i: 0 });          // 実際に進む
  const s = await upd;
  assert.strictEqual(s.board[0].owner, "blue");
  assert.strictEqual(s.board[5].owner, null, "観戦者の手は反映されない");

  a.disconnect();
  b.disconnect();
  c.disconnect();
});

test("対戦中に相手が切断すると残った側の勝ち", async () => {
  const a = io(URL);
  const b = io(URL);
  await Promise.all([waitFor(a, "connect"), waitFor(b, "connect")]);
  await new Promise((res) => a.emit("setName", "A", res));
  await new Promise((res) => b.emit("setName", "B", res));
  const created = await new Promise((res) => a.emit("createRoom", { maxMoves: 36 }, res));
  const startA = waitFor(a, "state");
  await new Promise((res) => b.emit("joinRoom", created.roomId, res));
  await startA;

  const over = waitFor(a, "gameOver");
  b.disconnect();
  const res = await over;
  assert.strictEqual(res.reason, "disconnect");
  assert.strictEqual(res.winner, "blue", "残った青の勝ち");

  a.disconnect();
});
