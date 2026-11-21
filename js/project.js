/* BrowserDJ project model. A project is plain JSON (times in beats), which keeps it easy to save,
   undo, and later hand to an AI model to read or rewrite. */
window.BDJ = window.BDJ || {};
BDJ.Project = (() => {
  'use strict';
  const E = HumEngine;
  const STEPS_PER_BAR = 16;

  /* '.' off, 'o' ghost, 'x' hit, 'X' accent */
  const PRESETS = {
    empty: { name: 'Empty', rows: {} },
    house: {
      name: 'Four on the floor', bpm: 124,
      rows: { kick: 'X...x...x...x...', clap: '....x.......x...', chat: '..x...x...x...x.', ohat: '..............o.' },
    },
    boombap: {
      name: 'Boom bap', bpm: 90, swing: 0.18,
      rows: { kick: 'X......x..x.....', snare: '....X.......X...', chat: 'x.x.x.x.x.x.x.xo', rim: '...........o....' },
    },
    trap: {
      name: 'Trap', bpm: 140,
      rows: { kick: 'X.......x.....x.', clap: '........X.......', chat: 'x.x.x.x.xxx.x.xx', ohat: '......o.........' },
    },
    breakbeat: {
      name: 'Breakbeat', bpm: 128,
      rows: { kick: 'X.x.......xx....', snare: '....X..o.o..X..o', chat: 'x.x.x.x.x.x.x.x.', crash: 'x...............' },
    },
    dembow: {
      name: 'Dembow', bpm: 96,
      rows: { kick: 'X...x...X...x...', snare: '...x..x....x..x.', chat: 'x.x.x.x.x.x.x.x.' },
    },
    rock: {
      name: 'Rock', bpm: 112,
      rows: { kick: 'X.....x.x.......', snare: '....X.......X...', chat: 'x.x.x.x.x.x.x.x.', crash: 'x...............' },
    },
  };
  const STEP_VEL = { '.': 0, o: 60, x: 100, X: 127 };

  function drumRows() {
    return BDJ.Sound.DRUMS.map((d) => ({ id: d.id, vol: 0.8, mute: false, solo: false, steps: new Array(STEPS_PER_BAR).fill(0) }));
  }

  function applyPreset(p, key) {
    const pre = PRESETS[key] || PRESETS.empty;
    const n = p.drums.bars * STEPS_PER_BAR;
    for (const row of p.drums.rows) {
      const pat = pre.rows[row.id] || '';
      row.steps = new Array(n).fill(0);
      if (pat) for (let i = 0; i < n; i++) row.steps[i] = STEP_VEL[pat[i % pat.length]] || 0;
    }
    if (pre.swing != null) p.drums.swing = pre.swing;
    else if (key !== 'empty') p.drums.swing = 0;
  }

  function setDrumBars(p, bars) {
    bars = Math.max(1, Math.min(8, bars | 0));
    const old = p.drums.bars * STEPS_PER_BAR, n = bars * STEPS_PER_BAR;
    for (const row of p.drums.rows) {
      const s = new Array(n).fill(0);
      // growing repeats what is there, shrinking keeps the start
      for (let i = 0; i < n; i++) s[i] = row.steps[i % old] || 0;
      row.steps = s;
    }
    p.drums.bars = bars;
  }

  function blank() {
    return {
      version: 1,
      name: 'Untitled',
      bpm: 120,
      root: 0,
      scale: 'major',
      bars: 4,
      snap: 16,
      loop: true,
      click: false,
      capture: { detail: 0.5, fixTuning: true, playBeat: false },
      melody: { instrument: 'pluck', echo: true, volume: 0.8, mute: false, fromTake: false, takeOctave: 0, notes: [] },
      drums: { bars: 1, swing: 0, volume: 0.85, mute: false, rows: drumRows() },
      nextId: 1,
    };
  }

  function example() {
    const p = blank();
    Object.assign(p, { name: 'Example', bpm: 124, root: 9, scale: 'minor', bars: 2 });
    const ex = [[57, 0, .5], [60, .5, .5], [64, 1, .5], [69, 1.5, 1], [67, 2.5, .5], [64, 3, .75], [65, 4, .5], [64, 4.5, .5], [60, 5, .5], [62, 5.5, 1], [64, 6.5, .5], [57, 7, 1]];
    p.melody.notes = ex.map(([pitch, start, len], i) => ({ id: p.nextId++, start, len, pitch, vel: [96, 84, 110][i % 3] }));
    applyPreset(p, 'house');
    return p;
  }

  /* ---------- validation / serialization ---------- */
  const num = (v, d, lo, hi) => { v = +v; if (!isFinite(v)) return d; return Math.max(lo, Math.min(hi, v)); };

  function normalize(obj) {
    const p = blank();
    if (!obj || typeof obj !== 'object') return p;
    p.name = typeof obj.name === 'string' ? obj.name.slice(0, 80) : p.name;
    p.bpm = num(obj.bpm, 120, 40, 240);
    p.root = num(obj.root, 0, 0, 11) | 0;
    p.scale = E.SCALES[obj.scale] ? obj.scale : 'major';
    p.bars = num(obj.bars, 4, 1, 128) | 0;
    p.snap = [0, 4, 8, 16, 32].includes(+obj.snap) ? +obj.snap : 16;
    p.loop = obj.loop !== false;
    p.click = !!obj.click;
    if (obj.capture) {
      p.capture.detail = num(obj.capture.detail, 0.5, 0, 1);
      p.capture.fixTuning = obj.capture.fixTuning !== false;
      p.capture.playBeat = !!obj.capture.playBeat;
    }
    const m = obj.melody || {};
    p.melody.instrument = BDJ.Sound.INSTRUMENTS.some((i) => i.id === m.instrument) ? m.instrument : 'pluck';
    p.melody.echo = m.echo !== false;
    p.melody.volume = num(m.volume, 0.8, 0, 1);
    p.melody.mute = !!m.mute;
    p.melody.fromTake = !!m.fromTake;
    p.melody.takeOctave = num(m.takeOctave, 0, -4, 4) | 0;
    let id = 1;
    p.melody.notes = (Array.isArray(m.notes) ? m.notes : []).slice(0, 5000).map((n) => ({
      id: id++,
      start: num(n.start, 0, 0, 100000),
      len: num(n.len, 1, 1 / 64, 10000),
      pitch: num(n.pitch, 60, 0, 127) | 0,
      vel: num(n.vel, 100, 1, 127) | 0,
    }));
    p.nextId = id;
    const d = obj.drums || {};
    p.drums.bars = num(d.bars, 1, 1, 8) | 0;
    p.drums.swing = num(d.swing, 0, 0, 0.6);
    p.drums.volume = num(d.volume, 0.85, 0, 1);
    p.drums.mute = !!d.mute;
    const rows = Array.isArray(d.rows) ? d.rows : [];
    const n = p.drums.bars * STEPS_PER_BAR;
    p.drums.rows = drumRows().map((row) => {
      const src = rows.find((r) => r && r.id === row.id) || {};
      const steps = Array.isArray(src.steps) ? src.steps : [];
      return {
        id: row.id,
        vol: num(src.vol, 0.8, 0, 1),
        mute: !!src.mute,
        solo: !!src.solo,
        steps: Array.from({ length: n }, (_, i) => num(steps[i], 0, 0, 127) | 0),
        ...(typeof src.sampleName === 'string' ? { sampleName: src.sampleName.slice(0, 120) } : {}),
      };
    });
    return p;
  }

  const serialize = (p) => JSON.stringify(p);
  const clone = (p) => JSON.parse(JSON.stringify(p));

  /* ---------- song helpers ---------- */
  const melodyEnd = (p) => p.melody.notes.reduce((a, n) => Math.max(a, n.start + n.len), 0);
  /* Song length in beats: the bar count, grown to fit the melody and the drum pattern. */
  function songBeats(p) {
    const fit = Math.ceil((melodyEnd(p) - 1e-6) / 4);
    return Math.max(p.bars, fit, p.drums.bars) * 4;
  }
  const snapBeats = (p) => (p.snap ? 4 / p.snap : 0);

  /* ---------- hum take -> notes ---------- */
  /* take: {raw, tuning, anchor?}; returns {notes (beats), shift (s)} */
  function deriveFromTake(p, take) {
    const fin = E.finalize(take.raw, {
      root: p.root, scale: p.scale, fixTuning: p.capture.fixTuning, tuning: take.tuning,
      bpm: p.bpm, grid: p.snap, octave: p.melody.takeOctave, anchor: take.anchor,
    }, new Map());
    const k = p.bpm / 60, r = (v) => Math.round(v * 10000) / 10000;
    let id = 1;
    const notes = fin.notes.map((n) => ({
      id: id++, start: r(n.start * k), len: Math.max(1 / 64, r((n.end - n.start) * k)), pitch: n.pitch, vel: n.vel,
    }));
    return { notes, shift: fin.shift };
  }

  function detectKey(p, take) {
    const notes = p.melody.notes.map((n) => ({ midi: n.pitch, start: n.start, end: n.start + n.len }));
    if (take && p.melody.fromTake) return E.detectKey(take.raw, p.capture.fixTuning ? take.tuning : 0);
    return E.detectKey(notes, 0);
  }

  /* ---------- export ---------- */
  function midiTracks(p) {
    const L = songBeats(p);
    const inst = BDJ.Sound.INSTRUMENTS.find((i) => i.id === p.melody.instrument);
    const tracks = [{ name: 'Melody', channel: 0, program: inst ? inst.program : 0, notes: p.melody.notes.filter((n) => n.start < L) }];
    const drumNotes = [];
    const steps = p.drums.bars * STEPS_PER_BAR, anySolo = p.drums.rows.some((r) => r.solo);
    for (const row of p.drums.rows) {
      if (row.mute || (anySolo && !row.solo)) continue;
      const gm = BDJ.Sound.DRUMS.find((d) => d.id === row.id).gm;
      for (let s = 0; s * 0.25 < L - 1e-9; s++) {
        const v = row.steps[s % steps];
        if (!v) continue;
        const swing = s % 2 ? p.drums.swing * 0.25 * 0.5 : 0;
        drumNotes.push({ start: s * 0.25 + swing, len: 0.2, pitch: gm, vel: Math.max(1, Math.round(v * (0.4 + 0.6 * row.vol))) });
      }
    }
    if (drumNotes.length) tracks.push({ name: 'Drums', channel: 9, notes: drumNotes });
    return tracks;
  }

  /* ---------- undo ---------- */
  class History {
    constructor(limit = 200) { this.undo = []; this.redo = []; this.limit = limit; }
    push(before) {
      this.undo.push(before);
      if (this.undo.length > this.limit) this.undo.shift();
      this.redo.length = 0;
    }
    back(current) { if (!this.undo.length) return null; this.redo.push(current); return this.undo.pop(); }
    forward(current) { if (!this.redo.length) return null; this.undo.push(current); return this.redo.pop(); }
  }

  return {
    STEPS_PER_BAR, PRESETS, blank, example, normalize, serialize, clone, applyPreset, setDrumBars,
    songBeats, melodyEnd, snapBeats, deriveFromTake, detectKey, midiTracks, History,
  };
})();
