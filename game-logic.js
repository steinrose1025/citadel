/*
 * CITADEL — 共有ゲームロジック
 * ブラウザ (window.GameLogic) と Node.js (module.exports) の両方で利用する。
 * クライアントの予測表示とサーバーの確定処理が必ず一致するよう、
 * 盤面に関する純粋なルールはすべてここに集約する。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else {
    root.GameLogic = api;
  }
})(typeof window !== "undefined" ? window : globalThis, function () {
  "use strict";

  const N = 6; // 6x6
  const CELLS = N * N;

  /* 影響の届く範囲：自マス＋上下左右4マス（斜めは効かない） */
  const INF_DIRS = [[0, 0], [-1, 0], [1, 0], [0, -1], [0, 1]];
  /* 隣接の定義：上下左右4マス（斜めを含まない） */
  const ADJ_DIRS = [[-1, 0], [1, 0], [0, -1], [0, 1]];

  const idx = (r, c) => r * N + c;
  const inB = (r, c) => r >= 0 && r < N && c >= 0 && c < N;

  function makeBoard() {
    const b = [];
    for (let i = 0; i < CELLS; i++) b.push({ owner: null, rank: 0 });
    return b;
  }
  function cloneBoard(b) {
    return b.map((x) => ({ owner: x.owner, rank: x.rank }));
  }
  function other(p) {
    return p === "blue" ? "red" : "blue";
  }

  /* ---- 影響力：自マス＋上下左右4マスへランク分を加算 ---- */
  function computeInfluence(b) {
    const bi = new Array(CELLS).fill(0);
    const ri = new Array(CELLS).fill(0);
    for (let r = 0; r < N; r++)
      for (let c = 0; c < N; c++) {
        const cell = b[idx(r, c)];
        if (!cell.owner) continue;
        const v = cell.rank;
        const arr = cell.owner === "blue" ? bi : ri;
        for (const [dr, dc] of INF_DIRS) {
          const nr = r + dr, nc = c + dc;
          if (inB(nr, nc)) arr[idx(nr, nc)] += v;
        }
      }
    return { bi, ri };
  }

  /* ---- 包囲判定：建物マスで敵影響力が自影響力に並んでいる（あと一押しで陥落） ---- */
  function computeSiege(b) {
    const { bi, ri } = computeInfluence(b);
    const s = new Array(CELLS).fill(false);
    for (let i = 0; i < CELLS; i++) {
      const cell = b[i];
      if (!cell.owner) continue;
      const mine = cell.owner === "blue" ? bi[i] : ri[i];
      const enemy = cell.owner === "blue" ? ri[i] : bi[i];
      if (enemy > 0 && enemy >= mine) s[i] = true;
    }
    return s;
  }

  /* ---- 支配権 ---- */
  function computeTerritory(b) {
    const { bi, ri } = computeInfluence(b);
    const t = new Array(CELLS).fill(null);
    for (let i = 0; i < CELLS; i++) {
      if (bi[i] > ri[i]) t[i] = "blue";
      else if (ri[i] > bi[i]) t[i] = "red";
      else t[i] = null;
    }
    return t;
  }

  /* ---- 解決：支配権決定→破壊→連鎖が止まるまで再計算 ---- */
  function resolve(b) {
    const destroyed = [];
    while (true) {
      const t = computeTerritory(b);
      const kill = [];
      for (let i = 0; i < CELLS; i++) {
        const cell = b[i];
        if (cell.owner && t[i] === other(cell.owner)) kill.push(i);
      }
      if (kill.length === 0) break;
      for (const i of kill) {
        b[i].owner = null;
        b[i].rank = 0;
        destroyed.push(i);
      }
    }
    return destroyed;
  }

  /* ---- 手の列挙 / 適用 ---- */
  function validMoves(b, player) {
    const m = [];
    for (let i = 0; i < CELLS; i++) {
      const c = b[i];
      if (!c.owner) m.push({ type: "build", i });
      else if (c.owner === player && c.rank < 3) m.push({ type: "upgrade", i });
    }
    return m;
  }
  function moveFor(b, player, i) {
    const c = b[i];
    if (!c.owner) return { type: "build", i };
    if (c.owner === player && c.rank < 3) return { type: "upgrade", i };
    return null;
  }
  function applyMove(b, mv, player) {
    const c = b[mv.i];
    if (mv.type === "build") {
      c.owner = player;
      c.rank = 1;
    } else {
      c.rank = Math.min(3, c.rank + 1);
    }
  }
  function countBuildings(b, owner) {
    let n = 0;
    for (const c of b) if (c.owner === owner) n++;
    return n;
  }
  function countTerritory(t) {
    let blue = 0, red = 0;
    for (const x of t) {
      if (x === "blue") blue++;
      else if (x === "red") red++;
    }
    return { blue, red };
  }

  return {
    N, CELLS, INF_DIRS, ADJ_DIRS,
    idx, inB, makeBoard, cloneBoard, other,
    computeInfluence, computeSiege, computeTerritory, resolve,
    validMoves, moveFor, applyMove, countBuildings, countTerritory,
  };
});
