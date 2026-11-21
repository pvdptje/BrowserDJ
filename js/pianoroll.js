/* BrowserDJ piano roll: a canvas editor for the selected synth pattern.
   Click to add, drag to move, drag the right edge to resize, right-click to delete,
   Ctrl+drag to box-select, wheel to scroll, Ctrl+wheel to zoom. Times are in beats. */
window.BDJ = window.BDJ || {};
BDJ.PianoRoll = (() => {
  'use strict';
  const E = HumEngine;
  const RULER = 24, KEYS = 54, VEL = 66, EDGE = 7;
  const BLACK = [1, 3, 6, 8, 10];
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  /* selected notes: the track colour mixed toward white */
  const lighten = (hex) => { const n = parseInt(hex.slice(1), 16); const m = (c) => Math.round(c + (255 - c) * 0.6); return 'rgb(' + m(n >> 16) + ',' + m((n >> 8) & 255) + ',' + m(n & 255) + ')'; };

  class PianoRoll {
    /* host: { project(), pattern(), length(), color(), begin(), end(before), changed(kind), preview(pitch), playhead(), cursor(), setCursor(b), trace() } */
    constructor(canvas, host) {
      this.c = canvas;
      this.g = canvas.getContext('2d');
      this.host = host;
      this.sel = new Set();
      this.clip = [];
      this.lastLen = 1;
      this.view = { x0: 0, ppb: 90, top: 76, rowH: 16 };
      this.drag = null;
      this.hover = null;
      this.col = {};
      this.readColors();
      this.bind();
      const ro = new ResizeObserver(() => this.draw());
      ro.observe(canvas.parentElement);
    }

    readColors() {
      const cs = getComputedStyle(document.documentElement);
      for (const k of ['roll', 'line', 'text', 'muted', 'note', 'note-ink', 'select', 'trace', 'panel', 'panel-2', 'rec', 'bg'])
        this.col[k] = cs.getPropertyValue('--' + k).trim();
    }

    get p() { return this.host.project(); }
    get notes() { return this.host.pattern().notes || []; }
    set notes(v) { this.host.pattern().notes = v; }

    /* ---------- geometry ---------- */
    size() {
      const r = this.c.parentElement.getBoundingClientRect();
      return { W: Math.max(200, Math.floor(r.width)), H: Math.max(200, Math.floor(this.c.clientHeight || 420)) };
    }
    x(b) { return KEYS + (b - this.view.x0) * this.view.ppb; }
    beatAt(px) { return this.view.x0 + (px - KEYS) / this.view.ppb; }
    y(pitch) { return RULER + (this.view.top - pitch) * this.view.rowH; }
    pitchAt(py) { return Math.ceil(this.view.top - (py - RULER) / this.view.rowH - 1e-9); }
    gridBottom() { return this.size().H - VEL; }
    step() { return BDJ.Project.snapBeats(this.p); }
    snap(b, free) {
      const s = this.step();
      return !s || free ? b : Math.round(b / s) * s;
    }
    snapFloor(b, free) {
      const s = this.step();
      return !s || free ? b : Math.floor(b / s + 1e-9) * s;
    }
    minLen() { return this.step() || 1 / 32; }

    clampView() {
      const { H } = this.size();
      const v = this.view;
      const rows = (H - VEL - RULER) / v.rowH;
      v.top = clamp(v.top, Math.min(127, rows - 1), 127);
      v.x0 = Math.max(0, v.x0);
    }

    /* Centre the view on the notes (or middle C) and fit the song width. */
    fit() {
      const { W, H } = this.size();
      const v = this.view;
      const L = this.host.length();
      v.ppb = clamp((W - KEYS - 16) / L, 14, 240);
      v.x0 = 0;
      const ns = this.notes;
      let lo = 60, hi = 72;
      if (ns.length) { lo = Math.min(...ns.map((n) => n.pitch)); hi = Math.max(...ns.map((n) => n.pitch)); }
      const rows = (H - VEL - RULER) / v.rowH;
      v.top = Math.round((lo + hi) / 2 + rows / 2);
      this.clampView();
      this.draw();
    }

    /* Scroll so the playhead stays visible while playing. */
    follow(beat) {
      const { W } = this.size();
      const v = this.view, span = (W - KEYS) / v.ppb;
      if (beat < v.x0 || beat > v.x0 + span * 0.92) { v.x0 = Math.max(0, beat - span * 0.05); }
    }

    /* ---------- hit testing ---------- */
    hit(px, py) {
      const ns = this.notes;
      const pitch = this.pitchAt(py);
      for (let i = ns.length - 1; i >= 0; i--) {
        const n = ns[i];
        if (n.pitch !== pitch) continue;
        const x0 = this.x(n.start), x1 = this.x(n.start + n.len);
        if (px >= x0 - 1 && px <= x1 + 2) {
          const edge = px >= x1 - Math.min(EDGE, (x1 - x0) / 3);
          return { note: n, edge };
        }
      }
      return null;
    }
    notesAtX(px) {
      const b = this.beatAt(px);
      return this.notes.filter((n) => b >= n.start && b <= n.start + n.len);
    }
    byId(id) { return this.notes.find((n) => n.id === id); }
    selected() { return this.notes.filter((n) => this.sel.has(n.id)); }
    pruneSel() { const ids = new Set(this.notes.map((n) => n.id)); for (const id of [...this.sel]) if (!ids.has(id)) this.sel.delete(id); }

    /* ---------- editing ---------- */
    addNote(start, pitch, len, vel = 100) {
      const p = this.p;
      const n = { id: p.nextId++, start: Math.max(0, start), len, pitch: clamp(pitch, 0, 127), vel };
      this.notes.push(n);
      return n;
    }
    sortNotes() { this.notes.sort((a, b) => a.start - b.start || a.pitch - b.pitch); }

    edit(fn, kind = 'notes') {
      const before = this.host.begin();
      fn();
      this.sortNotes();
      this.pruneSel();
      this.host.end(before);
      this.host.changed(kind);
      this.draw();
    }

    deleteSel() {
      if (!this.sel.size) return;
      this.edit(() => { this.notes = this.notes.filter((n) => !this.sel.has(n.id)); this.sel.clear(); });
    }
    selectAll() { this.sel = new Set(this.notes.map((n) => n.id)); this.draw(); }
    targets() { return this.sel.size ? this.selected() : this.notes; }

    transpose(semis) {
      const t = this.targets();
      if (!t.length) return;
      const lo = Math.min(...t.map((n) => n.pitch)), hi = Math.max(...t.map((n) => n.pitch));
      semis = clamp(semis, -lo, 127 - hi);
      if (!semis) return;
      this.edit(() => { for (const n of t) n.pitch += semis; });
      if (t.length === 1 || this.sel.size) this.host.preview(t[0].pitch);
    }
    nudge(dir) {
      const t = this.targets();
      if (!t.length) return;
      const s = this.step() || 0.25;
      const minStart = Math.min(...t.map((n) => n.start));
      const d = Math.max(-minStart, dir * s);
      if (!d) return;
      this.edit(() => { for (const n of t) n.start += d; });
    }
    quantize() {
      const s = this.step();
      if (!s) return false;
      const t = this.targets();
      this.edit(() => {
        for (const n of t) {
          const a = Math.round(n.start / s) * s, b = Math.max(a + s, Math.round((n.start + n.len) / s) * s);
          n.start = a; n.len = b - a;
        }
      });
      return true;
    }
    fitToKey() {
      const p = this.p, t = this.targets();
      this.edit(() => { for (const n of t) n.pitch = clamp(E.snapPitch(n.pitch, p.root, p.scale), 0, 127); });
    }
    /* ---------- writing helpers ---------- */
    /* the pitches a click places: one note, or a chord built in the song's key (chromatic counts as major) */
    chordFor(pitch) {
      const kind = this.host.chord ? this.host.chord() : 'single';
      const p = this.p;
      if (kind === 'power') return [pitch, pitch + 7, pitch + 12].filter((q) => q <= 127);
      if (kind === 'octave') return [pitch, pitch + 12].filter((q) => q <= 127);
      if (kind !== 'triad' && kind !== 'seventh') return [pitch];
      const scale = p.scale === 'chromatic' ? 'major' : p.scale;
      const steps = E.SCALES[scale].steps;
      const inKey = (q) => steps.includes((((q - p.root) % 12) + 12) % 12);
      const up = (q, n) => { let r = q; for (let i = 0; i < n; i++) { do { r++; } while (!inKey(r) && r < 140); } return r; };
      const root = E.snapPitch(pitch, p.root, scale);
      // stack every other scale step: root, third, fifth (and seventh)
      const out = [root, up(root, 2), up(root, 4)];
      if (kind === 'seventh') out.push(up(root, 6));
      return out.filter((q) => q >= 0 && q <= 127);
    }

    /* Notes that start together become an arpeggio across their length, one note per grid step. */
    arpeggiate(mode = 'up') {
      const t = this.targets();
      const groups = new Map();
      for (const n of t) {
        const k = Math.round(n.start * 1000);
        if (!groups.has(k)) groups.set(k, []);
        groups.get(k).push(n);
      }
      const chords = [...groups.values()].filter((g) => g.length > 1);
      if (!chords.length) return false;
      const step = this.step() || 0.25;
      this.edit(() => {
        const gone = new Set();
        this.sel.clear();
        for (const g of chords) {
          const up = g.map((n) => n.pitch).sort((a, b) => a - b);
          const seq = mode === 'down' ? up.slice().reverse() : mode === 'updown' ? up.concat(up.slice(1, -1).reverse()) : up;
          const s = g[0].start, len = Math.max(...g.map((n) => n.len)), vel = Math.max(...g.map((n) => n.vel));
          const count = Math.max(1, Math.round(len / step));
          for (const n of g) gone.add(n.id);
          for (let i = 0; i < count; i++) this.sel.add(this.addNote(s + i * step, seq[i % seq.length], step, i === 0 ? vel : Math.max(1, vel - 12)).id);
        }
        this.notes = this.notes.filter((n) => !gone.has(n.id));
      });
      return true;
    }

    /* small random velocity changes, so repeated notes stop sounding like a machine */
    humanize() {
      const t = this.targets();
      if (!t.length) return;
      this.edit(() => { for (const n of t) n.vel = clamp(Math.round(n.vel + (Math.random() * 2 - 1) * 14), 20, 127); });
    }

    legato() {
      const t = this.targets().slice().sort((a, b) => a.start - b.start);
      this.edit(() => {
        for (let i = 0; i < t.length - 1; i++) {
          const nx = t.slice(i + 1).find((o) => o.start > t[i].start + 1e-6);
          if (nx) t[i].len = nx.start - t[i].start;
        }
      });
    }
    copy() {
      const t = this.selected();
      if (!t.length) return false;
      const s0 = Math.min(...t.map((n) => n.start));
      this.clip = t.map((n) => ({ d: n.start - s0, len: n.len, pitch: n.pitch, vel: n.vel }));
      this.clipSpan = Math.max(...t.map((n) => n.start + n.len)) - s0;
      return true;
    }
    cut() { if (this.copy()) this.deleteSel(); }
    paste() {
      if (!this.clip.length) return;
      const at = this.snapFloor(this.host.cursor());
      this.edit(() => {
        this.sel.clear();
        for (const c of this.clip) this.sel.add(this.addNote(at + c.d, c.pitch, c.len, c.vel).id);
      });
      this.host.setCursor(at + Math.ceil(this.clipSpan - 1e-6));
    }
    duplicate() {
      const t = this.selected();
      if (!t.length) return;
      const s0 = Math.min(...t.map((n) => n.start)), e0 = Math.max(...t.map((n) => n.start + n.len));
      const span = Math.max(1, Math.ceil(e0 - s0 - 1e-6));
      this.edit(() => {
        this.sel.clear();
        for (const n of t) this.sel.add(this.addNote(n.start + span, n.pitch, n.len, n.vel).id);
      });
    }

    /* ---------- input ---------- */
    bind() {
      const c = this.c;
      c.addEventListener('contextmenu', (e) => e.preventDefault());
      c.addEventListener('pointerdown', (e) => this.down(e));
      c.addEventListener('pointermove', (e) => this.move(e));
      c.addEventListener('pointerup', (e) => this.up(e));
      c.addEventListener('pointercancel', (e) => this.up(e));
      c.addEventListener('dblclick', (e) => this.dbl(e));
      c.addEventListener('wheel', (e) => this.wheel(e), { passive: false });
      c.addEventListener('keydown', (e) => this.key(e));
      c.addEventListener('pointerleave', () => { this.hover = null; if (!this.drag) this.draw(); });
    }

    pos(e) { const r = this.c.getBoundingClientRect(); return { px: e.clientX - r.left, py: e.clientY - r.top }; }

    down(e) {
      const { px, py } = this.pos(e);
      this.c.focus({ preventScroll: true });
      const free = e.altKey;
      if (e.button === 1) { // middle: pan
        e.preventDefault();
        this.drag = { mode: 'pan', px, py, x0: this.view.x0, top: this.view.top };
      } else if (py < RULER) {
        if (px < KEYS) return;
        this.drag = { mode: 'ruler' };
        this.host.setCursor(Math.max(0, this.snapFloor(this.beatAt(px), free)));
      } else if (px < KEYS) {
        if (py < this.gridBottom()) this.host.preview(this.pitchAt(py));
        return;
      } else if (py >= this.gridBottom()) {
        this.drag = { mode: 'vel', before: this.host.begin(), changed: false };
        this.paintVel(px, py);
      } else if (e.button === 2) {
        this.drag = { mode: 'erase', before: this.host.begin(), changed: false };
        this.erase(px, py);
      } else {
        const h = this.hit(px, py);
        if (e.ctrlKey || e.metaKey) {
          this.drag = { mode: 'box', ax: px, ay: py, bx: px, by: py, base: e.shiftKey ? new Set(this.sel) : new Set() };
        } else if (h) {
          const n = h.note;
          if (e.shiftKey) {
            if (this.sel.has(n.id)) this.sel.delete(n.id); else this.sel.add(n.id);
            this.draw();
            return;
          }
          if (!this.sel.has(n.id)) { this.sel.clear(); this.sel.add(n.id); }
          this.lastLen = n.len;
          this.startMove(h.edge ? 'resize' : 'move', n, px, py);
          if (!h.edge) this.host.preview(n.pitch);
        } else {
          // draw a new note (or a whole chord) and keep dragging it
          const before = this.host.begin();
          const start = this.snapFloor(this.beatAt(px), free);
          const pitches = this.chordFor(this.pitchAt(py));
          this.sel.clear();
          const made = pitches.map((q) => this.addNote(start, q, this.lastLen));
          for (const m of made) this.sel.add(m.id);
          const n = made[0];
          this.startMove('move', n, px, py, before);
          this.drag.changed = true;
          for (const m of made) this.host.preview(m.pitch);
        }
      }
      if (this.drag) this.c.setPointerCapture(e.pointerId);
      this.draw();
    }

    startMove(mode, anchor, px, py, before) {
      const orig = new Map();
      for (const n of this.selected()) orig.set(n.id, { start: n.start, len: n.len, pitch: n.pitch });
      this.drag = {
        mode, anchor: anchor.id, b0: this.beatAt(px), p0: this.pitchAt(py), orig,
        before: before || this.host.begin(), changed: false, lastPitch: anchor.pitch,
      };
    }

    move(e) {
      const { px, py } = this.pos(e);
      const d = this.drag;
      if (!d) {
        let cur = 'crosshair';
        if (py < RULER) cur = 'text';
        else if (px < KEYS) cur = 'pointer';
        else if (py >= this.gridBottom()) cur = 'ns-resize';
        else { const h = this.hit(px, py); if (h) cur = h.edge ? 'ew-resize' : 'grab'; }
        this.c.style.cursor = cur;
        this.hover = py >= RULER && py < this.gridBottom() && px >= KEYS ? this.pitchAt(py) : null;
        this.draw();
        return;
      }
      const free = e.altKey;
      if (d.mode === 'pan') {
        this.view.x0 = d.x0 - (px - d.px) / this.view.ppb;
        this.view.top = d.top + (py - d.py) / this.view.rowH;
        this.clampView();
      } else if (d.mode === 'ruler') {
        this.host.setCursor(Math.max(0, this.snapFloor(this.beatAt(px), free)));
      } else if (d.mode === 'vel') {
        this.paintVel(px, py);
      } else if (d.mode === 'erase') {
        this.erase(px, py);
      } else if (d.mode === 'box') {
        d.bx = px; d.by = py;
        const b0 = this.beatAt(Math.min(d.ax, d.bx)), b1 = this.beatAt(Math.max(d.ax, d.bx));
        const pHi = this.pitchAt(Math.min(d.ay, d.by)), pLo = this.pitchAt(Math.max(d.ay, d.by));
        this.sel = new Set(d.base);
        for (const n of this.notes) if (n.start < b1 && n.start + n.len > b0 && n.pitch >= pLo && n.pitch <= pHi) this.sel.add(n.id);
      } else if (d.mode === 'move' || d.mode === 'resize') {
        const a = d.orig.get(d.anchor);
        const db = this.beatAt(px) - d.b0;
        if (d.mode === 'move') {
          let start = this.snap(a.start + db, free);
          const minStart = Math.min(...[...d.orig.values()].map((o) => o.start));
          let delta = Math.max(start - a.start, -minStart);
          let dp = this.pitchAt(py) - d.p0;
          const ps = [...d.orig.values()].map((o) => o.pitch);
          dp = clamp(dp, -Math.min(...ps), 127 - Math.max(...ps));
          for (const [id, o] of d.orig) { const n = this.byId(id); if (n) { n.start = o.start + delta; n.pitch = o.pitch + dp; } }
          if (a.pitch + dp !== d.lastPitch) { d.lastPitch = a.pitch + dp; this.host.preview(d.lastPitch); }
          if (delta || dp) d.changed = true;
        } else {
          const end = this.snap(a.start + a.len + db, free);
          const dl = end - (a.start + a.len);
          for (const [id, o] of d.orig) { const n = this.byId(id); if (n) n.len = Math.max(this.minLen(), o.len + dl); }
          const an = this.byId(d.anchor);
          if (an) this.lastLen = an.len;
          if (dl) d.changed = true;
        }
        this.host.changed('live');
      }
      this.draw();
    }

    up(e) {
      const d = this.drag;
      if (!d) return;
      this.drag = null;
      try { this.c.releasePointerCapture(e.pointerId); } catch (err) { /* not captured */ }
      if (d.before != null) {
        if (d.changed) {
          this.sortNotes();
          this.host.end(d.before);
          this.host.changed('notes');
        }
      }
      this.draw();
    }

    dbl(e) {
      const { px, py } = this.pos(e);
      if (py < RULER || px < KEYS || py >= this.gridBottom()) return;
      const h = this.hit(px, py);
      // double-click a note to select every note at that pitch
      if (h) { this.sel = new Set(this.notes.filter((n) => n.pitch === h.note.pitch).map((n) => n.id)); this.draw(); }
    }

    erase(px, py) {
      const h = this.hit(px, py);
      if (!h) return;
      this.notes = this.notes.filter((n) => n !== h.note);
      this.sel.delete(h.note.id);
      this.drag.changed = true;
      this.host.changed('live');
    }

    paintVel(px, py) {
      const top = this.gridBottom() + 6, bot = this.size().H - 4;
      const v = clamp(Math.round(((bot - py) / (bot - top)) * 127), 1, 127);
      let hits = this.notesAtX(px);
      if (!hits.length) return;
      const selHits = hits.filter((n) => this.sel.has(n.id));
      if (selHits.length) hits = selHits;
      for (const n of hits) n.vel = v;
      this.drag.changed = true;
      this.host.changed('live');
    }

    wheel(e) {
      e.preventDefault();
      const v = this.view;
      const { px } = this.pos(e);
      const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY, dx = e.deltaMode === 1 ? e.deltaX * 16 : e.deltaX;
      if (e.ctrlKey || e.metaKey) {
        const b = this.beatAt(px);
        v.ppb = clamp(v.ppb * Math.exp(-dy * 0.0025), 10, 600);
        v.x0 = b - (px - KEYS) / v.ppb;
      } else if (e.altKey) {
        v.rowH = clamp(v.rowH * Math.exp(-dy * 0.002), 7, 34);
      } else if (e.shiftKey) {
        v.x0 += (dy || dx) / v.ppb;
      } else {
        v.x0 += dx / v.ppb;
        v.top -= dy / v.rowH / 1.5;
      }
      this.clampView();
      this.draw();
    }

    key(e) {
      const ctrl = e.ctrlKey || e.metaKey, k = e.key;
      let used = true;
      if (k === 'Delete' || k === 'Backspace') this.deleteSel();
      else if (ctrl && (k === 'a' || k === 'A')) this.selectAll();
      else if (ctrl && (k === 'c' || k === 'C')) this.copy();
      else if (ctrl && (k === 'x' || k === 'X')) this.cut();
      else if (ctrl && (k === 'v' || k === 'V')) this.paste();
      else if (ctrl && (k === 'd' || k === 'D' || k === 'b' || k === 'B')) this.duplicate();
      else if (k === 'Escape') { this.sel.clear(); this.draw(); }
      else if (k === 'ArrowUp' && !ctrl) this.transpose(e.shiftKey ? 12 : 1);
      else if (k === 'ArrowDown' && !ctrl) this.transpose(e.shiftKey ? -12 : -1);
      else if (k === 'ArrowLeft' && !ctrl && this.sel.size) this.nudge(-1);
      else if (k === 'ArrowRight' && !ctrl && this.sel.size) this.nudge(1);
      else if (!ctrl && (k === 'q' || k === 'Q')) this.quantize();
      else used = false;
      if (used) e.preventDefault();
    }

    /* ---------- drawing ---------- */
    draw() {
      if (this.raf) return;
      this.raf = requestAnimationFrame(() => { this.raf = 0; this.paint(); });
    }

    paint() {
      if (!this.c.offsetParent || !this.host.pattern().notes) return; // hidden, or a drum pattern is selected
      const { W, H } = this.size();
      const c = this.c, g = this.g, dpr = window.devicePixelRatio || 1;
      if (c.width !== Math.round(W * dpr) || c.height !== Math.round(H * dpr)) {
        c.width = Math.round(W * dpr); c.height = Math.round(H * dpr);
        c.style.width = W + 'px';
      }
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      this.clampView();
      const p = this.p, v = this.view, C = this.col;
      const GB = H - VEL;
      const L = this.host.length();
      const NOTE = this.host.color();
      const held = this.host.held ? this.host.held() : null;
      const steps = E.SCALES[p.scale].steps, keyed = p.scale !== 'chromatic';
      const pHi = Math.ceil(v.top), pLo = Math.max(0, Math.floor(this.pitchAt(GB)));

      g.fillStyle = C.roll;
      g.fillRect(0, 0, W, H);

      // rows
      g.save();
      g.beginPath(); g.rect(KEYS, RULER, W - KEYS, GB - RULER); g.clip();
      for (let q = pLo; q <= pHi; q++) {
        const y = this.y(q), pc = ((q % 12) + 12) % 12, rel = (((q - p.root) % 12) + 12) % 12;
        const out = keyed ? !steps.includes(rel) : BLACK.includes(pc);
        if (out) { g.fillStyle = 'rgba(0,0,0,0.26)'; g.fillRect(KEYS, y, W, v.rowH); }
        if (keyed && rel === 0) { g.fillStyle = 'rgba(255,176,79,0.07)'; g.fillRect(KEYS, y, W, v.rowH); }
        if (q === this.hover) { g.fillStyle = 'rgba(255,255,255,0.04)'; g.fillRect(KEYS, y, W, v.rowH); }
        g.fillStyle = pc === 11 ? 'rgba(255,255,255,0.10)' : 'rgba(255,255,255,0.04)';
        g.fillRect(KEYS, Math.round(y), W, 1);
      }

      // vertical grid
      const b0 = Math.max(0, Math.floor(v.x0)), b1 = this.beatAt(W);
      const sub = this.step() || 0.25;
      const subOK = sub * v.ppb >= 9;
      if (subOK) {
        g.fillStyle = 'rgba(255,255,255,0.03)';
        for (let b = Math.floor(v.x0 / sub) * sub; b <= b1; b += sub) g.fillRect(Math.round(this.x(b)), RULER, 1, GB - RULER);
      }
      for (let b = b0; b <= b1; b++) {
        const bar = b % 4 === 0;
        if (!bar && v.ppb < 12) continue;
        g.fillStyle = bar ? 'rgba(255,255,255,0.2)' : 'rgba(255,255,255,0.08)';
        g.fillRect(Math.round(this.x(b)), RULER, 1, GB - RULER);
      }
      // outside the song
      const xe = this.x(L);
      if (xe < W) { g.fillStyle = 'rgba(0,0,0,0.35)'; g.fillRect(xe, RULER, W - xe, GB - RULER); g.fillStyle = NOTE; g.fillRect(Math.round(xe), RULER, 1, GB - RULER); }

      // what the microphone heard
      const tr = this.host.trace();
      if (tr) {
        g.strokeStyle = C.trace; g.globalAlpha = 0.55; g.lineWidth = 1.25; g.lineJoin = 'round';
        g.beginPath();
        let pen = false;
        for (let i = 0; i < tr.beats.length; i++) {
          const m = tr.pitch[i], b = tr.beats[i];
          if (m !== m) { pen = false; continue; }
          const x = this.x(b), y = this.y(m) + v.rowH / 2;
          if (x < KEYS - 4 || x > W + 4) { pen = false; continue; }
          if (pen) g.lineTo(x, y); else { g.moveTo(x, y); pen = true; }
        }
        g.stroke();
        g.globalAlpha = 1;
      }

      // notes
      g.font = '500 11px ' + this.mono();
      g.textBaseline = 'middle';
      for (const n of this.notes) {
        const x = this.x(n.start), w = Math.max(3, n.len * v.ppb - 1.5);
        if (x > W || x + w < KEYS) continue;
        const y = this.y(n.pitch) + 1, h = Math.max(3, v.rowH - 2);
        if (y > GB || y + h < RULER) continue;
        const on = this.sel.has(n.id);
        g.globalAlpha = 0.5 + 0.5 * (n.vel / 127);
        g.fillStyle = on ? lighten(NOTE) : NOTE;
        this.rr(x, y, w, h, 3);
        g.fill();
        g.globalAlpha = 1;
        if (on) { g.strokeStyle = 'rgba(255,255,255,0.7)'; g.lineWidth = 1; this.rr(x + 0.5, y + 0.5, w - 1, h - 1, 3); g.stroke(); }
        // resize grip
        if (w > 14) { g.fillStyle = 'rgba(0,0,0,0.22)'; g.fillRect(x + w - 4, y + 3, 1.5, h - 6); }
        if (w > 30 && v.rowH >= 12) { g.fillStyle = C['note-ink']; g.fillText(E.noteName(n.pitch), x + 5, y + h / 2 + 0.5); }
      }

      // box select
      const d = this.drag;
      if (d && d.mode === 'box') {
        g.fillStyle = 'rgba(88,214,197,0.12)'; g.strokeStyle = C.trace; g.lineWidth = 1;
        const bx = Math.min(d.ax, d.bx), by = Math.min(d.ay, d.by), bw = Math.abs(d.bx - d.ax), bh = Math.abs(d.by - d.ay);
        g.fillRect(bx, by, bw, bh); g.strokeRect(bx + 0.5, by + 0.5, bw, bh);
      }
      g.restore();

      // velocity lane
      g.fillStyle = C.panel; g.fillRect(KEYS, GB, W - KEYS, VEL);
      g.fillStyle = C.line; g.fillRect(0, GB, W, 1);
      g.save();
      g.beginPath(); g.rect(KEYS, GB, W - KEYS, VEL); g.clip();
      const vt = GB + 6, vb = H - 4;
      for (const n of this.notes) {
        const x = this.x(n.start);
        if (x < KEYS - 6 || x > W) continue;
        const h = (vb - vt) * (n.vel / 127);
        g.fillStyle = this.sel.has(n.id) ? lighten(NOTE) : NOTE;
        g.globalAlpha = 0.85;
        g.fillRect(Math.round(x), vb - h, 2, h);
        g.beginPath(); g.arc(Math.round(x) + 1, vb - h, 3, 0, Math.PI * 2); g.fill();
        g.globalAlpha = 1;
      }
      g.restore();

      // ruler
      g.fillStyle = C.panel; g.fillRect(KEYS, 0, W - KEYS, RULER);
      g.fillStyle = C.line; g.fillRect(0, RULER - 1, W, 1);
      g.save();
      g.beginPath(); g.rect(KEYS, 0, W - KEYS, RULER); g.clip();
      g.font = '11px ' + this.mono();
      g.textBaseline = 'middle';
      const barEvery = v.ppb * 4 < 34 ? 4 : v.ppb * 4 < 60 ? 2 : 1;
      for (let b = Math.floor(v.x0 / 4) * 4; b <= b1; b += 1) {
        const x = Math.round(this.x(b));
        if (b % 4 === 0) {
          g.fillStyle = 'rgba(255,255,255,0.25)'; g.fillRect(x, 8, 1, RULER - 8);
          if ((b / 4) % barEvery === 0) { g.fillStyle = b < L ? C.text : C.muted; g.fillText(String(b / 4 + 1), x + 4, RULER / 2); }
        } else if (v.ppb >= 12) { g.fillStyle = 'rgba(255,255,255,0.12)'; g.fillRect(x, RULER - 6, 1, 5); }
      }
      // cursor marker
      const cx = this.x(this.host.cursor());
      g.fillStyle = C.trace;
      g.beginPath(); g.moveTo(cx - 6, 2); g.lineTo(cx + 6, 2); g.lineTo(cx, 11); g.closePath(); g.fill();
      g.restore();
      g.globalAlpha = 0.6; g.fillStyle = C.trace;
      if (cx >= KEYS) g.fillRect(Math.round(cx), RULER, 1, GB - RULER);
      g.globalAlpha = 1;

      // playhead
      const ph = this.host.playhead();
      if (ph != null) {
        const x = Math.round(this.x(ph));
        if (x >= KEYS && x <= W) { g.fillStyle = C.text; g.fillRect(x, 0, 2, H); }
      }

      // keyboard
      g.fillStyle = C.panel; g.fillRect(0, RULER, KEYS, GB - RULER);
      g.save();
      g.beginPath(); g.rect(0, RULER, KEYS, GB - RULER); g.clip();
      for (let q = pLo; q <= pHi; q++) {
        const y = this.y(q), pc = ((q % 12) + 12) % 12, black = BLACK.includes(pc);
        g.fillStyle = held && held.has(q) ? NOTE : q === this.hover ? C.trace : black ? '#15131f' : '#cfcadf';
        g.fillRect(black ? 0 : 0, y, black ? KEYS * 0.62 : KEYS, v.rowH);
        g.fillStyle = 'rgba(0,0,0,0.35)'; g.fillRect(0, Math.round(y), KEYS, 1);
        if (pc === 0 || v.rowH >= 14) {
          g.fillStyle = black ? C.muted : '#2b2740';
          g.font = (pc === 0 ? '500 ' : '') + '10px ' + this.mono();
          g.textAlign = 'right';
          if (!black || v.rowH >= 14) g.fillText(E.noteName(q), KEYS - 5, y + v.rowH / 2 + 0.5);
          g.textAlign = 'left';
        }
      }
      g.restore();
      g.fillStyle = C.line; g.fillRect(KEYS - 1, 0, 1, H);
      // corner + velocity label
      g.fillStyle = C.panel; g.fillRect(0, 0, KEYS - 1, RULER - 1); g.fillRect(0, GB + 1, KEYS - 1, VEL);
      g.fillStyle = C.muted; g.font = '10px ' + this.mono(); g.textBaseline = 'middle';
      g.fillText('VEL', 8, GB + VEL / 2);
    }

    mono() { return '"DM Mono", ui-monospace, Consolas, monospace'; }
    rr(x, y, w, h, r) {
      const g = this.g;
      r = Math.min(r, w / 2, h / 2);
      g.beginPath();
      g.moveTo(x + r, y); g.lineTo(x + w - r, y); g.quadraticCurveTo(x + w, y, x + w, y + r);
      g.lineTo(x + w, y + h - r); g.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
      g.lineTo(x + r, y + h); g.quadraticCurveTo(x, y + h, x, y + h - r);
      g.lineTo(x, y + r); g.quadraticCurveTo(x, y, x + r, y);
      g.closePath();
    }
  }

  return PianoRoll;
})();
