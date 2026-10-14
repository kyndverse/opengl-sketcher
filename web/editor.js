"use strict";

// Editor document model: shapes, selection, history, clipboard and transforms.
// DOM-free so it is covered by the Node tests. Every geometry mutation goes through
// commit(), which validates all touched polygons and applies them atomically.
globalThis.MeshEditor = (() => {
  const G = globalThis.MeshGeometry;
  const HISTORY_LIMIT = 80;
  const PASTE_STEP = 0.05;
  const DUPLICATE_STEP = 0.1;

  function create() {
    const ed = {
      shapes: [],
      selection: new Set(),
      primaryId: null, // active object for vertex editing + properties
      selectedVertex: null,
      history: [],
      future: [],
      nextId: 1,
      nextGroupId: 1,
      clipboard: null,
      pasteCount: 0,
      lastCoalesce: null, // { key, time } - merges rapid nudges into one entry
    };

    // ---------- lookup ----------
    ed.byId = (id) => ed.shapes.find((s) => s.id === id);
    ed.primary = () => ed.byId(ed.primaryId);
    ed.selected = () => ed.shapes.filter((s) => ed.selection.has(s.id));
    ed.isSelected = (id) => ed.selection.has(id);
    ed.selectionBounds = () => {
      const sel = ed.selected();
      return sel.length ? G.shapesBounds(sel) : null;
    };
    ed.selectionLocked = () => ed.selected().some((s) => s.locked);

    // ---------- history ----------
    ed.snapshot = () => ({
      shapes: G.clone(ed.shapes),
      selection: [...ed.selection],
      primaryId: ed.primaryId,
    });
    ed.pushHistory = (snap) => {
      ed.history.push(snap);
      if (ed.history.length > HISTORY_LIMIT) ed.history.shift();
      ed.future = [];
    };
    ed.remember = () => {
      ed.lastCoalesce = null;
      ed.pushHistory(ed.snapshot());
    };
    ed.restore = (snap) => {
      ed.shapes = G.clone(snap.shapes);
      ed.nextId = Math.max(0, ...ed.shapes.map((s) => s.id)) + 1;
      ed.nextGroupId = Math.max(0, ...ed.shapes.map((s) => s.groupId ?? 0)) + 1;
      ed.setSelection(snap.selection, snap.primaryId);
    };
    ed.undo = () => {
      if (!ed.history.length) return false;
      ed.lastCoalesce = null;
      ed.future.push(ed.snapshot());
      ed.restore(ed.history.pop());
      return true;
    };
    ed.redo = () => {
      if (!ed.future.length) return false;
      ed.lastCoalesce = null;
      ed.history.push(ed.snapshot());
      ed.restore(ed.future.pop());
      return true;
    };

    // ---------- selection ----------
    // Drops ids that no longer exist; keeps a valid primary object.
    ed.setSelection = (ids, primaryId = null) => {
      const existing = new Set(ed.shapes.map((s) => s.id));
      ed.selection = new Set([...ids].filter((id) => existing.has(id)));
      ed.primaryId = ed.selection.has(primaryId)
        ? primaryId
        : ed.selection.size
          ? [...ed.selection].at(-1)
          : null;
      ed.selectedVertex = null;
    };
    ed.clearSelection = () => ed.setSelection([]);
    // Canvas picks expand to the whole group; layer-list picks can target one member.
    ed.groupMembers = (id) => {
      const s = ed.byId(id);
      if (!s || s.groupId == null) return [id];
      return ed.shapes.filter((o) => o.groupId === s.groupId).map((o) => o.id);
    };
    ed.selectOnly = (id, { group = true } = {}) =>
      ed.setSelection(group ? ed.groupMembers(id) : [id], id);
    ed.toggle = (id, { group = true } = {}) => {
      const ids = group ? ed.groupMembers(id) : [id];
      const next = new Set(ed.selection);
      const removing = ids.every((i) => next.has(i));
      ids.forEach((i) => (removing ? next.delete(i) : next.add(i)));
      ed.setSelection(next, removing ? ed.primaryId : id);
    };
    ed.selectAll = () =>
      ed.setSelection(
        ed.shapes.filter((s) => !s.hidden && !s.locked).map((s) => s.id),
        ed.primaryId,
      );
    ed.selectInRect = (rect, additive = false) => {
      const hits = ed.shapes
        .filter((s) => !s.hidden && !s.locked && G.rectContainsPoints(rect, s.points))
        .flatMap((s) => ed.groupMembers(s.id));
      ed.setSelection(additive ? [...ed.selection, ...hits] : hits, ed.primaryId);
      return hits.length;
    };

    // ---------- transactional commit ----------
    // mutate(draftShapes) edits a cloned shape array and may return an error string.
    // All changed polygons are re-validated; any failure leaves the document untouched.
    ed.commit = (mutate, { selection, primaryId, coalesceKey } = {}) => {
      const before = ed.shapes;
      const draft = G.clone(before);
      const error = mutate(draft);
      if (error) return { ok: false, error };
      if (draft.length > G.MAX_SHAPES)
        return { ok: false, error: `Maksimal ${G.MAX_SHAPES} polygon.` };
      const oldById = new Map(before.map((s) => [s.id, JSON.stringify(s.points)]));
      for (const s of draft) {
        if (oldById.get(s.id) === JSON.stringify(s.points)) continue;
        const err = G.checkPolygon(s.points);
        if (err) return { ok: false, error: `${s.name}: ${err}` };
      }
      if (JSON.stringify(draft) === JSON.stringify(before)) {
        if (selection) ed.setSelection(selection, primaryId);
        return { ok: true, noop: true };
      }
      const now = Date.now();
      const merge =
        coalesceKey &&
        ed.lastCoalesce &&
        ed.lastCoalesce.key === coalesceKey &&
        now - ed.lastCoalesce.time < 800 &&
        ed.history.length;
      if (merge) ed.future = [];
      else ed.pushHistory(ed.snapshot());
      ed.lastCoalesce = coalesceKey ? { key: coalesceKey, time: now } : null;
      const keepVertex = ed.selectedVertex;
      ed.shapes = draft;
      ed.nextId = Math.max(ed.nextId, ...draft.map((s) => s.id + 1));
      ed.setSelection(selection ?? ed.selection, primaryId ?? ed.primaryId);
      if (!selection) ed.selectedVertex = keepVertex;
      return { ok: true };
    };

    // Applies fn(points, shape) to every selected polygon in one transaction.
    ed.transformSelection = (fn, opts = {}) => {
      if (!ed.selection.size) return { ok: false, error: "Tidak ada objek terpilih." };
      if (ed.selectionLocked())
        return { ok: false, error: "Seleksi berisi objek terkunci." };
      return ed.commit((draft) => {
        for (const s of draft)
          if (ed.selection.has(s.id)) s.points = fn(s.points, s);
      }, opts);
    };

    // ---------- pointer gestures: live preview, one history entry on success ----------
    ed.gesture = null;
    ed.beginGesture = () => {
      ed.gesture = { snap: ed.snapshot(), base: new Map(ed.shapes.map((s) => [s.id, G.clone(s.points)])) };
    };
    ed.gestureBase = (id) => ed.gesture?.base.get(id);
    const inBounds = (pts) => pts.every((p) => Math.abs(p.x) <= 1 && Math.abs(p.y) <= 1);
    // fn(originalPoints, shape) → new points for each selected shape. Out-of-NDC previews
    // are skipped so the user keeps seeing the last valid state.
    ed.previewSelection = (fn) => {
      if (!ed.gesture) return false;
      const next = new Map();
      for (const s of ed.selected()) {
        const pts = fn(ed.gesture.base.get(s.id), s);
        if (!pts || !inBounds(pts) || pts.some((p) => !Number.isFinite(p.x) || !Number.isFinite(p.y)))
          return false;
        next.set(s.id, pts);
      }
      for (const s of ed.shapes) if (next.has(s.id)) s.points = next.get(s.id);
      return true;
    };
    ed.previewVertex = (id, index, p) => {
      const s = ed.byId(id);
      if (!ed.gesture || !s) return false;
      s.points[index] = { x: G.round(G.clamp(p.x, -1, 1)), y: G.round(G.clamp(p.y, -1, 1)) };
      return true;
    };
    ed.endGesture = () => {
      const g = ed.gesture;
      ed.gesture = null;
      if (!g) return { ok: true, noop: true };
      let changed = false;
      for (const s of ed.shapes) {
        if (JSON.stringify(s.points) === JSON.stringify(g.base.get(s.id))) continue;
        changed = true;
        const err = G.checkPolygon(s.points);
        if (err) {
          const vertex = ed.selectedVertex;
          ed.restore(g.snap);
          ed.selectedVertex = vertex;
          return { ok: false, error: err };
        }
      }
      if (!changed) return { ok: true, noop: true };
      ed.lastCoalesce = null;
      ed.pushHistory(g.snap);
      return { ok: true };
    };
    ed.cancelGesture = () => {
      const g = ed.gesture;
      ed.gesture = null;
      if (!g) return;
      const vertex = ed.selectedVertex;
      for (const s of ed.shapes) if (g.base.has(s.id)) s.points = g.base.get(s.id);
      ed.selectedVertex = vertex;
    };

    // ---------- creation / deletion ----------
    ed.addShape = (points, color, name) => {
      const id = ed.nextId;
      const res = ed.commit(
        (draft) => {
          const err = G.checkPolygon(points);
          if (err) return err;
          draft.push({ id, name: name ?? `Polygon ${id}`, color, points: G.clone(points) });
        },
        { selection: [id], primaryId: id },
      );
      return { ...res, id };
    };
    ed.deleteSelection = () => {
      if (!ed.selection.size) return { ok: false, error: "Tidak ada objek terpilih." };
      if (ed.selectionLocked())
        return { ok: false, error: "Objek terkunci tidak dapat dihapus." };
      const count = ed.selection.size;
      const res = ed.commit(
        (draft) => {
          for (let i = draft.length - 1; i >= 0; i--)
            if (ed.selection.has(draft[i].id)) draft.splice(i, 1);
        },
        { selection: [] },
      );
      return { ...res, count };
    };
    ed.replaceAll = (shapes) => {
      ed.remember();
      ed.shapes = G.clone(shapes);
      ed.nextId = Math.max(0, ...ed.shapes.map((s) => s.id)) + 1;
      ed.nextGroupId = Math.max(0, ...ed.shapes.map((s) => s.groupId ?? 0)) + 1;
      ed.clearSelection();
    };

    // ---------- clipboard ----------
    ed.copy = () => {
      const sel = ed.selected();
      if (!sel.length) return { ok: false, error: "Tidak ada objek untuk disalin." };
      ed.clipboard = G.clone(sel); // z-order preserved
      ed.pasteCount = 0;
      return { ok: true, count: sel.length };
    };
    ed.cut = () => {
      if (ed.selectionLocked())
        return { ok: false, error: "Objek terkunci tidak dapat dipotong." };
      const copied = ed.copy();
      if (!copied.ok) return copied;
      const res = ed.deleteSelection();
      // Cut items reappear in place on the first paste.
      ed.pasteCount = -1;
      return { ...res, count: copied.count };
    };

    // Inserts clones with fresh ids/groups, rigidly offset (clamped to NDC, never distorted).
    function insertCopies(source, step, nameSuffix) {
      if (ed.shapes.length + source.length > G.MAX_SHAPES)
        return { ok: false, error: `Maksimal ${G.MAX_SHAPES} polygon.` };
      const b = G.shapesBounds(source);
      const { dx, dy } = G.clampDelta(b, step, -step);
      const groupMap = new Map();
      let id = ed.nextId;
      const created = source.map((s) => {
        const copy = G.clone(s);
        copy.id = id++;
        if (nameSuffix) copy.name = `${s.name}${nameSuffix}`.slice(0, 60);
        delete copy.hidden;
        delete copy.locked;
        if (s.groupId != null) {
          if (!groupMap.has(s.groupId)) groupMap.set(s.groupId, ed.nextGroupId++);
          copy.groupId = groupMap.get(s.groupId);
        }
        copy.points = G.translatePoints(s.points, dx, dy);
        return copy;
      });
      const ids = created.map((s) => s.id);
      const res = ed.commit(
        (draft) => {
          for (const s of created) {
            const err = G.checkPolygon(s.points);
            if (err) return `${s.name}: ${err}`;
            draft.push(s);
          }
        },
        { selection: ids, primaryId: ids.at(-1) },
      );
      return { ...res, count: created.length, offset: { dx, dy } };
    }
    ed.paste = () => {
      if (!ed.clipboard?.length) return { ok: false, error: "Clipboard kosong." };
      ed.pasteCount++;
      const res = insertCopies(ed.clipboard, PASTE_STEP * ed.pasteCount, ed.pasteCount > 0 ? " salinan" : "");
      if (!res.ok) ed.pasteCount--;
      return res;
    };
    ed.duplicate = () => {
      const sel = ed.selected();
      if (!sel.length) return { ok: false, error: "Tidak ada objek terpilih." };
      return insertCopies(sel, DUPLICATE_STEP, " salinan");
    };

    // ---------- transforms (selection-wide, pivot = selection bounding-box center) ----------
    ed.nudge = (dx, dy) => {
      const b = ed.selectionBounds();
      if (!b) return { ok: false, error: "Tidak ada objek terpilih." };
      const d = G.clampDelta(b, dx, dy);
      if (Math.abs(d.dx) < G.EPS && Math.abs(d.dy) < G.EPS)
        return { ok: false, error: "Objek sudah berada di batas canvas." };
      return ed.transformSelection((pts) => G.translatePoints(pts, d.dx, d.dy), {
        coalesceKey: `nudge:${[...ed.selection].join(",")}`,
      });
    };
    ed.nudgeVertex = (dx, dy) => {
      const s = ed.primary();
      const i = ed.selectedVertex;
      if (!s || !Number.isInteger(i)) return { ok: false, error: "Tidak ada titik terpilih." };
      if (s.locked) return { ok: false, error: "Objek terkunci." };
      return ed.commit(
        (draft) => {
          const t = draft.find((o) => o.id === s.id);
          const p = t.points[i];
          t.points[i] = {
            x: G.round(G.clamp(p.x + dx, -1, 1)),
            y: G.round(G.clamp(p.y + dy, -1, 1)),
          };
        },
        { coalesceKey: `vertex:${s.id}:${i}` },
      );
    };
    // Positive degrees = counter-clockwise (math convention). aspect: see rotatePoints().
    ed.rotate = (degrees, aspect = 1) => {
      const b = ed.selectionBounds();
      if (!b) return { ok: false, error: "Tidak ada objek terpilih." };
      if (!Number.isFinite(degrees)) return { ok: false, error: "Sudut tidak valid." };
      const rad = (degrees * Math.PI) / 180;
      return ed.transformSelection((pts) =>
        G.rotatePoints(pts, rad, { x: b.cx, y: b.cy }, aspect),
      );
    };
    ed.scale = (sx, sy, anchor) => {
      const b = ed.selectionBounds();
      if (!b) return { ok: false, error: "Tidak ada objek terpilih." };
      if (!Number.isFinite(sx) || !Number.isFinite(sy) || Math.abs(sx) < 1e-3 || Math.abs(sy) < 1e-3)
        return { ok: false, error: "Skala tidak valid." };
      const a = anchor ?? { x: b.cx, y: b.cy };
      return ed.transformSelection((pts) => G.scalePoints(pts, sx, sy, a));
    };
    // Flip mirrors positions but keeps vertex order; triangulate() re-normalizes winding.
    ed.flip = (axis) => (axis === "x" ? ed.scale(-1, 1) : ed.scale(1, -1));
    // Sets the selection's bounding box (center + size) - used by the properties panel.
    ed.setBounds = ({ cx, cy, w, h }) => {
      const b = ed.selectionBounds();
      if (!b) return { ok: false, error: "Tidak ada objek terpilih." };
      const tw = w ?? b.w,
        th = h ?? b.h;
      if (!(tw > 1e-3) || !(th > 1e-3) || tw > 2 || th > 2)
        return { ok: false, error: "Ukuran harus antara 0.001 dan 2." };
      const sx = tw / b.w,
        sy = th / b.h;
      const tx = (cx ?? b.cx) - b.cx,
        ty = (cy ?? b.cy) - b.cy;
      return ed.transformSelection((pts) =>
        G.translatePoints(G.scalePoints(pts, sx, sy, { x: b.cx, y: b.cy }), tx, ty),
      );
    };
    ed.align = (kind) => {
      const sel = ed.selected();
      if (sel.length < 2) return { ok: false, error: "Pilih minimal 2 objek." };
      const all = G.shapesBounds(sel);
      // Group members move together as one unit.
      const units = unitsOf(sel);
      const moves = new Map();
      for (const unit of units) {
        const b = G.shapesBounds(unit);
        let dx = 0,
          dy = 0;
        if (kind === "left") dx = all.minX - b.minX;
        else if (kind === "hcenter") dx = all.cx - b.cx;
        else if (kind === "right") dx = all.maxX - b.maxX;
        else if (kind === "top") dy = all.maxY - b.maxY;
        else if (kind === "vcenter") dy = all.cy - b.cy;
        else if (kind === "bottom") dy = all.minY - b.minY;
        for (const s of unit) moves.set(s.id, { dx, dy });
      }
      return applyMoves(moves);
    };
    ed.distribute = (axis) => {
      const units = unitsOf(ed.selected());
      if (units.length < 3) return { ok: false, error: "Pilih minimal 3 objek." };
      const items = units
        .map((unit) => ({ unit, b: G.shapesBounds(unit) }))
        .sort((a, b) => (axis === "x" ? a.b.minX - b.b.minX : a.b.minY - b.b.minY));
      const size = (b) => (axis === "x" ? b.w : b.h);
      const lo = axis === "x" ? items[0].b.minX : items[0].b.minY;
      const last = items.at(-1).b;
      const hi = axis === "x" ? last.maxX : last.maxY;
      const gap = (hi - lo - items.reduce((sum, it) => sum + size(it.b), 0)) / (items.length - 1);
      const moves = new Map();
      let cursor = lo;
      for (const it of items) {
        const start = axis === "x" ? it.b.minX : it.b.minY;
        const d = cursor - start;
        for (const s of it.unit) moves.set(s.id, axis === "x" ? { dx: d, dy: 0 } : { dx: 0, dy: d });
        cursor += size(it.b) + gap;
      }
      return applyMoves(moves);
    };
    function unitsOf(shapes) {
      const groups = new Map();
      const units = [];
      for (const s of shapes) {
        if (s.groupId == null) units.push([s]);
        else {
          if (!groups.has(s.groupId)) {
            groups.set(s.groupId, []);
            units.push(groups.get(s.groupId));
          }
          groups.get(s.groupId).push(s);
        }
      }
      return units;
    }
    function applyMoves(moves) {
      if (ed.selectionLocked()) return { ok: false, error: "Seleksi berisi objek terkunci." };
      return ed.commit((draft) => {
        for (const s of draft) {
          const m = moves.get(s.id);
          if (m && (m.dx || m.dy)) s.points = G.translatePoints(s.points, m.dx, m.dy);
        }
      });
    }

    // ---------- properties ----------
    ed.setColor = (color) => {
      if (!/^#[0-9a-f]{6}$/i.test(color)) return { ok: false, error: "Warna tidak valid." };
      if (!ed.selection.size) return { ok: false, error: "Tidak ada objek terpilih." };
      return ed.commit((draft) => {
        for (const s of draft) if (ed.selection.has(s.id)) s.color = color.toLowerCase();
      });
    };
    ed.rename = (id, name) =>
      ed.commit((draft) => {
        const s = draft.find((o) => o.id === id);
        if (s) s.name = name.slice(0, 60);
      });
    ed.setFlag = (id, flag, value) =>
      ed.commit((draft) => {
        const s = draft.find((o) => o.id === id);
        if (!s) return;
        if (value) s[flag] = true;
        else delete s[flag];
      });
    ed.editVertex = (index, key, value) => {
      const s = ed.primary();
      if (!s || !Number.isInteger(index)) return { ok: false, error: "Tidak ada titik terpilih." };
      if (!Number.isFinite(value) || value < -1 || value > 1)
        return { ok: false, error: "Koordinat harus dari −1 sampai +1." };
      return ed.commit((draft) => {
        draft.find((o) => o.id === s.id).points[index][key] = G.round(value);
      });
    };

    // Inserts a point after vertex `after` (i.e. on edge after → after+1) and selects it.
    ed.insertVertex = (id, after, point) => {
      const s = ed.byId(id);
      if (!s) return { ok: false, error: "Objek tidak ditemukan." };
      if (s.locked) return { ok: false, error: "Objek terkunci." };
      if (s.points.length >= G.MAX_POINTS)
        return { ok: false, error: `Maksimal ${G.MAX_POINTS} titik per polygon.` };
      const keep = ed.selection.has(id) ? [...ed.selection] : [id];
      const res = ed.commit(
        (draft) => {
          draft.find((o) => o.id === id).points.splice(after + 1, 0, {
            x: G.round(point.x),
            y: G.round(point.y),
          });
        },
        { selection: keep, primaryId: id },
      );
      if (res.ok) ed.selectedVertex = after + 1;
      return res;
    };
    ed.deleteVertex = () => {
      const s = ed.primary();
      const i = ed.selectedVertex;
      if (!s || !Number.isInteger(i)) return { ok: false, error: "Tidak ada titik terpilih." };
      if (s.locked) return { ok: false, error: "Objek terkunci." };
      if (s.points.length <= 3)
        return { ok: false, error: "Polygon minimal 3 titik. Tekan Esc lalu Delete untuk menghapus objek." };
      const res = ed.commit((draft) => {
        draft.find((o) => o.id === s.id).points.splice(i, 1);
      });
      if (res.ok) ed.selectedVertex = null;
      return res;
    };

    // ---------- layers ----------
    // Moves every selected shape one step, preserving their relative order.
    ed.layerMove = (direction) => {
      if (!ed.selection.size) return { ok: false, error: "Tidak ada objek terpilih." };
      return ed.commit((draft) => {
        const sel = (i) => ed.selection.has(draft[i].id);
        if (direction > 0) {
          for (let i = draft.length - 2; i >= 0; i--)
            if (sel(i) && !sel(i + 1)) [draft[i], draft[i + 1]] = [draft[i + 1], draft[i]];
        } else {
          for (let i = 1; i < draft.length; i++)
            if (sel(i) && !sel(i - 1)) [draft[i], draft[i - 1]] = [draft[i - 1], draft[i]];
        }
      });
    };

    // ---------- groups ----------
    ed.group = () => {
      if (ed.selection.size < 2) return { ok: false, error: "Pilih minimal 2 objek untuk group." };
      const gid = ed.nextGroupId;
      const res = ed.commit((draft) => {
        for (const s of draft) if (ed.selection.has(s.id)) s.groupId = gid;
      });
      if (res.ok && !res.noop) ed.nextGroupId++;
      return res;
    };
    ed.ungroup = () => {
      if (!ed.selected().some((s) => s.groupId != null))
        return { ok: false, error: "Seleksi tidak berisi group." };
      return ed.commit((draft) => {
        for (const s of draft) if (ed.selection.has(s.id)) delete s.groupId;
      });
    };

    return ed;
  }

  return { create, HISTORY_LIMIT, PASTE_STEP, DUPLICATE_STEP };
})();
