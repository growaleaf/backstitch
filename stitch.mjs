// BACKSTITCH — pure core. Every rule, generator, and scorer lives here.
// No DOM, no WebAudio, no Date.now()/Math.random() in any logic path.

export const KNOT_THREAD_COST = 8;
export const GRID = 40;
export const MOTIF_COLS = 3;
export const MOTIF_ROWS = 7;
export const MOTIF_Y0 = 20;
export const MOTIF_X0 = 20;
export const MOTIF_SPACING = 150;
export const HOOP_SEED_BASE = 7000;
export const HOOP_COUNT = 14;
export const DEFAULT_MAX_FLOAT = 46;

export function mulberry32(seed) {
  let t = seed >>> 0;
  return function () {
    t += 0x6d2b79f5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

export function dist(ax, ay, bx, by) {
  return Math.hypot(bx - ax, by - ay);
}

function orient(ax, ay, bx, by, cx, cy) {
  return (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
}

// Proper-crossing test only. Segments that merely touch at a shared
// endpoint (the normal case between consecutive stitches) are not crossings.
export function segIntersect(a, b, c, d) {
  const eps = 1e-6;
  const same = (p, q) => Math.abs(p.x - q.x) < eps && Math.abs(p.y - q.y) < eps;
  if (same(a, c) || same(a, d) || same(b, c) || same(b, d)) return false;
  const d1 = orient(c.x, c.y, d.x, d.y, a.x, a.y);
  const d2 = orient(c.x, c.y, d.x, d.y, b.x, b.y);
  const d3 = orient(a.x, a.y, b.x, b.y, c.x, c.y);
  const d4 = orient(a.x, a.y, b.x, b.y, d.x, d.y);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

function shuffleInPlace(arr, rng) {
  for (let k = arr.length - 1; k > 0; k--) {
    const j = Math.floor(rng() * (k + 1));
    const tmp = arr[k];
    arr[k] = arr[j];
    arr[j] = tmp;
  }
}

// A random-walk motif on a small grid. Each stitch is one grid edge.
// Deterministic: same rng stream in, same edges out.
function walkMotif(rng, xOffset, cols, rows, edgesWanted) {
  const key = (x, y) => `${x},${y}`;
  let gx = Math.floor(rng() * cols);
  let gy = 1 + Math.floor(rng() * Math.max(1, rows - 2));
  const visited = new Set([key(gx, gy)]);
  const toXY = (cx, cy) => ({ x: xOffset + cx * GRID, y: MOTIF_Y0 + cy * GRID });
  let cur = toXY(gx, gy);
  const edges = [];
  for (let e = 0; e < edgesWanted; e++) {
    const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
    shuffleInPlace(dirs, rng);
    let moved = false;
    for (const [dx, dy] of dirs) {
      const ngx = gx + dx;
      const ngy = gy + dy;
      if (ngx < 0 || ngx >= cols || ngy < 0 || ngy >= rows) continue;
      const k = key(ngx, ngy);
      if (visited.has(k)) continue;
      const nxt = toXY(ngx, ngy);
      edges.push({ ax: cur.x, ay: cur.y, bx: nxt.x, by: nxt.y });
      visited.add(k);
      gx = ngx;
      gy = ngy;
      cur = nxt;
      moved = true;
      break;
    }
    if (!moved) break;
  }
  return edges;
}

// Builds a hoop's fixed front pattern from a seed. Pure and deterministic:
// the same (seed, index) always yields the same edges and budgets.
export function generateHoop(seed, index) {
  const rng = mulberry32(seed);
  const numMotifs = 1 + Math.min(2, Math.floor(index / 5));
  const edgesPerMotif = 4 + Math.min(4, Math.floor(index / 3));
  let edges = [];
  for (let m = 0; m < numMotifs; m++) {
    const xOffset = MOTIF_X0 + m * MOTIF_SPACING;
    const motifEdges = walkMotif(rng, xOffset, MOTIF_COLS, MOTIF_ROWS, edgesPerMotif);
    edges = edges.concat(motifEdges);
  }
  if (edges.length === 0) {
    // Guaranteed fallback: a single stitch, so no hoop is ever empty.
    edges = [{ ax: MOTIF_X0, ay: MOTIF_Y0, bx: MOTIF_X0 + GRID, by: MOTIF_Y0 }];
  }
  // Shuffle the stitch list so array order no longer matches the walk's
  // own connectivity — otherwise naiveOrder would already be optimal and
  // there would be no real ordering puzzle for the player (or the solver).
  shuffleInPlace(edges, rng);
  edges = edges.map((e, i) => ({ id: i, ...e }));

  const xs = edges.flatMap((e) => [e.ax, e.bx]);
  const ys = edges.flatMap((e) => [e.ay, e.by]);
  const bounds = {
    minX: Math.min(...xs),
    maxX: Math.max(...xs),
    minY: Math.min(...ys),
    maxY: Math.max(...ys),
  };

  const hoop = {
    id: `H${index + 1}`,
    index,
    seed,
    edges,
    bounds,
    maxFloat: DEFAULT_MAX_FLOAT,
    knotThreadCost: KNOT_THREAD_COST,
    cleanFloatBudget: 0,
    threadBudget: 0,
  };

  const solved = solveHoop(hoop);
  hoop.cleanFloatBudget = Math.ceil(solved.back.floatLen * 1.3) + GRID;
  hoop.threadBudget = Math.ceil(solved.back.totalThread * 1.3);
  return hoop;
}

export function frontLength(hoop) {
  return hoop.edges.reduce((s, e) => s + dist(e.ax, e.ay, e.bx, e.by), 0);
}

export function naiveOrder(hoop) {
  return hoop.edges.map((_, i) => ({ edgeIndex: i, reversed: false }));
}

export function isValidOrder(hoop, order) {
  if (!Array.isArray(order) || order.length !== hoop.edges.length) return false;
  const seen = new Set();
  for (const step of order) {
    if (step.edgeIndex < 0 || step.edgeIndex >= hoop.edges.length) return false;
    if (seen.has(step.edgeIndex)) return false;
    seen.add(step.edgeIndex);
  }
  return true;
}

// The hidden consequence: front pattern + chosen order -> back geometry.
// Every stitch produces a back segment at the same two holes. Every gap
// between consecutive stitches produces either a float (short travel) or,
// past maxFloat, a knot (thread is cut and restarted).
export function buildBackGeometry(hoop, order) {
  const maxFloat = hoop.maxFloat;
  let cur = null;
  const floats = [];
  const stitchSegs = [];
  let knots = 0;
  let floatLen = 0;

  for (const step of order) {
    const e = hoop.edges[step.edgeIndex];
    const start = step.reversed ? { x: e.bx, y: e.by } : { x: e.ax, y: e.ay };
    const end = step.reversed ? { x: e.ax, y: e.ay } : { x: e.bx, y: e.by };
    if (cur) {
      const d = dist(cur.x, cur.y, start.x, start.y);
      if (d > 1e-9) {
        if (d <= maxFloat) {
          floats.push({ x1: cur.x, y1: cur.y, x2: start.x, y2: start.y, len: d });
          floatLen += d;
        } else {
          knots += 1;
        }
      }
    }
    stitchSegs.push({
      x1: start.x,
      y1: start.y,
      x2: end.x,
      y2: end.y,
      len: dist(start.x, start.y, end.x, end.y),
      edgeIndex: step.edgeIndex,
    });
    cur = end;
  }

  const front = frontLength(hoop);
  const totalThread = front + floatLen + knots * hoop.knotThreadCost;
  return { floats, stitchSegs, knots, floatLen, totalThread, frontLen: front };
}

// The hidden side judged: float length, crossings (tangles), knot count.
export function backScore(hoop, back) {
  let crossings = 0;
  for (let i = 0; i < back.floats.length; i++) {
    for (let j = i + 1; j < back.floats.length; j++) {
      const f1 = back.floats[i];
      const f2 = back.floats[j];
      if (segIntersect({ x: f1.x1, y: f1.y1 }, { x: f1.x2, y: f1.y2 }, { x: f2.x1, y: f2.y1 }, { x: f2.x2, y: f2.y2 })) {
        crossings++;
      }
    }
    for (const s of back.stitchSegs) {
      const f = back.floats[i];
      if (segIntersect({ x: f.x1, y: f.y1 }, { x: f.x2, y: f.y2 }, { x: s.x1, y: s.y1 }, { x: s.x2, y: s.y2 })) {
        crossings++;
      }
    }
  }

  const score = back.floatLen * 1 + crossings * 50 + back.knots * 20;
  let grade;
  if (crossings > 0) grade = "Bird's Nest";
  else if (back.knots === 0 && back.floatLen <= hoop.cleanFloatBudget) grade = "Clean";
  else grade = "Honest";

  return { crossings, score, grade, floatLen: back.floatLen, knots: back.knots };
}

export function scoreOrder(hoop, order) {
  return backScore(hoop, buildBackGeometry(hoop, order));
}

// Nearest-neighbor baseline: from the current needle position, always
// walk to whichever remaining edge (in either direction) starts closest.
export function greedySolve(hoop) {
  const n = hoop.edges.length;
  const used = new Array(n).fill(false);
  const order = [{ edgeIndex: 0, reversed: false }];
  used[0] = true;
  let cur = { x: hoop.edges[0].bx, y: hoop.edges[0].by };
  for (let k = 1; k < n; k++) {
    let best = -1;
    let bestRev = false;
    let bestD = Infinity;
    for (let i = 0; i < n; i++) {
      if (used[i]) continue;
      const e = hoop.edges[i];
      const dA = dist(cur.x, cur.y, e.ax, e.ay);
      const dB = dist(cur.x, cur.y, e.bx, e.by);
      if (dA < bestD) {
        bestD = dA;
        best = i;
        bestRev = false;
      }
      if (dB < bestD) {
        bestD = dB;
        best = i;
        bestRev = true;
      }
    }
    used[best] = true;
    order.push({ edgeIndex: best, reversed: bestRev });
    const e = hoop.edges[best];
    cur = bestRev ? { x: e.ax, y: e.ay } : { x: e.bx, y: e.by };
  }
  return order;
}

// Bounded local search: try swapping two stitches' positions, or flipping
// one stitch's direction, keep the change only if it lowers the score.
export function twoOptImprove(hoop, order) {
  let cur = order.map((s) => ({ ...s }));
  let curScore = scoreOrder(hoop, cur).score;
  let improved = true;
  let iterations = 0;
  while (improved && iterations < 5) {
    improved = false;
    iterations++;
    for (let i = 0; i < cur.length; i++) {
      for (let j = i + 1; j < cur.length; j++) {
        const swapped = cur.map((s) => ({ ...s }));
        const tmp = swapped[i];
        swapped[i] = swapped[j];
        swapped[j] = tmp;
        const s1 = scoreOrder(hoop, swapped).score;
        if (s1 < curScore) {
          cur = swapped;
          curScore = s1;
          improved = true;
          continue;
        }
        const flipped = cur.map((s) => ({ ...s }));
        flipped[i] = { ...flipped[i], reversed: !flipped[i].reversed };
        const s2 = scoreOrder(hoop, flipped).score;
        if (s2 < curScore) {
          cur = flipped;
          curScore = s2;
          improved = true;
        }
      }
    }
  }
  return cur;
}

// Tries local search from two different starts — the nearest-neighbor
// greedy order, and the pattern's own natural (naive) order, which is
// often already good since a random-walk motif has zero floats internally
// — and keeps whichever converges lowest. This is what guarantees the
// solver never loses to naiveOrder: one candidate starts there.
export function solveHoop(hoop) {
  const candidates = [greedySolve(hoop), naiveOrder(hoop)];
  let best = null;
  for (const start of candidates) {
    const order = twoOptImprove(hoop, start);
    const back = buildBackGeometry(hoop, order);
    const score = backScore(hoop, back);
    if (!best || score.score < best.score.score) {
      best = { order, back, score };
    }
  }
  return best;
}

// Flipping the hoop over: mirror every x-coordinate about the hoop's
// horizontal center. Applying it twice must return the exact original.
export function mirrorCenterX(hoop) {
  return (hoop.bounds.minX + hoop.bounds.maxX) / 2;
}

export function flipBack(hoop, back) {
  const cx = mirrorCenterX(hoop);
  const mx = (v) => 2 * cx - v;
  return {
    ...back,
    floats: back.floats.map((f) => ({ ...f, x1: mx(f.x1), x2: mx(f.x2) })),
    stitchSegs: back.stitchSegs.map((s) => ({ ...s, x1: mx(s.x1), x2: mx(s.x2) })),
  };
}

export const HOOPS = Array.from({ length: HOOP_COUNT }, (_, i) => generateHoop(HOOP_SEED_BASE + i, i));

const GRADE_FLAVOR = {
  Clean: "grandmother would flip it and nod",
  Honest: "grandmother would flip it, sigh, and still call it good work",
  "Bird's Nest": "grandmother would flip it and reach for the seam ripper",
};

export function gradeFlavor(grade) {
  return GRADE_FLAVOR[grade] || "";
}

export function shareText(hoopNumber, grade) {
  return `\u{1FAA1} BACKSTITCH hoop ${hoopNumber} · back grade: ${grade} · ${gradeFlavor(grade)} · http://backstitch.defimagic.io`;
}
