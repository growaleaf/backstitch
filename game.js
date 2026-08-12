import {
  HOOPS,
  buildBackGeometry,
  backScore,
  flipBack,
  solveHoop,
  isValidOrder,
  shareText,
  gradeFlavor,
} from "./stitch.mjs";

const STORAGE_KEY = "backstitch_v1";

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { completed: {} };
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return { completed: {} };
    return { completed: parsed.completed || {} };
  } catch (e) {
    return { completed: {} };
  }
}

function saveState(state) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch (e) {
    // storage unavailable — play continues, nothing persists
  }
}

const persisted = loadState();

const GRADE_CLASS = {
  Clean: "grade-Clean",
  Honest: "grade-Honest",
  "Bird's Nest": "grade-Birds-Nest",
};

const screens = {
  title: document.getElementById("screen-title"),
  howto: document.getElementById("screen-howto"),
  play: document.getElementById("screen-play"),
  reveal: document.getElementById("screen-reveal"),
  final: document.getElementById("screen-final"),
};

function showScreen(name) {
  for (const key of Object.keys(screens)) {
    screens[key].classList.toggle("active", key === name);
  }
  state.screen = name;
}

const state = {
  screen: "title",
  hoopIndex: 0,
  order: [], // array of {edgeIndex, reversed}
  usedEdges: new Set(),
  cursor: null, // {x,y} needle position in hoop space
  lastBack: null,
  lastScore: null,
};

function currentHoop() {
  return HOOPS[state.hoopIndex];
}

function resetPlayState() {
  state.order = [];
  state.usedEdges = new Set();
  state.cursor = null;
}

// ---- geometry helpers: hoop space -> canvas space ----
function canvasTransform(hoop, canvas) {
  const pad = 24;
  const w = canvas.width - pad * 2;
  const h = canvas.height - pad * 2;
  const bw = Math.max(1, hoop.bounds.maxX - hoop.bounds.minX);
  const bh = Math.max(1, hoop.bounds.maxY - hoop.bounds.minY);
  const scale = Math.min(w / bw, h / bh);
  const offX = pad + (w - bw * scale) / 2 - hoop.bounds.minX * scale;
  const offY = pad + (h - bh * scale) / 2 - hoop.bounds.minY * scale;
  return {
    toCanvas: (x, y) => [x * scale + offX, y * scale + offY],
    scale,
  };
}

// ---- front pattern rendering ----
const frontCanvas = document.getElementById("canvas-front");
const frontCtx = frontCanvas.getContext("2d");

function drawFront() {
  const hoop = currentHoop();
  const ctx = frontCtx;
  const { toCanvas } = canvasTransform(hoop, frontCanvas);
  ctx.clearRect(0, 0, frontCanvas.width, frontCanvas.height);

  // hoop ring
  ctx.strokeStyle = "#c9b898";
  ctx.lineWidth = 10;
  ctx.beginPath();
  ctx.roundRect(6, 6, frontCanvas.width - 12, frontCanvas.height - 12, 24);
  ctx.stroke();

  const orderIndexByEdge = new Map();
  state.order.forEach((step, i) => orderIndexByEdge.set(step.edgeIndex, i + 1));

  hoop.edges.forEach((e, i) => {
    const [ax, ay] = toCanvas(e.ax, e.ay);
    const [bx, by] = toCanvas(e.bx, e.by);
    const taken = state.usedEdges.has(i);
    ctx.strokeStyle = taken ? "#4f7942" : "#3a2e22";
    ctx.lineWidth = taken ? 4 : 3;
    ctx.beginPath();
    ctx.moveTo(ax, ay);
    ctx.lineTo(bx, by);
    ctx.stroke();

    ctx.fillStyle = "#3a2e22";
    ctx.beginPath();
    ctx.arc(ax, ay, 3, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(bx, by, 3, 0, Math.PI * 2);
    ctx.fill();

    if (orderIndexByEdge.has(i)) {
      const mx = (ax + bx) / 2;
      const my = (ay + by) / 2;
      ctx.fillStyle = "#fbf5e8";
      ctx.beginPath();
      ctx.arc(mx, my, 10, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = "#3a2e22";
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.fillStyle = "#3a2e22";
      ctx.font = "bold 12px Georgia";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(String(orderIndexByEdge.get(i)), mx, my + 1);
    }
  });
}

function edgeAt(hoop, canvas, px, py) {
  const { toCanvas } = canvasTransform(hoop, canvas);
  let best = -1;
  let bestD = Infinity;
  hoop.edges.forEach((e, i) => {
    const [ax, ay] = toCanvas(e.ax, e.ay);
    const [bx, by] = toCanvas(e.bx, e.by);
    const mx = (ax + bx) / 2;
    const my = (ay + by) / 2;
    // distance from tap point to the segment itself (covers full stitch length, not just midpoint)
    const d = pointToSegmentDist(px, py, ax, ay, bx, by);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  });
  return bestD <= 26 ? best : -1;
}

function pointToSegmentDist(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  let t = lenSq > 0 ? ((px - ax) * dx + (py - ay) * dy) / lenSq : 0;
  t = Math.max(0, Math.min(1, t));
  const cx = ax + t * dx;
  const cy = ay + t * dy;
  return Math.hypot(px - cx, py - cy);
}

function pickEdge(edgeIndex) {
  const hoop = currentHoop();
  if (edgeIndex < 0 || state.usedEdges.has(edgeIndex)) return;
  const e = hoop.edges[edgeIndex];
  // direction: whichever endpoint is nearer the current needle position
  let reversed = false;
  if (state.cursor) {
    const dA = Math.hypot(state.cursor.x - e.ax, state.cursor.y - e.ay);
    const dB = Math.hypot(state.cursor.x - e.bx, state.cursor.y - e.by);
    reversed = dB < dA;
  }
  state.order.push({ edgeIndex, reversed });
  state.usedEdges.add(edgeIndex);
  state.cursor = reversed ? { x: e.ax, y: e.ay } : { x: e.bx, y: e.by };
  drawFront();
  updateFlipButton();
}

function undoLast() {
  if (state.order.length === 0) return;
  const last = state.order.pop();
  state.usedEdges.delete(last.edgeIndex);
  if (state.order.length === 0) {
    state.cursor = null;
  } else {
    const prev = state.order[state.order.length - 1];
    const e = currentHoop().edges[prev.edgeIndex];
    state.cursor = prev.reversed ? { x: e.ax, y: e.ay } : { x: e.bx, y: e.by };
  }
  drawFront();
  updateFlipButton();
}

function updateFlipButton() {
  const hoop = currentHoop();
  document.getElementById("btn-flip").disabled = !isValidOrder(hoop, state.order);
}

frontCanvas.addEventListener("click", (ev) => {
  const rect = frontCanvas.getBoundingClientRect();
  const scaleX = frontCanvas.width / rect.width;
  const scaleY = frontCanvas.height / rect.height;
  const px = (ev.clientX - rect.left) * scaleX;
  const py = (ev.clientY - rect.top) * scaleY;
  const hoop = currentHoop();
  const idx = edgeAt(hoop, frontCanvas, px, py);
  pickEdge(idx);
});

// ---- reveal / back rendering ----
const backCanvas = document.getElementById("canvas-back");
const backCtx = backCanvas.getContext("2d");

function drawBack(hoop, back, crossPoints) {
  const ctx = backCtx;
  const { toCanvas } = canvasTransform(hoop, backCanvas);
  ctx.clearRect(0, 0, backCanvas.width, backCanvas.height);

  ctx.strokeStyle = "#c9b898";
  ctx.lineWidth = 10;
  ctx.beginPath();
  ctx.roundRect(6, 6, backCanvas.width - 12, backCanvas.height - 12, 24);
  ctx.stroke();

  // stitch backs — solid, muted
  ctx.strokeStyle = "#8a7a5f";
  ctx.lineWidth = 3;
  for (const s of back.stitchSegs) {
    const [ax, ay] = toCanvas(s.x1, s.y1);
    const [bx, by] = toCanvas(s.x2, s.y2);
    ctx.beginPath();
    ctx.moveTo(ax, ay);
    ctx.lineTo(bx, by);
    ctx.stroke();
  }

  // floats — dashed, thin
  ctx.strokeStyle = "#2f5f7f";
  ctx.lineWidth = 1.5;
  ctx.setLineDash([5, 4]);
  for (const f of back.floats) {
    const [ax, ay] = toCanvas(f.x1, f.y1);
    const [bx, by] = toCanvas(f.x2, f.y2);
    ctx.beginPath();
    ctx.moveTo(ax, ay);
    ctx.lineTo(bx, by);
    ctx.stroke();
  }
  ctx.setLineDash([]);

  // crossings — red rings
  ctx.fillStyle = "#a8402c";
  for (const pt of crossPoints) {
    const [cx, cy] = toCanvas(pt.x, pt.y);
    ctx.beginPath();
    ctx.arc(cx, cy, 5, 0, Math.PI * 2);
    ctx.fill();
  }
}

function segCross(p1, p2, p3, p4) {
  // local copy for approximate visual intersection point (not scoring — scoring lives in stitch.mjs)
  const d1x = p2.x - p1.x, d1y = p2.y - p1.y;
  const d2x = p4.x - p3.x, d2y = p4.y - p3.y;
  const denom = d1x * d2y - d1y * d2x;
  if (Math.abs(denom) < 1e-9) return null;
  const t = ((p3.x - p1.x) * d2y - (p3.y - p1.y) * d2x) / denom;
  const u = ((p3.x - p1.x) * d1y - (p3.y - p1.y) * d1x) / denom;
  if (t < 0 || t > 1 || u < 0 || u > 1) return null;
  return { x: p1.x + t * d1x, y: p1.y + t * d1y };
}

function findCrossPointsForDisplay(back) {
  const pts = [];
  for (let i = 0; i < back.floats.length; i++) {
    for (let j = i + 1; j < back.floats.length; j++) {
      const f1 = back.floats[i], f2 = back.floats[j];
      const pt = segCross({ x: f1.x1, y: f1.y1 }, { x: f1.x2, y: f1.y2 }, { x: f2.x1, y: f2.y1 }, { x: f2.x2, y: f2.y2 });
      if (pt) pts.push(pt);
    }
    for (const s of back.stitchSegs) {
      const f = back.floats[i];
      const pt = segCross({ x: f.x1, y: f.y1 }, { x: f.x2, y: f.y2 }, { x: s.x1, y: s.y1 }, { x: s.x2, y: s.y2 });
      if (pt) pts.push(pt);
    }
  }
  return pts;
}

function doFlip() {
  const hoop = currentHoop();
  if (!isValidOrder(hoop, state.order)) return;
  const back = buildBackGeometry(hoop, state.order);
  const score = backScore(hoop, back);
  state.lastBack = back;
  state.lastScore = score;

  const masterScore = solveHoop(hoop).score;

  document.getElementById("reveal-label").textContent = `Hoop ${state.hoopIndex + 1} · the back`;
  const badge = document.getElementById("grade-badge");
  badge.textContent = score.grade;
  badge.className = "grade-badge " + (GRADE_CLASS[score.grade] || "");
  document.getElementById("grade-flavor").textContent = gradeFlavor(score.grade);
  document.getElementById("stat-float").textContent = score.floatLen.toFixed(0) + " units";
  document.getElementById("stat-cross").textContent = String(score.crossings);
  document.getElementById("stat-knots").textContent = String(score.knots);
  document.getElementById("stat-master").textContent = `${masterScore.grade} (${masterScore.floatLen.toFixed(0)} units, ${masterScore.knots} knots)`;

  const crossPts = findCrossPointsForDisplay(back);
  drawBack(hoop, back, crossPts);

  const persistedState = loadState();
  const prevBest = persistedState.completed[state.hoopIndex];
  if (!prevBest || score.score < prevBest.score) {
    persistedState.completed[state.hoopIndex] = { grade: score.grade, score: score.score };
    saveState(persistedState);
  }

  showScreen("reveal");
}

function goToHoop(index) {
  state.hoopIndex = index;
  resetPlayState();
  document.getElementById("hoop-label").textContent = `Hoop ${index + 1} of ${HOOPS.length}`;
  drawFront();
  updateFlipButton();
  showScreen("play");
}

function nextHoop() {
  if (state.hoopIndex + 1 >= HOOPS.length) {
    renderFinal();
    showScreen("final");
  } else {
    goToHoop(state.hoopIndex + 1);
  }
}

function renderFinal() {
  const list = document.getElementById("final-list");
  list.innerHTML = "";
  const persistedState = loadState();
  HOOPS.forEach((h, i) => {
    const li = document.createElement("li");
    const entry = persistedState.completed[i];
    li.innerHTML = `<span>Hoop ${i + 1}</span><span>${entry ? entry.grade : "not sewn"}</span>`;
    list.appendChild(li);
  });
}

function copyShare(text) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).catch(() => {});
  }
}

// ---- wiring ----
document.getElementById("btn-play").addEventListener("click", () => goToHoop(0));
document.getElementById("btn-howto").addEventListener("click", () => showScreen("howto"));
document.getElementById("btn-howto-back").addEventListener("click", () => showScreen("title"));
document.getElementById("btn-howto-play").addEventListener("click", () => goToHoop(0));
document.getElementById("btn-play-menu").addEventListener("click", () => showScreen("title"));
document.getElementById("btn-undo").addEventListener("click", undoLast);
document.getElementById("btn-reset").addEventListener("click", () => {
  resetPlayState();
  drawFront();
  updateFlipButton();
});
document.getElementById("btn-flip").addEventListener("click", doFlip);
document.getElementById("btn-resew").addEventListener("click", () => goToHoop(state.hoopIndex));
document.getElementById("btn-next").addEventListener("click", nextHoop);
document.getElementById("btn-share").addEventListener("click", () => {
  if (state.lastScore) copyShare(shareText(state.hoopIndex + 1, state.lastScore.grade));
});
document.getElementById("btn-final-share").addEventListener("click", () => {
  const persistedState = loadState();
  const cleanCount = Object.values(persistedState.completed).filter((c) => c.grade === "Clean").length;
  copyShare(`\u{1FAA1} BACKSTITCH · ${cleanCount}/${HOOPS.length} hoops came back Clean · http://backstitch.defimagic.io`);
});
document.getElementById("btn-final-restart").addEventListener("click", () => {
  saveState({ completed: {} });
  goToHoop(0);
});

showScreen("title");

// ---- dev hook: ?dev=1 exposes window.__g for scripted, human-free testing ----
if (new URLSearchParams(location.search).get("dev") === "1") {
  window.__g = {
    state,
    hoops: HOOPS,
    goTitle: () => showScreen("title"),
    goHowTo: () => showScreen("howto"),
    startPlay: () => goToHoop(0),
    goToHoop,
    tapEdge: (i) => pickEdge(i),
    undo: undoLast,
    reset: () => {
      resetPlayState();
      drawFront();
      updateFlipButton();
    },
    autoSolve: () => {
      const hoop = currentHoop();
      const solved = solveHoop(hoop);
      resetPlayState();
      for (const step of solved.order) {
        state.order.push(step);
        state.usedEdges.add(step.edgeIndex);
      }
      const last = solved.order[solved.order.length - 1];
      const e = hoop.edges[last.edgeIndex];
      state.cursor = last.reversed ? { x: e.ax, y: e.ay } : { x: e.bx, y: e.by };
      drawFront();
      updateFlipButton();
    },
    flip: doFlip,
    next: nextHoop,
    loadState,
    saveState,
    lastResult: () => ({ back: state.lastBack, score: state.lastScore }),
  };
}
