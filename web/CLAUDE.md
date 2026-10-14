This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Overview

MeshSketch is a web-based OpenGL mesh editor that allows users to draw polygons in 2D space and export them as C++
OpenGL code. The application uses OpenGL's Normalized Device Coordinates (NDC) where x and y range from -1 to +1.
It runs from `file://` in a browser and inside Tauri 2 (`frontendDist: ../web`). No build step, no dependencies.

Architecture (classic `<script defer>` files, loaded in this order; each attaches one global)

1. geometry.js → `MeshGeometry` - pure: validPolygon, triangulate (ear clipping), checkPolygon,
   bounds/translate/rotate/scale helpers, buildMesh / exportCpp / exportHeader, JSON serialize/validateImport.
2. viewport.js → `MeshViewport` - pure view transform `{ scale, offsetX, offsetY }`:
   screen = base(ndc) * scale + offset, where base() is the original 100% mapping. zoomAt (cursor-anchored),
   stepScale, fit, resize. Display only - never touches the model.
3. editor.js → `MeshEditor.create()` - document model: shapes, selection (Set of ids + primaryId + selectedVertex),
   history/future snapshots (80 max, include selection), clipboard, and every mutation.
4. shortcuts.js → `MeshShortcuts` - pure `resolve(event, ctx)` → `{ action, args }` | null, plus the shortcut list.
5. app.js - DOM only: renderer, pointer controller (select/vertex/move/resize/rotate/marquee/pan), keyboard
   dispatch (`actions` map), panels, colour palette, onboarding tour, export buttons.

Invariants

- All geometry mutations go through `ed.commit()` (transactional: clones, mutates, re-validates every changed
  polygon with checkPolygon, then applies atomically with one history entry; no-ops create no entry).
- Pointer drags use `ed.beginGesture()` → `previewSelection()/previewVertex()` → `endGesture()`
  (one history entry per drag, full rollback if invalid) or `cancelGesture()` (Esc).
- Never store zoom/pan in history or exports. PNG export uses the fixed NDC → framebuffer mapping.
- Exported vertex layout is 8 floats: xyz + rgb + uv. Triangles are always CCW (triangulate reverses CW input).
  Flips keep vertex order. Hidden shapes are skipped by buildMesh.
- Shortcuts return null when focus is in a text field or page text is selected - don't preventDefault then.
- UI strings are Indonesian; keep new strings consistent.
- Autosave stores only the document (serializeProject) under localStorage "meshsketch.autosave"; it is skipped
  while a gesture/colour preview is active. Other prefs use the same "meshsketch.*" prefix via `store`.
- exportCpp(mesh, { snippet }) appends the optional GL setup after "// Drawing (after VAO/EBO setup):";
  exportHeader never includes it.

Testing

- `npm test` runs `node --test` on tests/*.test.js; tests/load.js evaluates the web scripts into Node globals.
  Covered: geometry/triangulation/transforms, viewport math, shortcut resolution, editor selection, clipboard,
  history, transactions, gestures, layers, groups, colour.
- `npm run check` syntax-checks all web scripts.
- UI behaviour (pointer, zoom, panels) is verified manually or with a headless browser against web/index.html.
