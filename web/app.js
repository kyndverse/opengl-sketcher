"use strict";

// DOM wiring: renderer, pointer controller, keyboard dispatch and panels.
// Each polygon owns its vertices so different flat colors never share vertex attributes.
// World coordinates use OpenGL NDC: left=-1, right=1, bottom=-1, top=1.
// Model logic lives in geometry.js / editor.js; view math in viewport.js; keys in shortcuts.js.
const G = globalThis.MeshGeometry;
const V = globalThis.MeshViewport;
const K = globalThis.MeshShortcuts;
const { EPS, MAX_POINTS, clamp, round, clone, distance } = G;

const $ = (id) => document.getElementById(id);
const canvas = $("canvas");
const ctx = canvas.getContext("2d");
const frame = $("canvasFrame");
const shell = $("appShell");
const SNAP = 0.05;
const NUDGE = 0.01;
const NUDGE_LARGE = 0.1;
const VERTEX_HIT = 10; // CSS px, independent of zoom
const HANDLE_HIT = 8;
const HANDLE_SIZE = 7;
const BOX_PAD = 6;
const ROTATE_GAP = 22;
const DRAG_THRESHOLD = 3;

const ed = MeshEditor.create();
const view = V.create();
let mode = "select";
let draft = [];
let mouseWorld = null;
let mouseScreen = null;
let drag = null;
let hoverId = null;
let spaceDown = false;
let pointerOverCanvas = false;
let dims = { w: 800, h: 600 };
let canvasSize = { w: 800, h: 600 };
let currentColor = "#ef4444";
let colorPreview = null;

const store = {
  get(key, fallback) {
    try {
      const v = localStorage.getItem(`meshsketch.${key}`);
      return v === null ? fallback : JSON.parse(v);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(`meshsketch.${key}`, JSON.stringify(value));
    } catch {
      /* storage unavailable (private mode) - preferences just won't persist */
    }
  },
};
const aspect = () => dims.w / dims.h;

// ---------------------------------------------------------------- feedback
let toastTimer = 0;
function setStatus(message, kind) {
  const el = $("editorStatus");
  el.textContent = message;
  el.classList.toggle("error", kind === "error");
}
function toast(message, kind) {
  const el = $("toast");
  el.textContent = message;
  el.classList.toggle("error", kind === "error");
  el.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add("hidden"), 1800);
}
// Reports an editor result. Errors always surface; no-ops stay silent.
function report(res, message, { quiet = false } = {}) {
  if (!res.ok) {
    setStatus(res.error, "error");
    if (!quiet) toast(res.error, "error");
  } else if (!res.noop && message) {
    setStatus(typeof message === "function" ? message(res) : message);
    if (!quiet) toast(typeof message === "function" ? message(res) : message);
  }
  updateAll();
  return res;
}

// ---------------------------------------------------------------- modes & draft
function setMode(newMode) {
  mode = newMode;
  $("selectModeBtn").classList.toggle("active", mode === "select");
  $("polygonModeBtn").classList.toggle("active", mode === "polygon");
  $("selectModeBtn").setAttribute("aria-pressed", String(mode === "select"));
  $("polygonModeBtn").setAttribute("aria-pressed", String(mode === "polygon"));
  frame.classList.toggle("selecting", mode === "select");
  if (mode !== "polygon") draft = [];
  refreshDraft();
  setStatus(
    mode === "polygon"
      ? "Klik canvas untuk menambahkan titik. Tekan Enter untuk menyelesaikan."
      : "Pilih objek atau titik. Shift+klik/drag kotak untuk multi-seleksi.",
  );
  updateAll();
}
function refreshDraft() {
  $("draftActions").classList.toggle("hidden", mode !== "polygon");
  $("draftCount").textContent = `${draft.length} titik`;
  $("finishPolygonBtn").disabled = draft.length < 3;
}
function finishPolygon() {
  const error = G.checkPolygon(draft);
  if (error) {
    setStatus(error, "error");
    return;
  }
  const res = ed.addShape(draft, currentColor);
  if (!res.ok) {
    setStatus(res.error, "error");
    return;
  }
  draft = [];
  setMode("select");
  setStatus("Polygon berhasil dibuat. Warna dapat diubah melalui panel Warna.");
}
function cancelPolygon() {
  draft = [];
  refreshDraft();
  setMode("select");
}
function removeDraftPoint() {
  draft.pop();
  refreshDraft();
  updateExport();
  render();
}

// ---------------------------------------------------------------- coordinates
const canvasPoint = (event) => {
  const rect = canvas.getBoundingClientRect();
  return { x: event.clientX - rect.left, y: event.clientY - rect.top };
};
const toScreen = (point) => V.worldToScreen(view, canvasSize, point);
function snapPoint(p, snap) {
  return {
    x: round(snap ? Math.round(p.x / SNAP) * SNAP : p.x),
    y: round(snap ? Math.round(p.y / SNAP) * SNAP : p.y),
  };
}
// Screen → NDC through the view transform, clamped to the NDC square.
function fromScreen(event, snap = $("snapToggle").checked) {
  const w = V.screenToWorld(view, canvasSize, canvasPoint(event));
  return snapPoint({ x: clamp(w.x, -1, 1), y: clamp(w.y, -1, 1) }, snap);
}
const rawWorld = (event) => V.screenToWorld(view, canvasSize, canvasPoint(event));

// ---------------------------------------------------------------- hit testing
const pickable = (s) => !s.hidden && !s.locked;
function findVertex(sp) {
  let best = null;
  const consider = (shape) => {
    shape.points.forEach((p, index) => {
      const d = distance(sp, toScreen(p));
      if (d <= VERTEX_HIT && (!best || d < best.dist)) best = { id: shape.id, index, dist: d };
    });
  };
  // Prefer vertices of already-selected shapes, then top-most shapes.
  ed.selected().filter(pickable).forEach(consider);
  if (best) return best;
  for (let i = ed.shapes.length - 1; i >= 0 && !best; i--)
    if (pickable(ed.shapes[i])) consider(ed.shapes[i]);
  return best;
}
function findShape(world) {
  for (let i = ed.shapes.length - 1; i >= 0; i--) {
    const s = ed.shapes[i];
    if (pickable(s) && G.pointInPolygon(world, s.points)) return s.id;
  }
  return null;
}
// Selection box in screen px (padded so corner handles don't sit on corner vertices).
function selectionBox() {
  const b = ed.selectionBounds();
  if (!b) return null;
  const tl = toScreen({ x: b.minX, y: b.maxY });
  const br = toScreen({ x: b.maxX, y: b.minY });
  return {
    b,
    x1: tl.x - BOX_PAD,
    y1: tl.y - BOX_PAD,
    x2: br.x + BOX_PAD,
    y2: br.y + BOX_PAD,
  };
}
function handlesOf(box) {
  const cx = (box.x1 + box.x2) / 2,
    cy = (box.y1 + box.y2) / 2;
  return [
    { key: "nw", x: box.x1, y: box.y1, cursor: "nwse-resize" },
    { key: "n", x: cx, y: box.y1, cursor: "ns-resize" },
    { key: "ne", x: box.x2, y: box.y1, cursor: "nesw-resize" },
    { key: "e", x: box.x2, y: cy, cursor: "ew-resize" },
    { key: "se", x: box.x2, y: box.y2, cursor: "nwse-resize" },
    { key: "s", x: cx, y: box.y2, cursor: "ns-resize" },
    { key: "sw", x: box.x1, y: box.y2, cursor: "nesw-resize" },
    { key: "w", x: box.x1, y: cy, cursor: "ew-resize" },
    { key: "rotate", x: cx, y: box.y1 - ROTATE_GAP, cursor: "grab" },
  ];
}
const transformable = () =>
  mode === "select" && ed.selection.size > 0 && !ed.selectionLocked();
function findHandle(sp) {
  if (!transformable()) return null;
  const box = selectionBox();
  let best = null;
  for (const h of handlesOf(box)) {
    const d = distance(sp, h);
    if (d <= HANDLE_HIT && (!best || d < best.dist)) best = { ...h, dist: d };
  }
  return best;
}

// ---------------------------------------------------------------- pointer controller
canvas.addEventListener("pointerdown", (event) => {
  canvas.focus({ preventScroll: true });
  closeMenus();
  if (drag) return;
  // Pan: middle mouse, or Space + left drag. Never edits geometry.
  if (event.button === 1 || (event.button === 0 && spaceDown)) {
    event.preventDefault();
    drag = { type: "pan", last: { x: event.clientX, y: event.clientY } };
    frame.classList.add("panning");
    canvas.setPointerCapture(event.pointerId);
    return;
  }
  if (event.button !== 0) return;
  mouseWorld = fromScreen(event);
  if (mode === "polygon") {
    if (nearFirstDraftPoint(event)) return finishPolygon();
    if (draft.length >= MAX_POINTS) {
      setStatus("Jumlah titik maksimum tercapai.", "error");
      return;
    }
    if (draft.length && distance(draft[draft.length - 1], mouseWorld) < EPS) {
      setStatus("Titik tidak boleh sama dengan titik sebelumnya.", "error");
      return;
    }
    const crossing = G.draftSegmentError(draft, mouseWorld);
    if (crossing) {
      setStatus(`Titik ditolak: ${crossing}`, "error");
      return;
    }
    draft.push(mouseWorld);
    refreshDraft();
    updateExport();
    render();
    return;
  }
  const sp = canvasPoint(event);
  const handle = findHandle(sp);
  const vertex = event.shiftKey ? null : findVertex(sp);
  if (handle && (!vertex || handle.dist <= vertex.dist)) {
    startTransformDrag(handle, event, sp);
  } else if (vertex) {
    if (!ed.isSelected(vertex.id)) ed.selectOnly(vertex.id, { group: false });
    ed.primaryId = vertex.id;
    ed.selectedVertex = vertex.index;
    ed.beginGesture();
    drag = { type: "vertex", id: vertex.id, index: vertex.index, startScreen: sp, moved: false };
  } else {
    const id = findShape(rawWorld(event));
    if (id !== null) {
      if (event.shiftKey) ed.toggle(id);
      else {
        if (!ed.isSelected(id)) ed.selectOnly(id);
        else ed.primaryId = id;
        ed.selectedVertex = null;
        ed.beginGesture();
        const base = ed.selected().map((s) => ({ points: ed.gestureBase(s.id) }));
        drag = {
          type: "move",
          id,
          start: fromScreen(event),
          startScreen: sp,
          bounds: G.shapesBounds(base),
          moved: false,
        };
      }
    } else {
      if (!event.shiftKey) ed.clearSelection();
      drag = {
        type: "marquee",
        start: rawWorld(event),
        current: rawWorld(event),
        startScreen: sp,
        additive: event.shiftKey,
      };
    }
  }
  if (drag) canvas.setPointerCapture(event.pointerId);
  updateAll();
});

// Clicking (or snapping onto) the first draft point closes the polygon.
function nearFirstDraftPoint(event) {
  if (draft.length < 3) return false;
  const first = draft[0];
  return (
    distance(canvasPoint(event), toScreen(first)) <= VERTEX_HIT ||
    distance(fromScreen(event), first) < EPS
  );
}

// Double-click on an edge inserts a vertex at the closest point of that edge.
canvas.addEventListener("dblclick", (event) => {
  if (mode !== "select" || drag) return;
  const sp = canvasPoint(event);
  if (findVertex(sp)) return;
  let best = null;
  for (let i = ed.shapes.length - 1; i >= 0 && !best; i--) {
    const shape = ed.shapes[i];
    if (!pickable(shape)) continue;
    shape.points.forEach((p, j) => {
      const q = shape.points[(j + 1) % shape.points.length];
      const c = G.closestOnSegment(sp, toScreen(p), toScreen(q));
      const d = distance(sp, c);
      if (d <= HANDLE_HIT && (!best || d < best.d)) best = { id: shape.id, j, d, p, q, t: c.t };
    });
  }
  if (!best) return;
  const point = {
    x: best.p.x + (best.q.x - best.p.x) * best.t,
    y: best.p.y + (best.q.y - best.p.y) * best.t,
  };
  report(
    ed.insertVertex(best.id, best.j, point),
    "Titik ditambahkan. Tarik untuk mengubah bentuk, Delete untuk menghapus.",
    { quiet: true },
  );
});

function startTransformDrag(handle, event, sp) {
  ed.beginGesture();
  const box = selectionBox();
  const b = box.b;
  if (handle.key === "rotate") {
    const c = toScreen({ x: b.cx, y: b.cy });
    drag = {
      type: "rotate",
      center: c,
      pivot: { x: b.cx, y: b.cy },
      startAngle: Math.atan2(-(sp.y - c.y), sp.x - c.x),
      angle: 0,
      startScreen: sp,
    };
  } else {
    drag = { type: "resize", key: handle.key, bounds: b, startScreen: sp };
  }
}

canvas.addEventListener("pointermove", (event) => {
  mouseScreen = canvasPoint(event);
  mouseWorld = fromScreen(event);
  $("cursorPosition").textContent =
    `X: ${mouseWorld.x.toFixed(2)}    Y: ${mouseWorld.y.toFixed(2)}`;
  if (!drag) {
    updateHover(event);
    render();
    return;
  }
  const sp = mouseScreen;
  const pastThreshold = () => distance(sp, drag.startScreen) >= DRAG_THRESHOLD;
  switch (drag.type) {
    case "pan":
      V.pan(view, event.clientX - drag.last.x, event.clientY - drag.last.y);
      drag.last = { x: event.clientX, y: event.clientY };
      break;
    case "marquee":
      drag.current = rawWorld(event);
      break;
    case "vertex":
      if (!drag.moved && !pastThreshold()) return;
      drag.moved = true;
      ed.previewVertex(drag.id, drag.index, mouseWorld);
      break;
    case "move": {
      if (!drag.moved && !pastThreshold()) return;
      drag.moved = true;
      const { dx, dy } = G.clampDelta(
        drag.bounds,
        mouseWorld.x - drag.start.x,
        mouseWorld.y - drag.start.y,
      );
      ed.previewSelection((pts) => G.translatePoints(pts, dx, dy));
      break;
    }
    case "resize":
      previewResize(event);
      break;
    case "rotate": {
      const c = drag.center;
      let angle = Math.atan2(-(sp.y - c.y), sp.x - c.x) - drag.startAngle;
      if (event.shiftKey) angle = Math.round(angle / (Math.PI / 12)) * (Math.PI / 12);
      drag.angle = angle;
      ed.previewSelection((pts) => G.rotatePoints(pts, angle, drag.pivot, aspect()));
      setStatus(`Rotasi ${Math.round((angle * 180) / Math.PI)}°`);
      break;
    }
  }
  render();
  if (drag.type !== "pan" && drag.type !== "marquee") {
    updateExport();
    updateProperties();
  }
});

function previewResize(event) {
  const b = drag.bounds;
  const key = drag.key;
  const hx = key.includes("e") ? 1 : key.includes("w") ? -1 : 0;
  const hy = key.includes("n") ? 1 : key.includes("s") ? -1 : 0;
  const m = fromScreen(event);
  const anchor = {
    x: hx === 1 ? b.minX : hx === -1 ? b.maxX : b.cx,
    y: hy === 1 ? b.minY : hy === -1 ? b.maxY : b.cy,
  };
  // Minimum size 0.01 NDC; no negative scale via handles (use Flip instead).
  let sx = hx ? Math.max((m.x - anchor.x) / (hx * b.w), 0.01 / b.w) : 1;
  let sy = hy ? Math.max((m.y - anchor.y) / (hy * b.h), 0.01 / b.h) : 1;
  if (event.shiftKey || $("aspectLock").checked) {
    const s = hx && hy ? Math.max(sx, sy) : hx ? sx : sy;
    sx = sy = s;
  }
  ed.previewSelection((pts) => G.scalePoints(pts, sx, sy, anchor));
  setStatus(`Skala ${Math.round(sx * 100)}% × ${Math.round(sy * 100)}%`);
}

function updateHover(event) {
  const sp = canvasPoint(event);
  let cursor = "";
  hoverId = null;
  if (spaceDown) cursor = "grab";
  else if (mode === "select") {
    const handle = findHandle(sp);
    const vertex = findVertex(sp);
    if (handle && (!vertex || handle.dist <= vertex.dist)) cursor = handle.cursor;
    else if (vertex) cursor = "pointer";
    else {
      hoverId = findShape(rawWorld(event));
      if (hoverId !== null) cursor = "move";
    }
  }
  canvas.style.cursor = cursor;
}

function finishDragging() {
  if (!drag) return;
  const d = drag;
  drag = null;
  frame.classList.remove("panning");
  if (d.type === "pan") return render();
  if (d.type === "marquee") {
    if (distance(mouseScreen ?? d.startScreen, d.startScreen) >= DRAG_THRESHOLD) {
      const n = ed.selectInRect(
        { x1: d.start.x, y1: d.start.y, x2: d.current.x, y2: d.current.y },
        d.additive,
      );
      setStatus(n ? `${ed.selection.size} objek terpilih.` : "Tidak ada objek di dalam kotak.");
    }
    return updateAll();
  }
  const res = ed.endGesture();
  // A plain click (no drag) on a member of a multi-selection narrows it to that object.
  if (d.type === "move" && !d.moved && ed.selection.size > 1 && ed.groupMembers(d.id).length < ed.selection.size)
    ed.selectOnly(d.id);
  if (!res.ok) setStatus(`Perubahan dibatalkan: ${res.error}`, "error");
  else if (!res.noop) setStatus("Koordinat berhasil diperbarui.");
  updateAll();
}
function cancelDragging() {
  if (!drag) return;
  if (!["pan", "marquee"].includes(drag.type)) ed.cancelGesture();
  drag = null;
  frame.classList.remove("panning");
  setStatus("Operasi dibatalkan.");
  updateAll();
}
canvas.addEventListener("pointerup", finishDragging);
canvas.addEventListener("pointercancel", cancelDragging);
canvas.addEventListener("pointerenter", () => (pointerOverCanvas = true));
canvas.addEventListener("pointerleave", () => {
  pointerOverCanvas = false;
  if (!drag) {
    mouseWorld = null;
    mouseScreen = null;
    hoverId = null;
    $("cursorPosition").textContent = "X: -    Y: -";
    render();
  }
});
canvas.addEventListener("auxclick", (e) => e.button === 1 && e.preventDefault());

// Wheel: zoom anchored at the cursor.
canvas.addEventListener(
  "wheel",
  (event) => {
    event.preventDefault();
    const unit = event.deltaMode === 1 ? 0.05 : event.deltaMode === 2 ? 1 : 0.0015;
    const factor = Math.exp(-event.deltaY * unit);
    zoomTo(view.scale * factor, canvasPoint(event));
  },
  { passive: false },
);

// ---------------------------------------------------------------- viewport controls
const canvasCenter = () => ({ x: canvasSize.w / 2, y: canvasSize.h / 2 });
function zoomTo(scale, anchor = canvasCenter()) {
  V.zoomAt(view, scale, anchor);
  updateZoomUI();
  render();
}
const zoomStep = (dir) => zoomTo(V.stepScale(view.scale, dir));
function resetZoom() {
  V.reset(view);
  updateZoomUI();
  render();
}
function fitView() {
  const visible = ed.shapes.filter((s) => !s.hidden);
  V.fit(view, canvasSize, visible.length ? G.shapesBounds(visible) : null, 40);
  updateZoomUI();
  render();
  setStatus(visible.length ? "Fit to view." : "Canvas kosong - zoom direset.");
}
function updateZoomUI() {
  $("zoomLabel").textContent = `${Math.round(view.scale * 100)}%`;
  $("zoomOutBtn").disabled = view.scale <= V.MIN_SCALE + 1e-6;
  $("zoomInBtn").disabled = view.scale >= V.MAX_SCALE - 1e-6;
  for (const btn of $("zoomPresets").children)
    btn.classList.toggle("active", Math.abs(Number(btn.dataset.zoom) - view.scale) < 1e-6);
}

function resizeCanvas() {
  const rect = canvas.getBoundingClientRect();
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  const next = { w: rect.width, h: rect.height };
  V.resize(view, canvasSize, next);
  canvasSize = next;
  canvas.width = Math.max(1, Math.round(rect.width * dpr));
  canvas.height = Math.max(1, Math.round(rect.height * dpr));
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  render();
}

// ---------------------------------------------------------------- renderer
function drawPath(points, close = true) {
  points.forEach((p, i) => {
    const s = toScreen(p);
    if (i === 0) ctx.moveTo(s.x, s.y);
    else ctx.lineTo(s.x, s.y);
  });
  if (close) ctx.closePath();
}
function themePalette() {
  const dark = document.documentElement.dataset.theme === "dark";
  return dark
    ? {
        background: "#111114",
        outside: "#0b0b0d",
        bounds: "#3f3f46",
        axis: "#52525b",
        major: "#313136",
        grid: "#242429",
        fine: "#1b1b1f",
        selection: "#60a5fa",
        outline: "#a1a1aa",
        vertex: "#ffffff",
        selectedVertex: "#facc15",
        label: "#fafafa",
        draft: "#e4e4e7",
        draftPoint: "#fafafa",
        error: "#f87171",
      }
    : {
        background: "#ffffff",
        outside: "#f1f1f3",
        bounds: "#d4d4d8",
        axis: "#a1a1aa",
        major: "#e4e4e7",
        grid: "#f4f4f5",
        fine: "#f8f8f9",
        selection: "#2563eb",
        outline: "#3f3f4655",
        vertex: "#ffffff",
        selectedVertex: "#facc15",
        label: "#18181b",
        draft: "#18181b",
        draftPoint: "#18181b",
        error: "#dc2626",
      };
}
function render() {
  const { w, h } = canvasSize;
  const palette = themePalette();
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = palette.outside;
  ctx.fillRect(0, 0, w, h);
  const tl = toScreen({ x: -1, y: 1 });
  const br = toScreen({ x: 1, y: -1 });
  ctx.fillStyle = palette.background;
  ctx.fillRect(tl.x, tl.y, br.x - tl.x, br.y - tl.y);
  if ($("gridToggle").checked) drawGrid(palette, tl, br);
  if (view.scale < 1 - 1e-6 || view.offsetX || view.offsetY) {
    ctx.strokeStyle = palette.bounds;
    ctx.lineWidth = 1;
    ctx.strokeRect(tl.x + 0.5, tl.y + 0.5, br.x - tl.x - 1, br.y - tl.y - 1);
  }

  const single = ed.selection.size === 1;
  for (const shape of ed.shapes) {
    if (shape.hidden) continue;
    const selected = ed.isSelected(shape.id);
    ctx.beginPath();
    drawPath(shape.points);
    ctx.fillStyle = shape.color;
    ctx.fill();
    ctx.strokeStyle = selected || shape.id === hoverId ? palette.selection : palette.outline;
    ctx.lineWidth = selected ? 2 : shape.id === hoverId ? 1.5 : 1;
    ctx.stroke();
  }
  const primary = ed.primary();
  if (primary && !primary.hidden) {
    const pb = G.bounds(primary.points);
    const centre = toScreen({ x: pb.cx, y: pb.cy });
    primary.points.forEach((p, index) => {
      const s = toScreen(p);
      const active = index === ed.selectedVertex;
      ctx.beginPath();
      ctx.arc(s.x, s.y, active ? 6.5 : single ? 4.5 : 3.5, 0, Math.PI * 2);
      ctx.fillStyle = active ? palette.selectedVertex : palette.vertex;
      ctx.fill();
      ctx.strokeStyle = palette.selection;
      ctx.lineWidth = 1.5;
      ctx.stroke();
      if (single) {
        ctx.font = "11px ui-monospace, monospace";
        ctx.fillStyle = palette.label;
        const dx = s.x - centre.x,
          dy = s.y - centre.y,
          len = Math.hypot(dx, dy) || 1;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(String(index), s.x + (dx / len) * 15, s.y + (dy / len) * 15);
        ctx.textAlign = "start";
        ctx.textBaseline = "alphabetic";
      }
    });
  }
  drawSelectionBox(palette);

  if (draft.length) {
    const closing =
      mode === "polygon" &&
      mouseScreen &&
      draft.length >= 3 &&
      distance(mouseScreen, toScreen(draft[0])) <= VERTEX_HIT;
    ctx.beginPath();
    drawPath(draft, false);
    ctx.strokeStyle = palette.draft;
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 4]);
    ctx.stroke();
    if (mouseWorld && !closing) {
      // rubber band: red when the next edge would cross the path
      const bad = G.draftSegmentError(draft, mouseWorld);
      const a = toScreen(draft[draft.length - 1]),
        p = toScreen(mouseWorld);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(p.x, p.y);
      ctx.strokeStyle = bad ? palette.error : palette.draft;
      ctx.stroke();
      if (draft.length >= 2) {
        // closing edge preview
        const badClose = bad || G.draftClosingError([...draft, mouseWorld]);
        const b = toScreen(draft[0]);
        ctx.beginPath();
        ctx.moveTo(p.x, p.y);
        ctx.lineTo(b.x, b.y);
        ctx.globalAlpha = badClose ? 0.7 : 0.35;
        ctx.strokeStyle = badClose ? palette.error : palette.draft;
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.globalAlpha = 1;
      }
    } else if (closing) {
      const a = toScreen(draft[draft.length - 1]),
        b = toScreen(draft[0]);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.strokeStyle = G.draftClosingError(draft) ? palette.error : palette.selection;
      ctx.stroke();
    }
    ctx.setLineDash([]);
    if (closing) {
      const f0 = toScreen(draft[0]);
      ctx.beginPath();
      ctx.arc(f0.x, f0.y, 9, 0, Math.PI * 2);
      ctx.strokeStyle = palette.selection;
      ctx.lineWidth = 2;
      ctx.stroke();
    }
    draft.forEach((p, i) => {
      const s = toScreen(p);
      ctx.beginPath();
      ctx.arc(s.x, s.y, 5, 0, Math.PI * 2);
      ctx.fillStyle = palette.draftPoint;
      ctx.fill();
      ctx.fillStyle = palette.label;
      ctx.font = "11px monospace";
      ctx.fillText(String(i), s.x + 9, s.y - 8);
    });
  }
  if (mouseWorld && mode === "polygon" && !drag) {
    const s = toScreen(mouseWorld);
    ctx.beginPath();
    ctx.arc(s.x, s.y, 3, 0, Math.PI * 2);
    ctx.fillStyle = palette.draft;
    ctx.fill();
  }
  if (drag?.type === "marquee") {
    const a = toScreen(drag.start),
      b = toScreen(drag.current);
    ctx.fillStyle = palette.selection + "1f";
    ctx.strokeStyle = palette.selection;
    ctx.lineWidth = 1;
    ctx.fillRect(a.x, a.y, b.x - a.x, b.y - a.y);
    ctx.strokeRect(a.x + 0.5, a.y + 0.5, b.x - a.x, b.y - a.y);
  }
}
function drawGrid(palette, tl, br) {
  ctx.save();
  ctx.beginPath();
  ctx.rect(tl.x, tl.y, br.x - tl.x, br.y - tl.y);
  ctx.clip();
  ctx.lineWidth = 1;
  const line = (val, color) => {
    const s = toScreen({ x: val, y: val });
    ctx.strokeStyle = color;
    ctx.beginPath();
    ctx.moveTo(Math.round(s.x) + 0.5, tl.y);
    ctx.lineTo(Math.round(s.x) + 0.5, br.y);
    ctx.moveTo(tl.x, Math.round(s.y) + 0.5);
    ctx.lineTo(br.x, Math.round(s.y) + 0.5);
    ctx.stroke();
  };
  // Snap-step (0.05) lines appear once they are far enough apart to be useful.
  if (view.scale >= 2) for (let i = -19; i <= 19; i += 2) line(i / 20, palette.fine);
  for (let i = -10; i <= 10; i++)
    line(i / 10, i === 0 ? palette.axis : i % 5 === 0 ? palette.major : palette.grid);
  ctx.restore();
}
function drawSelectionBox(palette) {
  if (mode !== "select" || !ed.selection.size || drag?.type === "marquee") return;
  if (drag?.type === "vertex") return;
  const box = selectionBox();
  ctx.save();
  ctx.strokeStyle = palette.selection;
  ctx.lineWidth = 1;
  ctx.setLineDash(ed.selection.size > 1 ? [4, 3] : []);
  ctx.strokeRect(box.x1 + 0.5, box.y1 + 0.5, box.x2 - box.x1, box.y2 - box.y1);
  ctx.setLineDash([]);
  if (!ed.selectionLocked()) {
    const handles = handlesOf(box);
    const rot = handles.at(-1);
    ctx.beginPath();
    ctx.moveTo(rot.x, box.y1);
    ctx.lineTo(rot.x, rot.y);
    ctx.stroke();
    for (const hd of handles) {
      ctx.beginPath();
      if (hd.key === "rotate") ctx.arc(hd.x, hd.y, 4.5, 0, Math.PI * 2);
      else ctx.rect(hd.x - HANDLE_SIZE / 2, hd.y - HANDLE_SIZE / 2, HANDLE_SIZE, HANDLE_SIZE);
      ctx.fillStyle = "#ffffff";
      ctx.fill();
      ctx.stroke();
    }
  }
  ctx.restore();
}

// ---------------------------------------------------------------- panels
const svgIcon = (id) => {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
  use.setAttribute("href", `#${id}`);
  svg.append(use);
  return svg;
};
function updateShapeList() {
  const list = $("shapeList");
  list.replaceChildren();
  $("shapeCount").textContent = String(ed.shapes.length);
  if (!ed.shapes.length) {
    const t = document.createElement("p");
    t.className = "subtext";
    t.textContent = "Belum ada polygon.";
    list.append(t);
    return;
  }
  for (let i = ed.shapes.length - 1; i >= 0; i--) {
    const s = ed.shapes[i];
    const row = document.createElement("div");
    row.className =
      "shape-item" +
      (ed.isSelected(s.id) ? " active" : "") +
      (ed.primaryId === s.id && ed.selection.size > 1 ? " primary" : "") +
      (s.hidden ? " is-hidden" : "");
    const main = document.createElement("button");
    main.type = "button";
    main.className = "shape-main";
    main.title = "Klik untuk memilih · Shift/Ctrl+klik untuk menambah";
    const dot = document.createElement("span");
    dot.className = "shape-dot";
    dot.style.background = s.color;
    const content = document.createElement("span");
    content.className = "shape-caption";
    const title = document.createElement("strong");
    title.textContent = s.name;
    const sub = document.createElement("small");
    sub.textContent =
      `${s.points.length} titik · ${s.points.length - 2} segitiga` +
      (s.groupId != null ? ` · group ${s.groupId}` : "");
    content.append(title, sub);
    main.append(dot, content);
    main.addEventListener("click", (e) => {
      if (mode !== "select") setMode("select");
      if (e.shiftKey || e.ctrlKey || e.metaKey) ed.toggle(s.id, { group: false });
      else ed.selectOnly(s.id, { group: false });
      updateAll();
    });
    const eye = document.createElement("button");
    eye.type = "button";
    eye.className = "button button-ghost icon-button" + (s.hidden ? " on" : "");
    eye.title = s.hidden ? "Tampilkan" : "Sembunyikan (tidak diekspor)";
    eye.setAttribute("aria-label", eye.title);
    eye.append(svgIcon(s.hidden ? "i-eye-off" : "i-eye"));
    eye.addEventListener("click", () => {
      const hide = !s.hidden;
      report(ed.setFlag(s.id, "hidden", hide), hide ? `${s.name} disembunyikan.` : `${s.name} ditampilkan.`, { quiet: true });
      if (hide && ed.isSelected(s.id)) {
        ed.setSelection([...ed.selection].filter((id) => id !== s.id), ed.primaryId);
        updateAll();
      }
    });
    const lock = document.createElement("button");
    lock.type = "button";
    lock.className = "button button-ghost icon-button" + (s.locked ? " on" : "");
    lock.title = s.locked ? "Buka kunci" : "Kunci (tidak bisa dipilih/diubah di canvas)";
    lock.setAttribute("aria-label", lock.title);
    lock.append(svgIcon(s.locked ? "i-lock" : "i-unlock"));
    lock.addEventListener("click", () =>
      report(ed.setFlag(s.id, "locked", !s.locked), s.locked ? `${s.name} dibuka.` : `${s.name} dikunci.`, { quiet: true }),
    );
    row.append(main, eye, lock);
    list.append(row);
  }
}
const fmt = (v) => String(round(v, 4));
function setField(id, value) {
  const el = $(id);
  if (document.activeElement !== el) el.value = value;
}
function updateProperties() {
  const sel = ed.selected();
  const count = sel.length;
  $("propertiesSection").classList.toggle("hidden", !count);
  const locked = ed.selectionLocked();
  const hasGroup = sel.some((s) => s.groupId != null);
  // Contextual toolbar
  for (const btn of $("contextToolbar").querySelectorAll("button"))
    btn.disabled = !count || locked;
  $("colorHint").textContent = count
    ? `Klik warna untuk menerapkan ke ${count} objek terpilih.`
    : "Warna dipakai untuk polygon baru.";
  updatePaletteState();
  if (!count) return;
  const primary = ed.primary();
  $("propertiesTitle").textContent = count === 1 ? "Properties" : `${count} objek`;
  $("selectionCount").textContent = String(count);
  $("singleProps").classList.toggle("hidden", count !== 1);
  if (count === 1) setField("shapeName", primary.name);
  const b = G.shapesBounds(sel);
  setField("propX", fmt(b.cx));
  setField("propY", fmt(b.cy));
  setField("propW", fmt(b.w));
  setField("propH", fmt(b.h));
  for (const el of $("propertiesSection").querySelectorAll("input:not(#shapeName), .chip, #rotateCcwBtn, #rotateCwBtn, #scaleApplyBtn, [data-align], #distHBtn, #distVBtn"))
    el.disabled = locked;
  $("alignSection").classList.toggle("hidden", count < 2);
  $("distHBtn").disabled = $("distVBtn").disabled = locked || count < 3;
  const idx = ed.shapes.map((s) => ed.isSelected(s.id));
  $("layerDownBtn").disabled = !idx.some((v, i) => v && i > 0 && !idx[i - 1]);
  $("layerUpBtn").disabled = !idx.some((v, i) => v && i < idx.length - 1 && !idx[i + 1]);
  $("groupBtn").disabled = !hasGroup && count < 2;
  $("groupBtn").title = hasGroup ? "Ungroup (Ctrl+Shift+G)" : "Group (Ctrl+G)";
  $("groupBtn").setAttribute("aria-label", hasGroup ? "Ungroup" : "Group");
  $("groupBtn").setAttribute("aria-pressed", String(hasGroup));
  $("deleteBtn").disabled = locked;
  const v = ed.selectedVertex;
  const hasVertex = primary && Number.isInteger(v) && v >= 0 && v < primary.points.length;
  $("selectedVertexEditor").classList.toggle("hidden", !hasVertex);
  if (hasVertex) {
    $("selectedVertexIndex").textContent = `#${v} · ${primary.name}`;
    setField("vertexX", primary.points[v].x);
    setField("vertexY", primary.points[v].y);
  }
}
function updateExport() {
  try {
    const mesh = G.buildMesh(ed.shapes);
    $("codeOutput").value = mesh.vertices.length
      ? G.exportCpp(mesh, { snippet: $("snippetToggle").checked })
      : "// Belum ada polygon. Pilih mode Polygon untuk mulai menggambar.";
    $("copyBtn").disabled = !mesh.vertices.length;
    $("cppDownloadBtn").disabled = !mesh.vertices.length;
    $("vertexCount").textContent = String(mesh.vertices.length);
    $("triangleCount").textContent = String(mesh.indices.length);
    $("indexCount").textContent = String(mesh.indices.length * 3);
  } catch (err) {
    $("codeOutput").value =
      `// ${err.message}\n// Perbaiki titik polygon sebelum mengekspor.`;
    $("vertexCount").textContent = "-";
    $("triangleCount").textContent = "-";
    $("indexCount").textContent = "-";
  }
  const hidden = ed.shapes.filter((s) => s.hidden).length;
  $("hiddenNote").textContent = hidden ? `${hidden} tersembunyi, tidak diekspor` : "";
  $("undoBtn").disabled = !ed.history.length && !draft.length;
  $("redoBtn").disabled = !ed.future.length || !!draft.length;
}
function updateAll() {
  updateShapeList();
  updateProperties();
  updateExport();
  updateZoomUI();
  render();
  scheduleAutosave();
}

// Autosave: the document (not the view) is kept in localStorage, debounced.
let autosaveTimer = 0;
let lastAutosave = null;
function writeAutosave() {
  if (ed.gesture || colorPreview || drag) return scheduleAutosave();
  const data = G.serializeProject(ed.shapes, dims);
  if (data === lastAutosave) return;
  store.set("autosave", data);
  lastAutosave = data;
}
function scheduleAutosave() {
  clearTimeout(autosaveTimer);
  autosaveTimer = setTimeout(writeAutosave, 400);
}
window.addEventListener("pagehide", () => {
  clearTimeout(autosaveTimer);
  writeAutosave();
});

// ---------------------------------------------------------------- colour palette
const PALETTE = [
  ["Neutral", ["#ffffff", "#d4d4d8", "#a1a1aa", "#52525b", "#27272a", "#09090b"]],
  ["Warm", ["#ef4444", "#f97316", "#f59e0b", "#eab308", "#b45309", "#7f1d1d"]],
  ["Cool", ["#22c55e", "#14b8a6", "#06b6d4", "#3b82f6", "#6366f1", "#1e3a8a"]],
  ["Pastel", ["#fecaca", "#fed7aa", "#fef08a", "#bbf7d0", "#bfdbfe", "#e9d5ff"]],
  ["Vivid", ["#ff0055", "#ff00ff", "#8b00ff", "#00e5ff", "#00ff66", "#ffea00"]],
];
let recentColors = store.get("recentColors", []).filter((c) => /^#[0-9a-f]{6}$/.test(c));
function swatch(color) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "swatch";
  b.style.background = color;
  b.dataset.color = color;
  b.title = color.toUpperCase();
  b.setAttribute("aria-label", `Warna ${color.toUpperCase()}`);
  b.addEventListener("click", () => applyColor(color));
  return b;
}
function buildPalette() {
  const root = $("palette");
  for (const [name, colors] of PALETTE) {
    const row = document.createElement("div");
    row.className = "palette-group";
    const label = document.createElement("span");
    label.textContent = name;
    row.append(label, ...colors.map(swatch));
    root.append(row);
  }
}
function renderRecent() {
  $("recentColors").replaceChildren(...recentColors.map(swatch));
}
function normalizeHex(value) {
  let v = value.trim().toLowerCase();
  if (!v.startsWith("#")) v = `#${v}`;
  if (/^#[0-9a-f]{3}$/.test(v)) v = `#${[...v.slice(1)].map((c) => c + c).join("")}`;
  return /^#[0-9a-f]{6}$/.test(v) ? v : null;
}
function updatePaletteState() {
  const primary = ed.primary();
  const shown = primary ? primary.color : currentColor;
  $("currentColorDot").style.background = shown;
  $("newColorHex").textContent = shown.toUpperCase();
  if (document.activeElement !== $("hexInput")) {
    $("hexInput").value = shown.toUpperCase();
    $("hexInput").classList.remove("invalid");
  }
  if (!colorPreview) $("newColor").value = shown;
  for (const el of document.querySelectorAll(".swatch"))
    el.classList.toggle("active", el.dataset.color === shown);
}
function applyColor(color) {
  currentColor = color;
  recentColors = [color, ...recentColors.filter((c) => c !== color)].slice(0, 8);
  store.set("recentColors", recentColors);
  store.set("color", color);
  renderRecent();
  if (ed.selection.size) {
    if (ed.selected().every((s) => s.color === color)) return updateAll();
    report(ed.setColor(color), `Warna ${color.toUpperCase()} diterapkan ke ${ed.selection.size} objek.`, { quiet: true });
  } else {
    setStatus(`Warna polygon baru: ${color.toUpperCase()}`);
    updateAll();
  }
}

// ---------------------------------------------------------------- shortcuts
const isTyping = () => K.isTypingTarget(document.activeElement);
const textSelected = () => {
  const sel = window.getSelection?.();
  return !!sel && !sel.isCollapsed && sel.toString().length > 0;
};
const actions = {
  undo() {
    if (drag) return;
    if (draft.length) return removeDraftPoint();
    report(ed.undo() ? { ok: true } : { ok: true, noop: true }, "Undo.", { quiet: true });
  },
  redo() {
    if (drag || draft.length) return;
    report(ed.redo() ? { ok: true } : { ok: true, noop: true }, "Redo.", { quiet: true });
  },
  copy: () => report(ed.copy(), (r) => `${r.count} objek disalin.`),
  cut: () => report(ed.cut(), (r) => `${r.count} objek dipotong.`),
  paste() {
    if (mode !== "select") setMode("select");
    report(ed.paste(), (r) => `${r.count} objek ditempel.`);
  },
  selectAll() {
    if (draft.length) return;
    if (mode !== "select") setMode("select");
    ed.selectAll();
    setStatus(`${ed.selection.size} objek terpilih.`);
    updateAll();
  },
  duplicate: () => report(ed.duplicate(), (r) => `${r.count} objek diduplikat.`),
  deleteSelection() {
    if (!ed.selection.size) return;
    report(ed.deleteSelection(), (r) => `${r.count} objek dihapus. Ctrl+Z untuk membatalkan.`);
  },
  removeDraftPoint,
  deleteVertex: () => report(ed.deleteVertex(), "Titik dihapus.", { quiet: true }),
  save: () => saveProject(),
  open: () => $("jsonInput").click(),
  escape() {
    if (closeMenus()) return;
    if (tour.open) return tour.end();
    if (drag) return cancelDragging();
    if (mode === "polygon") return cancelPolygon();
    if (Number.isInteger(ed.selectedVertex)) ed.selectedVertex = null;
    else ed.clearSelection();
    updateAll();
  },
  finishPolygon,
  toolSelect: () => mode !== "select" && setMode("select"),
  toolPolygon: () => mode !== "polygon" && setMode("polygon"),
  nudge({ x, y, large }) {
    if (drag) return;
    const step = large ? NUDGE_LARGE : NUDGE;
    if (Number.isInteger(ed.selectedVertex) && ed.selection.size === 1)
      return report(ed.nudgeVertex(x * step, y * step), null, { quiet: true });
    if (!ed.selection.size) return;
    report(ed.nudge(x * step, y * step), null, { quiet: true });
  },
  zoomIn: () => zoomStep(1),
  zoomOut: () => zoomStep(-1),
  zoomReset: resetZoom,
  fitView,
  group: () => report(ed.group(), "Objek di-group. Klik salah satu untuk memilih semuanya."),
  ungroup: () => report(ed.ungroup(), "Group dilepas."),
  showShortcuts: () => $("shortcutsDialog").showModal(),
};

document.addEventListener("keydown", (e) => {
  if ($("shortcutsDialog").open) return; // native dialog handles Esc/Tab
  const typing = isTyping();
  if (e.code === "Space" && !typing && !e.ctrlKey && !e.metaKey && !e.altKey) {
    if (!spaceDown) {
      spaceDown = true;
      frame.classList.add("pan-ready");
    }
    if (pointerOverCanvas || document.activeElement === canvas || document.activeElement === document.body)
      e.preventDefault();
    return;
  }
  const res = K.resolve(e, {
    typing,
    textSelected: textSelected(),
    mode,
    draftLength: draft.length,
    vertexSelected: Number.isInteger(ed.selectedVertex) && ed.selection.size === 1,
  });
  if (!res) return;
  e.preventDefault();
  actions[res.action](res.args);
});
document.addEventListener("keyup", (e) => {
  if (e.code === "Space" && spaceDown) {
    spaceDown = false;
    frame.classList.remove("pan-ready");
    if (pointerOverCanvas || document.activeElement === canvas) e.preventDefault();
  }
});
window.addEventListener("blur", () => {
  spaceDown = false;
  frame.classList.remove("pan-ready");
});

// ---------------------------------------------------------------- menus & panels
function closeMenus() {
  let closed = false;
  for (const [menu, btn] of [
    ["helpMenu", "helpBtn"],
    ["zoomMenu", "zoomLabel"],
  ]) {
    if (!$(menu).classList.contains("hidden")) {
      $(menu).classList.add("hidden");
      $(btn).setAttribute("aria-expanded", "false");
      closed = true;
    }
  }
  return closed;
}
function toggleMenu(menu, btn) {
  const open = $(menu).classList.contains("hidden");
  closeMenus();
  if (open) {
    $(menu).classList.remove("hidden");
    $(btn).setAttribute("aria-expanded", "true");
    $(menu).querySelector("button")?.focus();
  }
}
document.addEventListener("pointerdown", (e) => {
  if (!e.target.closest(".menu-wrap")) closeMenus();
});
$("helpBtn").addEventListener("click", () => toggleMenu("helpMenu", "helpBtn"));
$("zoomLabel").addEventListener("click", () => toggleMenu("zoomMenu", "zoomLabel"));
$("showShortcutsBtn").addEventListener("click", () => {
  closeMenus();
  $("shortcutsDialog").showModal();
});
$("showTutorialBtn").addEventListener("click", () => {
  closeMenus();
  tour.start();
});
$("shortcutsDialog").addEventListener("click", (e) => {
  if (e.target === e.currentTarget || e.target.closest("[data-close]")) $("shortcutsDialog").close();
});

function setPanel(side, open, persist = true) {
  shell.classList.toggle(`${side}-collapsed`, !open);
  $(side === "left" ? "toggleLeftBtn" : "toggleRightBtn").setAttribute("aria-pressed", String(open));
  if (persist) store.set(`panel.${side}`, open);
}
$("toggleLeftBtn").addEventListener("click", () =>
  setPanel("left", shell.classList.contains("left-collapsed")),
);
$("toggleRightBtn").addEventListener("click", () =>
  setPanel("right", shell.classList.contains("right-collapsed")),
);

// ---------------------------------------------------------------- misc helpers
function applyViewport(value) {
  const [w, h] = value.split("x").map(Number);
  dims = { w, h };
  frame.style.setProperty("--canvas-ratio", `${w}/${h}`);
  frame.style.setProperty("--canvas-ratio-value", String(w / h));
  $("ratioLabel").textContent = `${w / gcd(w, h)}:${h / gcd(w, h)}`;
  setStatus(
    `Preview memakai rasio ${w}:${h}. Gunakan rasio yang sama pada OpenGL.`,
  );
  requestAnimationFrame(resizeCanvas);
  scheduleAutosave();
}
function gcd(a, b) {
  return b ? gcd(b, a % b) : a;
}
function download(filename, text, mime) {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function loadExample() {
  return [
    {
      id: 1,
      name: "Badan rumah",
      color: "#2563eb",
      points: [
        { x: -0.35, y: -0.55 },
        { x: 0.35, y: -0.55 },
        { x: 0.35, y: 0.18 },
        { x: -0.35, y: 0.18 },
      ],
    },
    {
      id: 2,
      name: "Atap",
      color: "#ef4444",
      points: [
        { x: -0.43, y: 0.18 },
        { x: 0.43, y: 0.18 },
        { x: 0, y: 0.68 },
      ],
    },
    {
      id: 3,
      name: "Pintu",
      color: "#f6c570",
      points: [
        { x: -0.09, y: -0.55 },
        { x: 0.09, y: -0.55 },
        { x: 0.09, y: -0.19 },
        { x: -0.09, y: -0.19 },
      ],
    },
  ];
}
function setTheme(theme) {
  const dark = theme === "dark";
  document.documentElement.dataset.theme = dark ? "dark" : "light";
  $("themeToggleBtn").setAttribute(
    "aria-label",
    dark ? "Aktifkan mode terang" : "Aktifkan mode gelap",
  );
  $("themeToggleBtn").setAttribute("aria-pressed", String(dark));
  $("themeIcon").setAttribute("href", dark ? "#i-sun" : "#i-moon");
  store.set("theme", dark ? "dark" : "light");
  render();
}

// ---------------------------------------------------------------- control wiring
$("themeToggleBtn").addEventListener("click", () => {
  setTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark");
});
$("selectModeBtn").addEventListener("click", () => setMode("select"));
$("polygonModeBtn").addEventListener("click", () => setMode("polygon"));
$("finishPolygonBtn").addEventListener("click", finishPolygon);
$("cancelPolygonBtn").addEventListener("click", cancelPolygon);
$("viewportSelect").addEventListener("change", (e) => applyViewport(e.target.value));
$("gridToggle").addEventListener("change", render);
$("snapToggle").addEventListener("change", render);
$("undoBtn").addEventListener("click", actions.undo);
$("redoBtn").addEventListener("click", actions.redo);
$("zoomInBtn").addEventListener("click", () => zoomStep(1));
$("zoomOutBtn").addEventListener("click", () => zoomStep(-1));
$("fitBtn").addEventListener("click", fitView);
for (const step of V.ZOOM_STEPS) {
  const b = document.createElement("button");
  b.type = "button";
  b.setAttribute("role", "menuitem");
  b.dataset.zoom = String(step);
  b.textContent = `${Math.round(step * 100)}%`;
  $("zoomPresets").append(b);
}
$("zoomMenu").addEventListener("click", (e) => {
  const z = e.target.closest("[data-zoom]")?.dataset.zoom;
  if (!z) return;
  closeMenus();
  if (z === "fit") fitView();
  else zoomTo(Number(z));
});

// Colour
$("newColor").addEventListener("input", (e) => {
  // Live preview on the selection; committed as one history entry on "change".
  const color = e.target.value;
  if (ed.selection.size && !ed.selectionLocked()) {
    colorPreview ??= ed.snapshot();
    for (const s of ed.selected()) s.color = color;
    updateShapeList();
    render();
  }
  $("currentColorDot").style.background = color;
  $("newColorHex").textContent = color.toUpperCase();
});
$("newColor").addEventListener("change", (e) => {
  if (colorPreview) {
    ed.restore(colorPreview);
    colorPreview = null;
  }
  applyColor(e.target.value.toLowerCase());
});
$("hexInput").addEventListener("change", (e) => {
  const hex = normalizeHex(e.target.value);
  e.target.classList.toggle("invalid", !hex);
  if (!hex) return setStatus("HEX tidak valid. Contoh: #FF8800", "error");
  applyColor(hex);
});
$("hexInput").addEventListener("keydown", (e) => {
  if (e.key === "Enter") e.target.blur();
});

// Properties
$("shapeName").addEventListener("change", (e) => {
  const name = e.target.value.trim();
  const p = ed.primary();
  if (name && p && name !== p.name) report(ed.rename(p.id, name), "Nama diperbarui.", { quiet: true });
  else updateProperties();
});
function numberFrom(id) {
  const n = Number($(id).value);
  return $(id).value.trim() === "" || !Number.isFinite(n) ? null : n;
}
function boundsEdit(field) {
  const n = numberFrom(field);
  if (n === null) return updateProperties();
  const b = ed.selectionBounds();
  if (!b) return;
  let change;
  if (field === "propX") change = { cx: n };
  else if (field === "propY") change = { cy: n };
  else if (field === "propW")
    change = $("aspectLock").checked ? { w: n, h: (n * b.h) / b.w } : { w: n };
  else change = $("aspectLock").checked ? { h: n, w: (n * b.w) / b.h } : { h: n };
  report(ed.setBounds(change), "Transformasi diterapkan.", { quiet: true });
}
for (const id of ["propX", "propY", "propW", "propH"])
  $(id).addEventListener("change", () => boundsEdit(id));
const rotateBy = (deg) => report(ed.rotate(deg, aspect()), `Diputar ${deg}°.`, { quiet: true });
$("rotateCcwBtn").addEventListener("click", () => rotateBy(Number($("rotateInput").value) || 0));
$("rotateCwBtn").addEventListener("click", () => rotateBy(-(Number($("rotateInput").value) || 0)));
for (const chip of document.querySelectorAll("[data-rotate]"))
  chip.addEventListener("click", () => rotateBy(Number(chip.dataset.rotate)));
$("scaleApplyBtn").addEventListener("click", () => {
  const pct = Number($("scaleInput").value);
  if (!(pct > 0)) return setStatus("Skala harus lebih dari 0%.", "error");
  report(ed.scale(pct / 100, pct / 100), `Diskalakan ${pct}%.`, { quiet: true });
});
$("flipHBtn").addEventListener("click", () => report(ed.flip("x"), "Flip horizontal.", { quiet: true }));
$("flipVBtn").addEventListener("click", () => report(ed.flip("y"), "Flip vertikal.", { quiet: true }));
for (const btn of document.querySelectorAll("[data-align]"))
  btn.addEventListener("click", () => report(ed.align(btn.dataset.align), "Objek disejajarkan.", { quiet: true }));
$("distHBtn").addEventListener("click", () => report(ed.distribute("x"), "Distribusi horizontal.", { quiet: true }));
$("distVBtn").addEventListener("click", () => report(ed.distribute("y"), "Distribusi vertikal.", { quiet: true }));
$("vertexX").addEventListener("change", (e) => vertexEdit("x", e.target.value));
$("vertexY").addEventListener("change", (e) => vertexEdit("y", e.target.value));
function vertexEdit(key, value) {
  const res = ed.editVertex(ed.selectedVertex, key, Number(value));
  if (!res.ok) res.error = `Koordinat ditolak: ${res.error}`;
  report(res, "Koordinat berhasil diperbarui.", { quiet: true });
}
$("layerDownBtn").addEventListener("click", () => report(ed.layerMove(-1), "Dikirim ke belakang.", { quiet: true }));
$("layerUpBtn").addEventListener("click", () => report(ed.layerMove(1), "Dibawa ke depan.", { quiet: true }));
$("groupBtn").addEventListener("click", () =>
  ed.selected().some((s) => s.groupId != null) ? actions.ungroup() : actions.group(),
);
$("deleteBtn").addEventListener("click", actions.deleteSelection);
$("duplicateBtn").addEventListener("click", actions.duplicate);
$("contextToolbar").addEventListener("click", (e) => {
  const act = e.target.closest("[data-act]")?.dataset.act;
  if (!act) return;
  if (act === "rotateCcw") rotateBy(90);
  else if (act === "rotateCw") rotateBy(-90);
  else if (act === "flipH") report(ed.flip("x"), "Flip horizontal.", { quiet: true });
  else if (act === "flipV") report(ed.flip("y"), "Flip vertikal.", { quiet: true });
  else if (act === "duplicate") actions.duplicate();
  else if (act === "delete") actions.deleteSelection();
});

// Output
$("resetBtn").addEventListener("click", () => {
  ed.replaceAll(loadExample());
  draft = [];
  setMode("select");
  setStatus("Contoh rumah telah dikembalikan. Ctrl+Z untuk membatalkan.");
});
$("copyBtn").addEventListener("click", async () => {
  const value = $("codeOutput").value;
  try {
    if (navigator.clipboard && window.isSecureContext)
      await navigator.clipboard.writeText(value);
    else throw new Error("Clipboard API tidak tersedia");
    setStatus("Kode C++ berhasil disalin.");
  } catch {
    $("codeOutput").focus();
    $("codeOutput").select();
    const ok = document.execCommand("copy");
    setStatus(
      ok ? "Kode C++ berhasil disalin." : "Gunakan Ctrl+C untuk menyalin kode.",
    );
  }
});
$("cppDownloadBtn").addEventListener("click", () => {
  try {
    download("mesh_data.h", G.exportHeader(G.buildMesh(ed.shapes)), "text/plain");
  } catch (err) {
    setStatus(err.message, "error");
  }
});
function saveProject() {
  download("meshsketch.json", G.serializeProject(ed.shapes, dims), "application/json");
  setStatus("Project disimpan sebagai meshsketch.json.");
}
$("jsonDownloadBtn").addEventListener("click", saveProject);
$("deleteVertexBtn").addEventListener("click", actions.deleteVertex);
$("snippetToggle").addEventListener("change", (e) => {
  store.set("snippet", e.target.checked);
  updateExport();
});
$("transformDetails").addEventListener("toggle", (e) => store.set("transformOpen", e.target.open));
$("jsonImportBtn").addEventListener("click", () => $("jsonInput").click());
$("jsonInput").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    if (file.size > 2 * 1024 * 1024)
      throw new Error("JSON terlalu besar (maksimum 2 MB).");
    const data = JSON.parse(await file.text());
    const imported = G.validateImport(data);
    ed.replaceAll(imported);
    draft = [];
    setMode("select");
    if (
      data.viewport &&
      Number.isInteger(data.viewport.w) &&
      Number.isInteger(data.viewport.h)
    ) {
      const option = `${data.viewport.w}x${data.viewport.h}`;
      if ([...$("viewportSelect").options].some((o) => o.value === option)) {
        $("viewportSelect").value = option;
        applyViewport(option);
      }
    }
    setStatus("Project JSON berhasil dibuka.");
  } catch (err) {
    setStatus(`Gagal membuka JSON: ${err.message}`, "error");
  }
  e.target.value = "";
});
$("pngDownloadBtn").addEventListener("click", () => {
  // Export clean artwork at the selected framebuffer resolution, without grid/handles.
  // Uses the fixed NDC → framebuffer mapping, so zoom/pan never affect the PNG.
  const output = document.createElement("canvas");
  output.width = dims.w;
  output.height = dims.h;
  const out = output.getContext("2d");
  out.fillStyle =
    document.documentElement.dataset.theme === "dark" ? "#111114" : "#ffffff";
  out.fillRect(0, 0, dims.w, dims.h);
  ed.shapes.forEach((shape) => {
    if (shape.hidden) return;
    out.beginPath();
    shape.points.forEach((p, i) => {
      const x = ((p.x + 1) * dims.w) / 2;
      const y = ((1 - p.y) * dims.h) / 2;
      if (i === 0) out.moveTo(x, y);
      else out.lineTo(x, y);
    });
    out.closePath();
    out.fillStyle = shape.color;
    out.fill();
  });
  output.toBlob((blob) => {
    if (!blob) {
      setStatus("Tidak bisa mengekspor PNG.", "error");
      return;
    }
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `meshsketch-${dims.w}x${dims.h}.png`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }, "image/png");
});

// ---------------------------------------------------------------- shortcuts dialog
(function buildShortcutList() {
  const dl = $("shortcutList");
  for (const [keys, label] of K.LIST) {
    const dt = document.createElement("dt");
    for (const [i, part] of keys.split(" · ").entries()) {
      if (i) dt.append(" · ");
      const kbd = document.createElement("kbd");
      kbd.textContent = part;
      dt.append(kbd);
    }
    const dd = document.createElement("dd");
    dd.textContent = label;
    dl.append(dt, dd);
  }
})();

// ---------------------------------------------------------------- first-launch guide
const tour = (() => {
  const steps = [
    {
      title: "Selamat datang di MeshSketch",
      body: "<p>Gambar polygon 2D dan dapatkan data <b>vertices</b> &amp; <b>indices</b> siap pakai untuk OpenGL.</p><p>Koordinat memakai NDC: X dan Y dari −1 sampai +1.</p>",
    },
    {
      title: "Buat polygon",
      target: "polygonModeBtn",
      body: "<ul><li>Pilih <b>Polygon</b> atau tekan <kbd>P</kbd>.</li><li>Klik canvas untuk menambah titik.</li><li><kbd>Enter</kbd> atau klik titik pertama untuk selesai, <kbd>Backspace</kbd> hapus titik terakhir, <kbd>Esc</kbd> batal.</li></ul>",
    },
    {
      title: "Edit geometri",
      target: "canvasFrame",
      body: "<ul><li>Klik polygon untuk memilih (<kbd>V</kbd> = Select).</li><li>Tarik titik (vertex) untuk mengubah bentuk.</li><li>Klik ganda di sisi untuk menambah titik; pilih titik lalu <kbd>Delete</kbd> untuk menghapusnya.</li><li>Koordinat tepat bisa diketik di panel Properties.</li></ul>",
    },
    {
      title: "Pilih & transformasi",
      target: "contextToolbar",
      body: "<ul><li>Tarik objek untuk memindah; panah untuk geser halus.</li><li>Handle kotak = resize (<kbd>Shift</kbd> kunci rasio), handle bulat = rotasi (<kbd>Shift</kbd> snap 15°).</li><li><kbd>Shift</kbd>+klik atau drag kotak untuk multi-seleksi.</li></ul>",
    },
    {
      title: "Zoom & pan",
      target: "zoomWidget",
      body: "<ul><li>Scroll untuk zoom di posisi kursor.</li><li><kbd>Space</kbd>+drag atau klik tengah untuk pan.</li><li>Tombol −/+ dan menu persentase; <kbd>Ctrl 0</kbd> reset, <kbd>Shift 1</kbd> fit.</li></ul><p>Zoom hanya tampilan, tidak mengubah koordinat atau ekspor.</p>",
    },
    {
      title: "Pintasan keyboard",
      body: "<ul><li><kbd>Ctrl C</kbd> / <kbd>X</kbd> / <kbd>V</kbd> copy, cut, paste</li><li><kbd>Ctrl D</kbd> duplikat · <kbd>Ctrl A</kbd> pilih semua</li><li><kbd>Delete</kbd> hapus · <kbd>Ctrl Z</kbd> undo · <kbd>Ctrl Shift Z</kbd> redo</li></ul><p>Daftar lengkap: tombol <b>?</b> di toolbar, atau tekan <kbd>?</kbd>.</p>",
    },
    {
      title: "Ekspor data OpenGL",
      target: "exportPanel",
      body: "<p>Panel Output berisi array <code>vertices</code> (8 float: XYZ + RGB + UV) dan <code>indices</code> (segitiga CCW).</p><p>Aktifkan <b>kode setup OpenGL</b> untuk contoh VAO/VBO/EBO dan rentang draw per objek. Project tersimpan otomatis; <kbd>Ctrl S</kbd> menyimpan file JSON.</p>",
    },
  ];
  let index = 0;
  let highlighted = null;
  let openedPanel = false; // restore a collapsed output panel when the guide ends
  const el = $("tour");
  function show() {
    const step = steps[index];
    highlighted?.classList.remove("tour-highlight");
    highlighted = null;
    if (step.target === "exportPanel" && shell.classList.contains("right-collapsed")) {
      setPanel("right", true, false);
      openedPanel = true;
    } else if (step.target !== "exportPanel" && openedPanel) {
      setPanel("right", false, false);
      openedPanel = false;
    }
    $("tourTitle").textContent = step.title;
    $("tourBody").innerHTML = step.body;
    $("tourProgress").replaceChildren(
      ...steps.map((_, i) => {
        const s = document.createElement("span");
        if (i <= index) s.className = "done";
        return s;
      }),
    );
    $("tourBack").disabled = index === 0;
    $("tourNext").textContent = index === steps.length - 1 ? "Selesai" : "Lanjut";
    $("tourSkip").classList.toggle("hidden", index === steps.length - 1);
    el.classList.remove("hidden");
    position(step.target ? $(step.target) : null);
  }
  function position(target) {
    const card = el.getBoundingClientRect();
    const vw = window.innerWidth,
      vh = window.innerHeight;
    let left, top;
    if (target && target.getClientRects().length) {
      highlighted = target;
      target.classList.add("tour-highlight");
      const r = target.getBoundingClientRect();
      if (r.right + 14 + card.width <= vw) left = r.right + 14;
      else if (r.left - 14 - card.width >= 0) left = r.left - 14 - card.width;
      else left = (vw - card.width) / 2;
      top = r.top;
      if (r.width > vw / 3 && r.height > vh / 3) {
        // large target (canvas): sit inside its lower-left corner
        left = r.left + 16;
        top = r.bottom - card.height - 16;
      }
    } else {
      left = (vw - card.width) / 2;
      top = vh * 0.28;
    }
    el.style.left = `${clamp(left, 12, vw - card.width - 12)}px`;
    el.style.top = `${clamp(top, 12, vh - card.height - 12)}px`;
  }
  function end() {
    highlighted?.classList.remove("tour-highlight");
    highlighted = null;
    el.classList.add("hidden");
    if (openedPanel) setPanel("right", false, false);
    openedPanel = false;
    store.set("tourDone", true);
  }
  $("tourNext").addEventListener("click", () => {
    if (index === steps.length - 1) return end();
    index++;
    show();
  });
  $("tourBack").addEventListener("click", () => {
    index = Math.max(0, index - 1);
    show();
  });
  $("tourSkip").addEventListener("click", end);
  window.addEventListener("resize", () => !el.classList.contains("hidden") && show());
  return {
    start() {
      index = 0;
      show();
      $("tourNext").focus();
    },
    end,
    get open() {
      return !el.classList.contains("hidden");
    },
  };
})();

// ---------------------------------------------------------------- boot
setTheme(store.get("theme", "dark"));
const savedColor = store.get("color", null);
if (typeof savedColor === "string" && normalizeHex(savedColor)) currentColor = normalizeHex(savedColor);
buildPalette();
renderRecent();
setPanel("left", store.get("panel.left", true), false);
setPanel("right", store.get("panel.right", window.innerWidth > 1100), false);
// Shrinking below 1100px collapses the output panel to keep the canvas usable.
window.matchMedia("(max-width: 1100px)").addEventListener("change", (e) => {
  if (e.matches) setPanel("right", false, false);
});
$("snippetToggle").checked = store.get("snippet", false) === true;
$("transformDetails").open = store.get("transformOpen", true) !== false;
let restored = false;
try {
  const saved = store.get("autosave", null);
  if (typeof saved === "string") {
    const data = JSON.parse(saved);
    ed.replaceAll(G.validateImport(data));
    const option = data.viewport ? `${data.viewport.w}x${data.viewport.h}` : "";
    if ([...$("viewportSelect").options].some((o) => o.value === option))
      $("viewportSelect").value = option;
    lastAutosave = saved;
    restored = true;
  }
} catch {
  /* corrupt or outdated autosave - fall back to the example */
}
if (!restored) ed.replaceAll(loadExample());
ed.history = [];
applyViewport($("viewportSelect").value);
setMode("select");
if (restored) setStatus("Pekerjaan terakhir dipulihkan otomatis.");
new ResizeObserver(resizeCanvas).observe(frame);
if (!store.get("tourDone", false)) requestAnimationFrame(() => tour.start());
