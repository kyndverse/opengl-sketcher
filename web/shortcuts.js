"use strict";

// Centralized keyboard map. resolve() is pure: it turns a keydown event plus editor
// context into { action, args } or null. The app owns the action implementations.
// Returning null means "let the browser/WebView handle it" - we never preventDefault then.
globalThis.MeshShortcuts = (() => {
  const ARROWS = {
    ArrowLeft: [-1, 0],
    ArrowRight: [1, 0],
    ArrowUp: [0, 1],
    ArrowDown: [0, -1],
  };

  // True when focus is somewhere native text editing must keep working.
  function isTypingTarget(el) {
    if (!el) return false;
    if (el.isContentEditable) return true;
    const tag = el.tagName;
    if (tag === "TEXTAREA" || tag === "SELECT") return true;
    if (tag !== "INPUT") return false;
    const type = (el.type || "text").toLowerCase();
    return !["checkbox", "radio", "button", "submit", "reset", "range", "color", "file"].includes(type);
  }

  /**
   * ctx: { typing, textSelected, mode: "select"|"polygon", draftLength, vertexSelected }
   */
  function resolve(e, ctx) {
    if (ctx.typing || e.isComposing) return null;
    const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    const mod = e.ctrlKey || e.metaKey;

    if (mod && !e.altKey) {
      switch (key) {
        case "z":
          return { action: e.shiftKey ? "redo" : "undo" };
        case "y":
          // Ctrl+Y only - Cmd+Y is the history view in macOS browsers.
          return e.ctrlKey && !e.shiftKey ? { action: "redo" } : null;
        case "c":
          return ctx.textSelected ? null : { action: "copy" };
        case "x":
          return ctx.textSelected ? null : { action: "cut" };
        case "v":
          return e.shiftKey ? null : { action: "paste" };
        case "a":
          return e.shiftKey ? null : { action: "selectAll" };
        case "d":
          return e.shiftKey ? null : { action: "duplicate" };
        case "g":
          return { action: e.shiftKey ? "ungroup" : "group" };
        case "=":
        case "+":
          return { action: "zoomIn" };
        case "-":
        case "_":
          return { action: "zoomOut" };
        case "0":
          return e.shiftKey ? null : { action: "zoomReset" };
        case "s":
          return e.shiftKey ? null : { action: "save" };
        case "o":
          return e.shiftKey ? null : { action: "open" };
      }
      if (e.code === "NumpadAdd") return { action: "zoomIn" };
      if (e.code === "NumpadSubtract") return { action: "zoomOut" };
      if (e.code === "Numpad0") return { action: "zoomReset" };
      return null; // never hijack other system/browser shortcuts
    }
    if (mod || e.altKey) return null;

    if (key === "Backspace" || key === "Delete") {
      // Context-aware: in polygon drawing mode, remove the last draft point first.
      if (ctx.mode === "polygon" && ctx.draftLength > 0)
        return { action: "removeDraftPoint" };
      // With a vertex sub-selected, delete that vertex rather than the whole object.
      if (ctx.vertexSelected) return { action: "deleteVertex" };
      return { action: "deleteSelection" };
    }
    if (key === "Escape") return { action: "escape" };
    if (key === "Enter") return ctx.mode === "polygon" ? { action: "finishPolygon" } : null;
    if (ARROWS[key]) {
      const [x, y] = ARROWS[key];
      return { action: "nudge", args: { x, y, large: e.shiftKey } };
    }
    if (e.shiftKey) {
      if (e.code === "Digit1") return { action: "fitView" };
      if (key === "?") return { action: "showShortcuts" };
      return null;
    }
    if (key === "v") return { action: "toolSelect" };
    if (key === "p") return { action: "toolPolygon" };
    return null;
  }

  // Shown in the shortcuts dialog and onboarding. Keep in sync with resolve().
  const LIST = [
    ["V", "Select tool"],
    ["P", "Polygon tool"],
    ["Enter · klik titik pertama", "Selesaikan polygon"],
    ["Esc", "Batal / hapus seleksi"],
    ["Klik ganda di sisi", "Tambah titik pada polygon"],
    ["Delete (titik terpilih)", "Hapus titik"],
    ["Ctrl/⌘ S · O", "Simpan · Buka project JSON"],
    ["Ctrl/⌘ Z", "Undo"],
    ["Ctrl/⌘ Shift Z · Ctrl Y", "Redo"],
    ["Ctrl/⌘ C · X · V", "Copy · Cut · Paste"],
    ["Ctrl/⌘ D", "Duplikat"],
    ["Ctrl/⌘ A", "Pilih semua"],
    ["Delete · Backspace", "Hapus seleksi / titik draft terakhir"],
    ["Shift + klik", "Tambah/kurangi seleksi"],
    ["Ctrl/⌘ G · Shift G", "Group · Ungroup"],
    ["← ↑ → ↓", "Geser 0.01 (Shift: 0.1)"],
    ["Ctrl/⌘ + · − · 0", "Zoom in · out · 100%"],
    ["Shift 1", "Fit to view"],
    ["Scroll", "Zoom di posisi kursor"],
    ["Space + drag · klik tengah", "Pan canvas"],
    ["Shift saat rotate/resize", "Snap 15° / kunci rasio"],
  ];

  return { resolve, isTypingTarget, LIST };
})();
