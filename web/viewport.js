"use strict";

// Display-only view transform. The model stays in NDC; the view maps NDC to CSS pixels:
//   base(p)  = ((p.x + 1) * w / 2, (1 - p.y) * h / 2)      - the original 100% mapping
//   screen   = base(p) * scale + (offsetX, offsetY)
// Nothing here ever touches polygon coordinates, history or exports.
globalThis.MeshViewport = (() => {
  const MIN_SCALE = 0.25;
  const MAX_SCALE = 8;
  const ZOOM_STEPS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4, 6, 8];

  const clampScale = (s) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, s));
  const create = () => ({ scale: 1, offsetX: 0, offsetY: 0 });
  const reset = (view) => Object.assign(view, create());

  function worldToScreen(view, size, p) {
    return {
      x: ((p.x + 1) * size.w * 0.5) * view.scale + view.offsetX,
      y: ((1 - p.y) * size.h * 0.5) * view.scale + view.offsetY,
    };
  }
  function screenToWorld(view, size, s) {
    const bx = (s.x - view.offsetX) / view.scale;
    const by = (s.y - view.offsetY) / view.scale;
    return { x: (bx / size.w) * 2 - 1, y: 1 - (by / size.h) * 2 };
  }

  // Keeps the world point under `anchor` (screen px) fixed while changing scale.
  function zoomAt(view, newScale, anchor) {
    const next = clampScale(newScale);
    const ratio = next / view.scale;
    view.offsetX = anchor.x - (anchor.x - view.offsetX) * ratio;
    view.offsetY = anchor.y - (anchor.y - view.offsetY) * ratio;
    view.scale = next;
    return view;
  }

  // Next preset strictly above/below the current scale (works from non-preset scales too).
  function stepScale(scale, direction) {
    if (direction > 0)
      return ZOOM_STEPS.find((s) => s > scale + 1e-6) ?? MAX_SCALE;
    return [...ZOOM_STEPS].reverse().find((s) => s < scale - 1e-6) ?? MIN_SCALE;
  }

  function pan(view, dx, dy) {
    view.offsetX += dx;
    view.offsetY += dy;
    return view;
  }

  // Frames an NDC bounding box with `padding` CSS px. Empty scene → reset.
  function fit(view, size, b, padding = 40) {
    if (!b || !Number.isFinite(b.minX)) return reset(view);
    const bw = Math.max((b.w * size.w) / 2, 1e-6);
    const bh = Math.max((b.h * size.h) / 2, 1e-6);
    const availW = Math.max(size.w - padding * 2, 1);
    const availH = Math.max(size.h - padding * 2, 1);
    view.scale = clampScale(Math.min(availW / bw, availH / bh));
    const center = { x: ((b.cx + 1) * size.w) / 2, y: ((1 - b.cy) * size.h) / 2 };
    view.offsetX = size.w / 2 - center.x * view.scale;
    view.offsetY = size.h / 2 - center.y * view.scale;
    return view;
  }

  // Canvas element resized: keep the same world region framed.
  function resize(view, oldSize, newSize) {
    if (oldSize.w > 0 && oldSize.h > 0) {
      view.offsetX *= newSize.w / oldSize.w;
      view.offsetY *= newSize.h / oldSize.h;
    }
    return view;
  }

  return {
    MIN_SCALE,
    MAX_SCALE,
    ZOOM_STEPS,
    clampScale,
    create,
    reset,
    worldToScreen,
    screenToWorld,
    zoomAt,
    stepScale,
    pan,
    fit,
    resize,
  };
})();
