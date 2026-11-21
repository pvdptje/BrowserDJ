/* BrowserDJ playlist: one lane per track, clips place patterns on the song timeline.
   Click a lane to place the track's current pattern, drag a clip to move it (Shift/Ctrl+drag copies),
   drag its right edge to repeat the pattern, right-click to delete. Times are in beats; snapping is per bar (Alt: per beat). */
window.BDJ = window.BDJ || {};
BDJ.Playlist = (() => {
  'use strict';
  const PJ = () => BDJ.Project;
  const RULER = 38, MARK = 17, ROW = 52, AROW = 60, EDGE = 8; // ruler: markers + loop band on top (MARK), bar numbers below
  const MARKER_COLOR = '#ffe066';
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  /* readable value of an automation point */
  function autoLabel(id, v) {
    if (id === 'volume') return v <= 0.0005 ? '−∞ dB' : (20 * Math.log10(v)).toFixed(1) + ' dB';
    if (id === 'pan') { const p = v * 2 - 1; return Math.abs(p) < 0.01 ? 'centre' : (p < 0 ? 'L' : 'R') + Math.round(Math.abs(p) * 100); }
    if (id === 'filter') {
      if (Math.abs(v - 0.5) < 0.01) return 'open';
      const f = BDJ.Sound.filterFreqs(v), hz = v < 0.5 ? f.lp : f.hp;
      return (v < 0.5 ? 'low-pass ' : 'high-pass ') + (hz >= 1000 ? (hz / 1000).toFixed(1) + ' kHz' : Math.round(hz) + ' Hz');
    }
    return Math.round(v * 100) + '%';
  }
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  class Playlist {
    /* host: { project(), begin(), end(before), changed(kind), select(trackId, patternId), playhead(), cursor(), setCursor(b),
               trackChanged(track), removeTrack(id) } */
    constructor(heads, canvas, host) {
      this.heads = heads;
      this.c = canvas;
      this.g = canvas.getContext('2d');
      this.host = host;
      this.view = { x0: 0, ppb: 12 };
      this.drag = null;
      this.selClip = null;
      this.col = {};
      const cs = getComputedStyle(document.documentElement);
      for (const k of ['roll', 'line', 'text', 'muted', 'panel', 'panel-2', 'trace', 'bg']) this.col[k] = cs.getPropertyValue('--' + k).trim();
      this.bindCanvas();
      this.bindHeads();
      new ResizeObserver(() => this.draw()).observe(canvas.parentElement);
    }

    get p() { return this.host.project(); }

    /* ---------- geometry ---------- */
    /* rows top to bottom: every track, and under it its automation lane when open */
    rows() {
      const out = [];
      let y = RULER;
      for (const t of this.p.tracks) {
        out.push({ t, kind: 'track', y, h: ROW });
        y += ROW;
        if (t.autoOpen) { out.push({ t, kind: 'auto', y, h: AROW }); y += AROW; }
      }
      return out;
    }
    size() {
      const rs = this.rows(), last = rs[rs.length - 1];
      return { W: Math.max(200, Math.floor(this.c.parentElement.getBoundingClientRect().width)), H: last ? last.y + last.h : RULER };
    }
    x(b) { return (b - this.view.x0) * this.view.ppb; }
    beatAt(px) { return this.view.x0 + px / this.view.ppb; }
    rowAt(py) { return py < RULER ? null : this.rows().find((r) => py >= r.y && py < r.y + r.h) || null; }
    snap(b, free) { const s = free ? 1 : 4; return Math.max(0, Math.round(b / s) * s); }
    snapFloor(b, free) { const s = free ? 1 : 4; return Math.max(0, Math.floor(b / s + 1e-9) * s); }

    fit() {
      const { W } = this.size();
      const L = PJ().songBeats(this.p) + 8;
      this.view.ppb = clamp(W / L, 3, 60);
      this.view.x0 = 0;
      this.draw();
    }
    follow(b) {
      const { W } = this.size();
      const span = W / this.view.ppb;
      if (b < this.view.x0 || b > this.view.x0 + span * 0.94) this.view.x0 = Math.max(0, b - span * 0.05);
    }

    clipAt(px, py) {
      const r = this.rowAt(py);
      if (!r || r.kind !== 'track') return null;
      const t = r.t;
      const b = this.beatAt(px);
      const cs = this.p.clips.filter((c) => c.trackId === t.id);
      for (let i = cs.length - 1; i >= 0; i--) {
        const c = cs[i];
        if (b >= c.start && b <= c.start + c.len) {
          const x1 = this.x(c.start + c.len);
          return { clip: c, edge: px >= x1 - Math.min(EDGE, (c.len * this.view.ppb) / 3) };
        }
      }
      return null;
    }

    /* ---------- track headers (DOM) ---------- */
    renderHeads() {
      const p = this.p, html = ['<div class="plcorner">Tracks</div>'];
      for (const t of p.tracks) {
        const on = t.id === p.sel.trackId;
        html.push(`<div class="plhead${on ? ' on' : ''}${t.mute ? ' muted' : ''}" data-id="${t.id}" style="--tc:${t.color}">`);
        html.push(`<span class="swatch" aria-hidden="true"></span>`);
        html.push(`<div class="plname"><input type="text" value="${esc(t.name)}" maxlength="40" aria-label="Track name" spellcheck="false"><span class="pltype">${t.type === 'drums' ? 'Drum kit' : esc((BDJ.Sound.INSTRUMENTS.find((i) => i.id === t.instrument) || {}).name || 'Synth')}</span></div>`);
        const hasAuto = PJ().autoParams(t).length > 0;
        html.push(`<button type="button" class="tog auto${t.autoOpen ? ' on' : ''}${hasAuto ? ' has' : ''}" data-act="auto" aria-pressed="${t.autoOpen}" title="Automation lane${hasAuto ? ' (this track has automation)' : ''}">A</button>`);
        html.push(`<button type="button" class="tog${t.mute ? ' on' : ''}" data-act="mute" aria-pressed="${t.mute}" title="Mute">M</button>`);
        html.push(`<button type="button" class="tog solo${t.solo ? ' on' : ''}" data-act="solo" aria-pressed="${t.solo}" title="Solo">S</button>`);
        html.push(`<input type="range" class="plvol" min="0" max="100" value="${Math.round(t.volume * 100)}" aria-label="${esc(t.name)} volume" title="Volume">`);
        html.push(`<button type="button" class="tog x" data-act="del" title="Delete track"${p.tracks.length < 2 ? ' disabled' : ''}>&times;</button>`);
        html.push('</div>');
        if (t.autoOpen) {
          const used = new Set(PJ().autoParams(t));
          html.push(`<div class="plauto" data-id="${t.id}" style="--tc:${t.color}"><span class="swatch" aria-hidden="true"></span>`);
          html.push(`<label class="sr" for="autosel-${t.id}">Automated setting</label><select class="autosel" id="autosel-${t.id}">`);
          for (const prm of BDJ.Sound.PARAMS) html.push(`<option value="${prm.id}"${prm.id === t.autoParam ? ' selected' : ''}>${prm.name}${used.has(prm.id) ? ' ●' : ''}</option>`);
          html.push(`</select><button type="button" class="btn small" data-act="autoclear"${used.has(t.autoParam) ? '' : ' disabled'}>Clear</button></div>`);
        }
      }
      this.heads.innerHTML = html.join('');
    }

    /* Selection only moves a highlight, so an input being clicked into is never re-created. */
    markSelected() {
      for (const el of this.heads.querySelectorAll('.plhead')) el.classList.toggle('on', +el.dataset.id === this.p.sel.trackId);
    }

    bindHeads() {
      const h = this.heads;
      const trackOf = (el) => { const r = el.closest('.plhead, .plauto'); return r && PJ().track(this.p, +r.dataset.id); };
      h.addEventListener('click', (e) => {
        const t = trackOf(e.target);
        if (!t) return;
        const b = e.target.closest('[data-act]');
        if (!b) { if (e.target.tagName !== 'INPUT' && e.target.tagName !== 'SELECT') this.host.select(t.id); return; }
        if (b.dataset.act === 'del') { this.host.removeTrack(t.id); return; }
        if (b.dataset.act === 'auto') {
          // showing a lane is a view setting: saved with the project, not an undo step
          t.autoOpen = !t.autoOpen;
          this.host.changed('view');
          return;
        }
        if (b.dataset.act === 'autoclear') {
          const before = this.host.begin();
          delete t.auto[t.autoParam];
          this.host.end(before);
          this.host.changed('auto');
          return;
        }
        const before = this.host.begin();
        if (b.dataset.act === 'mute') t.mute = !t.mute;
        if (b.dataset.act === 'solo') t.solo = !t.solo;
        this.host.end(before);
        this.host.changed('tracks');
      });
      h.addEventListener('focusin', (e) => { const t = trackOf(e.target); if (t && e.target.type === 'text' && t.id !== this.p.sel.trackId) this.host.select(t.id); });
      h.addEventListener('change', (e) => {
        const t = trackOf(e.target);
        if (!t) return;
        if (e.target.classList.contains('autosel')) {
          t.autoParam = e.target.value;
          this.host.changed('view');
          return;
        }
        if (e.target.type === 'text') {
          const v = e.target.value.trim().slice(0, 40);
          if (!v || v === t.name) { e.target.value = t.name; return; }
          const before = this.host.begin();
          t.name = v;
          this.host.end(before);
          this.host.changed('tracks');
        } else if (e.target.classList.contains('plvol')) {
          if (this.volBefore != null) { this.host.end(this.volBefore); this.volBefore = null; this.host.changed('quiet'); }
        }
      });
      h.addEventListener('input', (e) => {
        if (!e.target.classList.contains('plvol')) return;
        const t = trackOf(e.target);
        if (this.volBefore == null) this.volBefore = this.host.begin();
        t.volume = +e.target.value / 100;
        this.host.trackChanged(t);
      });
      h.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.type === 'text') e.target.blur(); });
    }

    /* ---------- canvas input ---------- */
    bindCanvas() {
      const c = this.c;
      c.addEventListener('contextmenu', (e) => e.preventDefault());
      c.addEventListener('pointerdown', (e) => this.down(e));
      c.addEventListener('pointermove', (e) => this.move(e));
      c.addEventListener('pointerup', (e) => this.up(e));
      c.addEventListener('pointercancel', (e) => this.up(e));
      c.addEventListener('wheel', (e) => this.wheel(e), { passive: false });
      c.addEventListener('keydown', (e) => this.key(e));
      c.addEventListener('dblclick', (e) => this.dbl(e));
    }
    pos(e) { const r = this.c.getBoundingClientRect(); return { px: e.clientX - r.left, py: e.clientY - r.top }; }

    down(e) {
      const { px, py } = this.pos(e);
      this.c.focus({ preventScroll: true });
      const free = e.altKey, p = this.p;
      if (e.button === 1) {
        e.preventDefault();
        this.drag = { mode: 'pan', px, x0: this.view.x0 };
      } else if (py < RULER) {
        this.rulerDown(e, px, py, free);
      } else if (this.rowAt(py) && this.rowAt(py).kind === 'auto') {
        this.autoDown(e, this.rowAt(py), px, py, free);
      } else if (e.button === 2) {
        this.drag = { mode: 'erase', before: this.host.begin(), changed: false };
        this.erase(px, py);
      } else {
        const row = this.rowAt(py);
        if (!row) return;
        const t = row.t;
        const h = this.clipAt(px, py);
        const before = this.host.begin();
        let clip, changed = false;
        if (h && (e.shiftKey || e.ctrlKey || e.metaKey)) {
          clip = { ...h.clip, id: p.nextId++ };
          p.clips.push(clip);
          changed = true;
        } else if (h) {
          clip = h.clip;
        } else {
          // place the track's current pattern here
          const pat = this.brush(t);
          clip = PJ().addClip(p, pat, this.snapFloor(this.beatAt(px), free));
          changed = true;
        }
        this.selClip = clip.id;
        this.host.select(clip.trackId, clip.patternId);
        this.drag = {
          mode: h && h.edge && !changed ? 'resize' : 'move', clip: clip.id, b0: this.beatAt(px),
          start: clip.start, len: clip.len, before, changed,
        };
        if (changed) this.host.changed('live');
      }
      if (this.drag) this.c.setPointerCapture(e.pointerId);
      this.draw();
    }

    /* Automation lane: click to add a point and drag it, drag points to move them, right-click to delete.
       Points snap to beats (Alt: free). Values run 0 (bottom) to 1 (top). */
    autoY(row, v) { return row.y + 6 + (1 - v) * (row.h - 12); }
    autoV(row, py) { return clamp(1 - (py - row.y - 6) / (row.h - 12), 0, 1); }
    autoPointAt(row, px, py) {
      const pts = row.t.auto[row.t.autoParam] || [];
      let best = null, bd = 8;
      for (const pt of pts) {
        const d = Math.hypot(this.x(pt.b) - px, this.autoY(row, pt.v) - py);
        if (d < bd) { bd = d; best = pt; }
      }
      return best;
    }
    autoBeat(px, free) { const b = this.beatAt(px); return Math.max(0, free ? Math.round(b * 16) / 16 : Math.round(b)); }
    autoDown(e, row, px, py, free) {
      const t = row.t, id = t.autoParam;
      const before = this.host.begin();
      const hit = this.autoPointAt(row, px, py);
      if (e.button === 2) {
        this.drag = { mode: 'autoerase', row, before, changed: false };
        this.autoErase(px, py);
        return;
      }
      let pt = hit;
      if (!pt) {
        t.auto[id] = t.auto[id] || [];
        pt = { b: this.autoBeat(px, free), v: this.autoV(row, py) };
        t.auto[id].push(pt);
        PJ().sortAuto(t.auto[id]);
      }
      this.drag = { mode: 'autopt', row, pt, before, changed: !hit };
      this.host.changed('live');
    }
    autoErase(px, py) {
      const d = this.drag, row = this.rowAt(py);
      if (!row || row.kind !== 'auto' || row.t !== d.row.t) return;
      const hit = this.autoPointAt(row, px, py);
      if (!hit) return;
      const list = row.t.auto[row.t.autoParam];
      list.splice(list.indexOf(hit), 1);
      if (!list.length) delete row.t.auto[row.t.autoParam];
      d.changed = true;
      this.host.changed('live');
    }

    /* Ruler: markers on top, loop region edges, click to set the marker, drag to draw a loop region. */
    markerAt(px) { return (this.markerRects || []).find((r) => px >= r.x0 - 3 && px <= r.x1 + 2); }
    loopEdgeAt(px) {
      const R = this.p.region;
      if (!R) return null;
      if (Math.abs(px - this.x(R.start)) < 6) return 'start';
      if (Math.abs(px - this.x(R.end)) < 6) return 'end';
      return null;
    }
    rulerDown(e, px, py, free) {
      const p = this.p, hitM = py < MARK ? this.markerAt(px) : null;
      const mk = hitM && p.markers.find((m) => m.id === hitM.id);
      if (e.button === 2) {
        const before = this.host.begin();
        const b = this.beatAt(px);
        if (mk) p.markers = p.markers.filter((m) => m !== mk);
        else if (p.region && b >= p.region.start && b <= p.region.end) p.region = null;
        else return;
        this.host.end(before);
        this.host.changed('song');
        return;
      }
      if (mk) { this.drag = { mode: 'marker', id: mk.id, b0: this.beatAt(px), beat0: mk.beat, before: this.host.begin(), changed: false }; return; }
      const edge = this.loopEdgeAt(px);
      if (edge) { this.drag = { mode: 'loop', edge, before: this.host.begin(), changed: false }; return; }
      const b = this.snapFloor(this.beatAt(px), free);
      this.drag = { mode: 'ruler', px0: px, b0: b, before: this.host.begin(), changed: false, creating: false };
      this.host.setCursor(b);
    }
    rulerMove(d, px, free) {
      const p = this.p, minLen = free ? 1 : 4;
      if (d.mode === 'marker') {
        const m = p.markers.find((x) => x.id === d.id);
        const nb = this.snap(d.beat0 + this.beatAt(px) - d.b0, free);
        if (m && nb !== m.beat) { m.beat = nb; d.changed = true; }
      } else if (d.mode === 'loop') {
        const R = p.region, nb = this.snap(this.beatAt(px), free);
        if (d.edge === 'start') R.start = clamp(nb, 0, R.end - minLen); else R.end = Math.max(nb, R.start + minLen);
        d.changed = true;
      } else {
        if (!d.creating && Math.abs(px - d.px0) > 6) d.creating = true;
        if (!d.creating) return;
        const b1 = this.snap(this.beatAt(px), free);
        const a = Math.min(d.b0, b1);
        let z = Math.max(d.b0, b1);
        if (z - a < minLen) z = a + minLen;
        p.region = { start: a, end: z };
        d.changed = true;
      }
      this.host.changed('live');
    }
    rulerUp(d) {
      const p = this.p;
      if (d.mode === 'marker' && !d.changed) {
        const m = p.markers.find((x) => x.id === d.id);
        if (m) this.host.setCursor(m.beat);
        return;
      }
      if (!d.changed) return;
      this.host.end(d.before);
      this.host.changed('song');
      if (d.mode === 'ruler' && p.region) this.host.setCursor(p.region.start);
    }
    addMarkerAt(beat) {
      const p = this.p;
      const name = window.prompt('Name this marker', 'Part ' + (p.markers.length + 1));
      if (name === null) return;
      const before = this.host.begin();
      PJ().addMarker(p, beat, name.trim() || 'Marker');
      this.host.end(before);
      this.host.changed('song');
    }

    brush(t) {
      const p = this.p;
      if (p.sel.trackId === t.id) return PJ().selPattern(p);
      const last = this.lastPat && this.lastPat.get(t.id);
      return PJ().pattern(p, last) || PJ().patternsOf(p, t.id)[0];
    }
    remember(trackId, patternId) { (this.lastPat = this.lastPat || new Map()).set(trackId, patternId); }

    move(e) {
      const { px, py } = this.pos(e);
      const d = this.drag;
      if (!d) {
        let cur = 'crosshair';
        if (py < RULER) cur = py < MARK && this.markerAt(px) ? 'grab' : this.loopEdgeAt(px) ? 'ew-resize' : 'text';
        else {
          const row = this.rowAt(py);
          if (!row) cur = 'default';
          else if (row.kind === 'auto') cur = this.autoPointAt(row, px, py) ? 'move' : 'crosshair';
          else { const h = this.clipAt(px, py); if (h) cur = h.edge ? 'ew-resize' : 'grab'; }
        }
        this.c.style.cursor = cur;
        return;
      }
      const free = e.altKey;
      if (d.mode === 'pan') { this.view.x0 = Math.max(0, d.x0 - (px - d.px) / this.view.ppb); }
      else if (d.mode === 'ruler' || d.mode === 'marker' || d.mode === 'loop') this.rulerMove(d, px, free);
      else if (d.mode === 'erase') this.erase(px, py);
      else if (d.mode === 'autoerase') this.autoErase(px, py);
      else if (d.mode === 'autopt') {
        d.pt.b = this.autoBeat(px, free);
        d.pt.v = this.autoV(d.row, py);
        PJ().sortAuto(d.row.t.auto[d.row.t.autoParam]);
        d.changed = true;
        this.host.changed('live');
      } else {
        const c = this.p.clips.find((x) => x.id === d.clip);
        if (!c) return;
        const db = this.beatAt(px) - d.b0;
        if (d.mode === 'move') {
          const s = this.snap(d.start + db, free);
          if (s !== c.start) { c.start = s; d.changed = true; }
        } else {
          const end = this.snap(d.start + d.len + db, free);
          const len = Math.max(free ? 1 : 4, end - d.start);
          if (len !== c.len) { c.len = len; d.changed = true; }
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
      if (d.mode === 'ruler' || d.mode === 'marker' || d.mode === 'loop') this.rulerUp(d);
      else if (d.mode === 'autopt' || d.mode === 'autoerase') { if (d.changed) { this.host.end(d.before); this.host.changed('auto'); } }
      else if (d.before != null && d.changed) { this.host.end(d.before); this.host.changed('clips'); }
      this.draw();
    }

    dbl(e) {
      const { px, py } = this.pos(e);
      if (py < RULER && !(py < MARK && this.markerAt(px))) this.addMarkerAt(this.snapFloor(this.beatAt(px), e.altKey));
    }

    erase(px, py) {
      const h = this.clipAt(px, py);
      if (!h) return;
      this.p.clips = this.p.clips.filter((c) => c !== h.clip);
      this.drag.changed = true;
      this.host.changed('live');
    }

    key(e) {
      const p = this.p, c = p.clips.find((x) => x.id === this.selClip);
      if (!c) return;
      if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault();
        const before = this.host.begin();
        p.clips = p.clips.filter((x) => x !== c);
        this.selClip = null;
        this.host.end(before);
        this.host.changed('clips');
      } else if ((e.ctrlKey || e.metaKey) && (e.key === 'd' || e.key === 'D' || e.key === 'b' || e.key === 'B')) {
        e.preventDefault();
        const before = this.host.begin();
        const n = { ...c, id: p.nextId++, start: c.start + c.len };
        p.clips.push(n);
        this.selClip = n.id;
        this.host.end(before);
        this.host.changed('clips');
      }
    }

    wheel(e) {
      const v = this.view;
      const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY, dx = e.deltaMode === 1 ? e.deltaX * 16 : e.deltaX;
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        const { px } = this.pos(e), b = this.beatAt(px);
        v.ppb = clamp(v.ppb * Math.exp(-dy * 0.0025), 2, 120);
        v.x0 = Math.max(0, b - px / v.ppb);
      } else if (e.shiftKey || Math.abs(dx) > Math.abs(dy)) {
        e.preventDefault();
        v.x0 = Math.max(0, v.x0 + (dx || dy) / v.ppb);
      } else return; // plain wheel scrolls the page
      this.draw();
    }

    /* ---------- drawing ---------- */
    draw() {
      if (this.raf) return;
      this.raf = requestAnimationFrame(() => { this.raf = 0; this.paint(); });
    }

    paint() {
      const p = this.p, { W, H } = this.size(), C = this.col, g = this.g, v = this.view;
      const dpr = window.devicePixelRatio || 1, c = this.c;
      if (c.width !== Math.round(W * dpr) || c.height !== Math.round(H * dpr)) {
        c.width = Math.round(W * dpr); c.height = Math.round(H * dpr);
        c.style.width = W + 'px'; c.style.height = H + 'px';
      }
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.fillStyle = C.roll; g.fillRect(0, 0, W, H);
      const L = PJ().songBeats(p);
      const b1 = this.beatAt(W);

      // lanes
      const rows = this.rows(), trackRow = new Map();
      rows.forEach((r, i) => {
        if (r.kind === 'track') trackRow.set(r.t.id, r);
        g.fillStyle = r.kind === 'auto' ? 'rgba(0,0,0,0.28)' : r.t.id === p.sel.trackId ? 'rgba(255,255,255,0.045)' : i % 2 ? 'rgba(0,0,0,0.12)' : 'rgba(0,0,0,0)';
        g.fillRect(0, r.y, W, r.h);
        g.fillStyle = 'rgba(255,255,255,0.06)'; g.fillRect(0, r.y + r.h - 1, W, 1);
      });
      // bar lines
      const every = v.ppb * 4 < 10 ? 4 : 1;
      for (let bar = Math.floor(v.x0 / 4); bar * 4 <= b1; bar++) {
        if (bar % every) continue;
        const x = Math.round(this.x(bar * 4));
        g.fillStyle = bar % 4 === 0 ? 'rgba(255,255,255,0.16)' : 'rgba(255,255,255,0.06)';
        g.fillRect(x, RULER, 1, H - RULER);
      }
      const xe = this.x(L);
      if (xe < W) { g.fillStyle = 'rgba(0,0,0,0.3)'; g.fillRect(xe, RULER, W - xe, H - RULER); }

      // clips
      g.textBaseline = 'middle';
      for (const cl of p.clips) {
        const row = trackRow.get(cl.trackId);
        const t = row && row.t, pat = PJ().pattern(p, cl.patternId);
        if (!t || !pat) continue;
        const x = this.x(cl.start), w = Math.max(4, cl.len * v.ppb - 1);
        if (x > W || x + w < 0) continue;
        const y = row.y + 3, h = ROW - 6;
        const editing = pat.id === p.sel.patternId;
        g.save();
        this.rr(x, y, w, h, 5); g.clip();
        g.globalAlpha = t.mute ? 0.35 : 1;
        g.fillStyle = t.color; g.globalAlpha *= 0.28; g.fillRect(x, y, w, h);
        g.globalAlpha = t.mute ? 0.35 : 1;
        g.fillStyle = t.color; g.fillRect(x, y, w, 15);
        // pattern repeats
        const PL = PJ().patternBeats(pat);
        for (let r = PL; r < cl.len - 1e-6; r += PL) {
          const rx = Math.round(x + r * v.ppb);
          g.fillStyle = 'rgba(0,0,0,0.35)'; g.fillRect(rx, y + 15, 1, h - 15);
        }
        this.preview(t, pat, cl, x, y + 17, h - 20);
        g.fillStyle = '#1b1726';
        g.font = '600 11px ' + this.sans();
        if (w > 24) g.fillText(pat.name, x + 6, y + 8, w - 10);
        g.restore();
        if (editing || cl.id === this.selClip) {
          g.strokeStyle = cl.id === this.selClip ? '#fff' : 'rgba(255,255,255,0.55)';
          g.lineWidth = cl.id === this.selClip ? 2 : 1;
          this.rr(x + 0.5, y + 0.5, w - 1, h - 1, 5); g.stroke();
        }
        if (w > 18) { g.fillStyle = 'rgba(0,0,0,0.3)'; g.fillRect(x + w - 4, y + 19, 1.5, h - 24); }
      }

      // automation lanes
      for (const r of rows) if (r.kind === 'auto') this.paintAuto(r, W);

      // markers: a line through the lanes
      for (const m of p.markers) {
        const x = Math.round(this.x(m.beat));
        if (x < -1 || x > W) continue;
        g.fillStyle = 'rgba(255,224,102,0.35)';
        for (let yy = RULER; yy < H; yy += 6) g.fillRect(x, yy, 1, 3);
      }

      // ruler
      g.fillStyle = C.panel; g.fillRect(0, 0, W, RULER);
      g.fillStyle = C.line; g.fillRect(0, RULER - 1, W, 1);
      g.fillStyle = 'rgba(255,255,255,0.05)'; g.fillRect(0, MARK, W, 1);
      // loop region: a band on the ruler and a light wash over the lanes
      const R = p.region;
      if (R) {
        const xs = this.x(R.start), xw = (R.end - R.start) * v.ppb, live = p.loop;
        g.fillStyle = live ? 'rgba(88,214,197,0.07)' : 'rgba(255,255,255,0.03)';
        g.fillRect(xs, RULER, xw, H - RULER);
        g.fillStyle = live ? 'rgba(88,214,197,0.22)' : 'rgba(255,255,255,0.08)';
        g.fillRect(xs, 0, xw, RULER - 1);
        g.fillStyle = live ? C.trace : C.muted;
        g.fillRect(xs, 0, xw, 3);
        g.fillRect(Math.round(xs), 0, 2, H);
        g.fillRect(Math.round(xs + xw) - 2, 0, 2, H);
      }
      g.font = '11px ' + this.mono();
      g.textBaseline = 'middle';
      const label = v.ppb * 4 < 16 ? 4 : v.ppb * 4 < 30 ? 2 : 1;
      const numY = MARK + (RULER - MARK) / 2;
      for (let bar = Math.floor(v.x0 / 4); bar * 4 <= b1; bar++) {
        const x = Math.round(this.x(bar * 4));
        g.fillStyle = 'rgba(255,255,255,0.22)'; g.fillRect(x, MARK + 4, 1, RULER - MARK - 4);
        if (bar % label === 0) { g.fillStyle = bar * 4 < L ? C.text : C.muted; g.fillText(String(bar + 1), x + 4, numY); }
      }
      // marker flags on the top row
      this.markerRects = [];
      g.font = '600 11px ' + this.sans();
      for (const m of p.markers) {
        const x = Math.round(this.x(m.beat));
        const tw = Math.min(140, g.measureText(m.name).width) + 10;
        if (x + tw < 0 || x > W) continue;
        g.fillStyle = MARKER_COLOR;
        this.rr(x, 2, tw, MARK - 3, 3); g.fill();
        g.fillRect(x, 2, 2, RULER - 2);
        g.fillStyle = '#2a2306';
        g.fillText(m.name, x + 5, 2 + (MARK - 3) / 2 + 0.5, tw - 8);
        this.markerRects.push({ id: m.id, x0: x, x1: x + tw });
      }
      // song cursor
      const cx = this.x(this.host.cursor());
      g.fillStyle = C.trace;
      g.beginPath(); g.moveTo(cx - 6, MARK + 1); g.lineTo(cx + 6, MARK + 1); g.lineTo(cx, MARK + 10); g.closePath(); g.fill();
      g.globalAlpha = 0.5; g.fillRect(Math.round(cx), RULER, 1, H - RULER); g.globalAlpha = 1;
      // playhead
      const ph = this.host.playhead();
      if (ph != null) { const x = Math.round(this.x(ph)); if (x >= 0 && x <= W) { g.fillStyle = C.text; g.fillRect(x, 0, 2, H); } }
      if (!p.clips.length) {
        g.fillStyle = C.muted; g.font = '13px ' + this.sans();
        g.fillText('Click a lane to place that track’s pattern in the song.', 12, RULER + ROW / 2);
      }
    }

    /* an automation lane: the curve through its points, or the track's own setting as a dashed line */
    paintAuto(row, W) {
      const g = this.g, t = row.t, id = t.autoParam, pts = t.auto[id] || [];
      const prm = BDJ.Sound.PARAMS.find((x) => x.id === id);
      const yTop = row.y + 6, yBot = row.y + row.h - 6;
      if (id === 'filter' || id === 'pan') {
        g.fillStyle = 'rgba(255,255,255,0.12)';
        const ym = Math.round(this.autoY(row, 0.5));
        for (let x = 0; x < W; x += 8) g.fillRect(x, ym, 4, 1);
      }
      g.font = '11px ' + this.sans();
      g.textBaseline = 'middle';
      if (!pts.length) {
        const y = Math.round(this.autoY(row, BDJ.Sound.trackParam(t, id)));
        g.fillStyle = 'rgba(255,255,255,0.22)';
        for (let x = 0; x < W; x += 6) g.fillRect(x, y, 3, 1);
        g.fillStyle = this.col.muted;
        g.fillText('Click to draw ' + prm.name.toLowerCase() + ' automation (plays in Song mode)', 10, row.y + 14);
        return;
      }
      const xs = pts.map((pt) => this.x(pt.b)), ys = pts.map((pt) => this.autoY(row, pt.v));
      g.beginPath();
      g.moveTo(0, ys[0]);
      for (let i = 0; i < pts.length; i++) g.lineTo(xs[i], ys[i]);
      g.lineTo(W, ys[ys.length - 1]);
      g.lineTo(W, yBot); g.lineTo(0, yBot); g.closePath();
      g.globalAlpha = 0.16; g.fillStyle = t.color; g.fill();
      g.globalAlpha = 1;
      g.beginPath();
      g.moveTo(0, ys[0]);
      for (let i = 0; i < pts.length; i++) g.lineTo(xs[i], ys[i]);
      g.lineTo(W, ys[ys.length - 1]);
      g.strokeStyle = t.color; g.lineWidth = 2; g.stroke();
      for (let i = 0; i < pts.length; i++) {
        if (xs[i] < -6 || xs[i] > W + 6) continue;
        const hot = this.drag && this.drag.pt === pts[i];
        g.beginPath(); g.arc(xs[i], ys[i], hot ? 5.5 : 4, 0, Math.PI * 2);
        g.fillStyle = hot ? '#fff' : t.color; g.fill();
        g.strokeStyle = '#15131f'; g.lineWidth = 1.5; g.stroke();
      }
      g.fillStyle = this.col.muted;
      g.fillText(prm.name, 10, yTop + 6);
      if (this.drag && this.drag.pt && this.drag.row && this.drag.row.t === t) {
        const pt = this.drag.pt;
        g.fillStyle = this.col.text;
        g.fillText(autoLabel(id, pt.v) + '  ·  bar ' + (Math.floor(pt.b / 4) + 1) + '.' + (Math.floor(pt.b % 4) + 1), this.x(pt.b) + 10, this.autoY(row, pt.v) - 10);
      }
    }

    /* tiny picture of the pattern inside a clip */
    preview(t, pat, cl, x, y, h) {
      const g = this.g, v = this.view, PL = PJ().patternBeats(pat);
      g.fillStyle = 'rgba(255,255,255,0.75)';
      if (t.type === 'drums') {
        const ids = BDJ.Sound.DRUMS.map((d) => d.id).filter((id) => (pat.steps[id] || []).some((s) => s));
        if (!ids.length) return;
        const rh = Math.min(5, h / ids.length), N = pat.bars * 16;
        const total = Math.ceil(cl.len * 4);
        if (v.ppb / 4 < 1.2) return;
        for (let s = 0; s < total; s++) {
          const st = s % N;
          ids.forEach((id, r) => { if (pat.steps[id][st]) g.fillRect(x + (s / 4) * v.ppb, y + r * rh, Math.max(1, v.ppb / 4 - 1), Math.max(1, rh - 1)); });
        }
      } else {
        const ns = pat.notes;
        if (!ns.length) return;
        let lo = 127, hi = 0;
        for (const n of ns) { lo = Math.min(lo, n.pitch); hi = Math.max(hi, n.pitch); }
        const span = Math.max(6, hi - lo + 1), rh = h / span;
        for (let r = 0; r < cl.len - 1e-6; r += PL) {
          for (const n of ns) {
            if (r + n.start >= cl.len) continue;
            const nx = x + (r + n.start) * v.ppb, nw = Math.max(1, Math.min(n.len, cl.len - r - n.start) * v.ppb - 1);
            g.fillRect(nx, y + (hi - n.pitch + (span - (hi - lo + 1)) / 2) * rh, nw, Math.max(1.5, rh - 0.5));
          }
        }
      }
    }

    mono() { return '"DM Mono", ui-monospace, Consolas, monospace'; }
    sans() { return '"DM Sans", system-ui, sans-serif'; }
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

  Playlist.ROW = ROW;
  Playlist.RULER = RULER;
  return Playlist;
})();
