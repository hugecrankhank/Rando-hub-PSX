// Live map-tracker logic + drawing. Reachability is a port of SotnRandoTools'
// Tracker.CheckReachability (MIT, (c) TalicZealot).
(function (root) {
  'use strict';

  // In-game map palette indices used by SotnRandoTools, shown as RGB here.
  const COLORS = {
    available: '#36d14a',   // green: reachable in logic
    allowed: '#c23cc8',     // purple: reachable, out of logic
    unavailable: '#9a9a9a', // grey: not reachable yet
    border: '#f2f2f2',
  };

  function computeColors(model, owned, visited) {
    const colors = model.locations.map((l) => l.color);
    const changed = new Uint8Array(colors.length);
    for (const lk of model.locks) {
      if (visited.has(lk.loc) || changed[lk.loc]) continue;
      colors[lk.loc] = 'unavailable';
      if (lk.needs.every((a) => owned.has(a))) { colors[lk.loc] = 'available'; changed[lk.loc] = 1; }
    }
    changed.fill(0);
    for (const lk of model.allowed) {
      if (visited.has(lk.loc) || changed[lk.loc] || colors[lk.loc] !== 'unavailable') continue;
      if (lk.needs.every((a) => owned.has(a))) colors[lk.loc] = 'allowed';
    }
    return colors;
  }

  // Which locations have been checked: any of their room bytes has a matching bit.
  function visitedFromRam(model, ramRead) {
    const visited = new Set();
    model.locations.forEach((l, i) => {
      for (const [addr, mask] of l.rooms) {
        const v = ramRead(addr);
        if (v !== null && (v & mask)) { visited.add(i); break; }
      }
    });
    return visited;
  }

  // Map-pixel rectangles for the current castle, as SotnRandoTools draws them.
  function markers(model, colors, visited, secondCastle) {
    const out = [];
    model.locations.forEach((l, i) => {
      if (visited.has(i) || l.second !== secondCastle || l.x <= 0 || l.y <= 0) return;
      let x = l.x, y = l.y;
      if (secondCastle) { x = 252 - x; y = 199 - y; }
      if (l.small) {
        if (secondCastle) { x += 2; y += 1; }
        out.push({ i, name: l.name, color: COLORS[colors[i]], x, y, w: 2, h: 2, small: true });
      } else {
        // Room box: 1px border around a 3x3 fill, matching MapApi.ColorMapRoom.
        out.push({ i, name: l.name, color: COLORS[colors[i]], x: x - (x & 1), y: y - 1, w: 5, h: 5, small: false });
      }
    });
    return out;
  }

  function drawMarkers(ctx, list, sx, sy, ox, oy) {
    for (const m of list) {
      const px = Math.round(ox + m.x * sx), py = Math.round(oy + m.y * sy);
      const w = Math.max(2, Math.round(m.w * sx)), h = Math.max(2, Math.round(m.h * sy));
      if (m.small) {
        ctx.fillStyle = m.color;
        ctx.fillRect(px, py, w, h);
      } else {
        ctx.fillStyle = COLORS.border;
        ctx.fillRect(px, py, w, h);
        const bx = Math.max(1, Math.round(sx)), by = Math.max(1, Math.round(sy));
        ctx.fillStyle = m.color;
        ctx.fillRect(px + bx, py + by, w - 2 * bx, h - 2 * by);
      }
    }
  }

  const api = { COLORS, computeColors, visitedFromRam, markers, drawMarkers };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SotnMap = api;
})(typeof window !== 'undefined' ? window : globalThis);
