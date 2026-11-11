// Locates PS1 main RAM (2 MB) inside an emulator core's WebAssembly heap and
// reads from it. Works with any core: it searches the heap for byte slices of
// the game's boot executable (which the BIOS copies into RAM at a known address).
(function (root) {
  'use strict';

  const PSX_RAM_SIZE = 0x200000;
  const RETRO_MEMORY_SYSTEM_RAM = 2;

  function u32FromBytes(b, i) {
    return (b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24)) >>> 0;
  }

  function matchAt(heap8, pos, bytes) {
    if (pos < 0 || pos + bytes.length > heap8.length) return false;
    for (let i = 0; i < bytes.length; i++) if (heap8[pos + i] !== bytes[i]) return false;
    return true;
  }

  function verifyBase(heap8, base, probes) {
    if (base < 0 || base + PSX_RAM_SIZE > heap8.length) return 0;
    let hits = 0;
    for (const p of probes) if (matchAt(heap8, base + p.ramOffset, p.bytes)) hits++;
    return hits;
  }

  function needed(probes) {
    return Math.min(2, probes.length);
  }

  // Generator so the caller can spread the scan over several frames.
  function* scan(buffer, probes, sliceWords = 4 * 1024 * 1024) {
    if (!probes.length) return null;
    const heap8 = new Uint8Array(buffer);
    const heap32 = new Uint32Array(buffer, 0, Math.floor(buffer.byteLength / 4));
    const lead = probes[0];
    const w0 = u32FromBytes(lead.bytes, 0);
    const need = needed(probes);
    for (let start = 0; start < heap32.length; start += sliceWords) {
      const end = Math.min(heap32.length, start + sliceWords);
      for (let i = start; i < end; i++) {
        if (heap32[i] !== w0) continue;
        const pos = i * 4;
        if (!matchAt(heap8, pos, lead.bytes)) continue;
        const base = pos - lead.ramOffset;
        if (verifyBase(heap8, base, probes) >= need) return base;
      }
      yield start / heap32.length;
    }
    return null;
  }

  class RamLocator {
    constructor() {
      this.memory = null;
      this.base = null;
      this._job = null;
      this.probes = [];
      this.badReads = 0;
    }

    reset(probes) {
      this.memory = null;
      this.base = null;
      this._job = null;
      this.probes = probes || [];
      this.badReads = 0;
    }

    get ready() { return this.memory !== null && this.base !== null; }

    // Try the libretro memory API if the core exports it.
    _tryRetroApi(hook) {
      for (const ex of hook.exportsList || []) {
        const getData = ex.retro_get_memory_data || ex._retro_get_memory_data;
        const getSize = ex.retro_get_memory_size || ex._retro_get_memory_size;
        if (typeof getData !== 'function' || typeof getSize !== 'function') continue;
        try {
          const size = getSize(RETRO_MEMORY_SYSTEM_RAM);
          const ptr = getData(RETRO_MEMORY_SYSTEM_RAM);
          if (size < PSX_RAM_SIZE || !ptr) continue;
          for (const mem of hook.memories) {
            const heap8 = new Uint8Array(mem.buffer);
            if (ptr + PSX_RAM_SIZE > heap8.length) continue;
            if (!this.probes.length || verifyBase(heap8, ptr, this.probes) >= needed(this.probes)) {
              return { memory: mem, base: ptr };
            }
          }
        } catch (_) { /* ignore */ }
      }
      return null;
    }

    // Advance calibration a little. Returns 'ready' | 'searching' | 'waiting'.
    step(hook) {
      if (this.ready) return 'ready';
      if (!hook || !hook.memories || !hook.memories.length) return 'waiting';
      const api = this._tryRetroApi(hook);
      if (api) { this.memory = api.memory; this.base = api.base; return 'ready'; }
      if (!this.probes.length) return 'waiting';

      if (!this._job) {
        // Largest memory first: that's the core's heap.
        const mems = [...hook.memories].sort((a, b) => b.buffer.byteLength - a.buffer.byteLength);
        this._job = { mems, idx: 0, it: scan(mems[0].buffer, this.probes) };
      }
      const job = this._job;
      const r = job.it.next();
      if (r.done) {
        if (r.value !== null && r.value !== undefined) {
          this.memory = job.mems[job.idx];
          this.base = r.value;
          this._job = null;
          return 'ready';
        }
        job.idx++;
        if (job.idx >= job.mems.length) { this._job = null; return 'waiting'; }
        job.it = scan(job.mems[job.idx].buffer, this.probes);
      }
      return 'searching';
    }

    read(offset, length) {
      if (!this.ready) return null;
      const heap8 = new Uint8Array(this.memory.buffer); // fresh view: heap may have grown
      const start = this.base + offset;
      if (start + length > heap8.length) return null;
      return heap8.slice(start, start + length);
    }

    // Re-check probes now and then; if the core reallocated RAM, recalibrate.
    stillValid() {
      if (!this.ready) return false;
      const heap8 = new Uint8Array(this.memory.buffer);
      return verifyBase(heap8, this.base, this.probes) >= needed(this.probes);
    }

    invalidate() { this.memory = null; this.base = null; this._job = null; }
  }

  const api = { RamLocator, scan, verifyBase, PSX_RAM_SIZE };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.PsxMemory = api;
})(typeof window !== 'undefined' ? window : globalThis);
