/* BrowserDJ project model. A project is plain JSON (all times in beats), which keeps it easy to save,
   undo, and later hand to an AI model to read or rewrite.

   tracks    instruments: a synth (piano roll) or a drum kit (step sequencer)
   patterns  belong to one track: notes for a synth, steps per drum for a kit
   clips     place a pattern on its track's lane in the playlist; the pattern repeats to fill the clip.
             off (optional, beats): where in the pattern the clip begins, after a split or a trimmed start */
window.BDJ = window.BDJ || {};
BDJ.Project = (() => {
  'use strict';
  const E = HumEngine;
  const STEPS_PER_BAR = 16;
  const COLORS = ['#ffb04f', '#58d6c5', '#ff5c93', '#a58bff', '#b5e36b', '#5fb4ff', '#ff7a59', '#ffe066'];

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
    fill: {
      name: 'Snare fill',
      rows: { kick: 'X...............', snare: '....x.x.xxxxXXXX', chat: 'x.x.x.x.........', crash: '' },
    },
  };
  const STEP_VEL = { '.': 0, o: 60, x: 100, X: 127 };

  /* ---------- lookups ---------- */
  const track = (p, id) => p.tracks.find((t) => t.id === id);
  const pattern = (p, id) => p.patterns.find((x) => x.id === id);
  const patternsOf = (p, trackId) => p.patterns.filter((x) => x.trackId === trackId);
  const selTrack = (p) => track(p, p.sel.trackId) || p.tracks[0];
  const selPattern = (p) => pattern(p, p.sel.patternId) || patternsOf(p, selTrack(p).id)[0];

  /* ---------- builders ---------- */
  const kit = () => BDJ.Sound.DRUMS.map((d) => ({ id: d.id, vol: 0.8, mute: false, solo: false }));
  const emptySteps = (bars) => Object.fromEntries(BDJ.Sound.DRUMS.map((d) => [d.id, new Array(bars * STEPS_PER_BAR).fill(0)]));

  function nextColor(p) {
    const used = new Set(p.tracks.map((t) => t.color));
    return COLORS.find((c) => !used.has(c)) || COLORS[p.tracks.length % COLORS.length];
  }

  function addTrack(p, type, opts = {}) {
    const n = p.tracks.filter((t) => t.type === type).length + 1;
    const t = {
      id: p.nextId++, type, name: opts.name || ({ drums: 'Drums', audio: 'Audio' }[type] || 'Synth') + (n > 1 ? ' ' + n : ''),
      color: opts.color || nextColor(p), volume: 0.8, pan: 0, drive: 0, filter: 0.5, reverb: 0, pump: 0, mute: false, solo: false,
      auto: {}, autoOpen: false, autoParam: 'volume',
      echoSend: type !== 'synth' || opts.echo === false ? 0 : 1,
    };
    if (type === 'drums') { t.kit = kit(); t.swing = 0; t.volume = 0.85; t.kitStyle = 'classic'; }
    else if (type === 'audio') { /* recordings: everything lives in its patterns (takes) */ }
    else { t.instrument = opts.instrument || 'pluck'; t.shape = { ...BDJ.Sound.SHAPE, ...(opts.shape || {}) }; t.lfo = { target: 'off', rate: '1/8', depth: 0.6 }; }
    p.tracks.push(t);
    addPattern(p, t.id);
    return t;
  }

  function addPattern(p, trackId, name) {
    const t = track(p, trackId);
    const n = patternsOf(p, trackId).length + 1;
    const pat = { id: p.nextId++, trackId, name: name || (t.type === 'audio' ? 'Take ' : 'Pattern ') + n };
    if (t.type === 'audio') pat.audio = null;
    else if (t.type === 'drums') { pat.bars = 1; pat.steps = emptySteps(1); } else { pat.bars = 2; pat.notes = []; pat.fromTake = false; pat.takeOctave = 0; }
    p.patterns.push(pat);
    return pat;
  }

  function clonePattern(p, src) {
    const pat = JSON.parse(JSON.stringify(src));
    pat.id = p.nextId++;
    pat.name = uniqueName(p, src.trackId, src.name);
    if (pat.notes) { for (const n of pat.notes) n.id = p.nextId++; pat.fromTake = false; }
    p.patterns.push(pat);
    return pat;
  }
  function uniqueName(p, trackId, base) {
    const names = new Set(patternsOf(p, trackId).map((x) => x.name));
    if (!names.has(base)) return base;
    base = base.replace(/ \d+$/, '');
    for (let i = 2; ; i++) if (!names.has(base + ' ' + i)) return base + ' ' + i;
  }

  function deletePattern(p, id) {
    const pat = pattern(p, id);
    if (!pat || patternsOf(p, pat.trackId).length < 2) return false;
    p.patterns = p.patterns.filter((x) => x.id !== id);
    p.clips = p.clips.filter((c) => c.patternId !== id);
    if (p.sel.patternId === id) p.sel.patternId = patternsOf(p, pat.trackId)[0].id;
    return true;
  }

  function deleteTrack(p, id) {
    if (p.tracks.length < 2) return false;
    p.tracks = p.tracks.filter((t) => t.id !== id);
    p.patterns = p.patterns.filter((x) => x.trackId !== id);
    p.clips = p.clips.filter((c) => c.trackId !== id);
    if (p.sel.trackId === id) select(p, p.tracks[0].id);
    return true;
  }

  function select(p, trackId, patternId) {
    p.sel.trackId = trackId;
    const pats = patternsOf(p, trackId);
    p.sel.patternId = pats.some((x) => x.id === patternId) ? patternId : (pats[0] || {}).id;
  }

  function addClip(p, pat, start, len) {
    const c = { id: p.nextId++, trackId: pat.trackId, patternId: pat.id, start: Math.max(0, start), len: len || patternBeats(pat) };
    p.clips.push(c);
    return c;
  }

  /* Where clip c begins inside its pattern, in beats. A looping pattern wraps; a take (plays once) does not. */
  function clipOff(p, c, off = c.off) {
    const pat = pattern(p, c.patternId), r = (v) => Math.round(v * 10000) / 10000;
    if (!off || !pat) return 0;
    if (pat.audio) return Math.max(0, r(off));
    const L = patternBeats(pat), m = r(((off % L) + L) % L);
    return m >= L - 1e-6 ? 0 : m;
  }
  /* Cuts clip c in two at song beat `at`. Returns the new right-hand clip, or null when `at` is not inside it. */
  function splitClip(p, c, at) {
    if (!(at > c.start + 1e-6 && at < c.start + c.len - 1e-6)) return null;
    const pat = pattern(p, c.patternId);
    const right = { ...c, id: p.nextId++, start: at, len: c.start + c.len - at };
    const off = clipOff(p, c, (c.off || 0) + (at - c.start));
    if (off) right.off = off; else delete right.off;
    c.len = at - c.start;
    // a take that has finished before the cut leaves nothing on the right
    if (pat && pat.audio && off >= patternBeats(pat) - 1e-6) return null;
    p.clips.push(right);
    return right;
  }

  /* ---------- drums ---------- */
  function applyPreset(p, pat, key) {
    const pre = PRESETS[key] || PRESETS.empty;
    const n = pat.bars * STEPS_PER_BAR;
    for (const d of BDJ.Sound.DRUMS) {
      const s = pre.rows[d.id] || '';
      pat.steps[d.id] = Array.from({ length: n }, (_, i) => (s ? STEP_VEL[s[i % s.length]] || 0 : 0));
    }
    delete pat.rolls;
    const t = track(p, pat.trackId);
    if (pre.swing != null) t.swing = pre.swing;
  }

  function setDrumBars(pat, bars) {
    bars = Math.max(1, Math.min(8, bars | 0));
    const old = pat.bars * STEPS_PER_BAR, n = bars * STEPS_PER_BAR;
    for (const id of Object.keys(pat.steps)) {
      const src = pat.steps[id];
      // growing repeats what is there, shrinking keeps the start
      pat.steps[id] = Array.from({ length: n }, (_, i) => src[i % old] || 0);
    }
    for (const id of Object.keys(pat.rolls || {})) { const src = pat.rolls[id]; pat.rolls[id] = Array.from({ length: n }, (_, i) => src[i % old] || 0); }
    pat.bars = bars;
  }

  /* ---------- lengths ---------- */
  const notesEnd = (pat) => (pat.notes || []).reduce((a, n) => Math.max(a, n.start + n.len), 0);
  /* A pattern's loop length in beats: its bar count, grown to fit its notes. */
  function patternBeats(pat) {
    if (!pat) return 4;
    if ('audio' in pat) return pat.audio ? Math.max(0.25, pat.audio.beats || 0) : 4;
    return Math.max(pat.bars, Math.ceil(notesEnd(pat) / 4 - 1e-6)) * 4;
  }
  /* Song length in beats: up to the end of the last clip, whole bars. */
  function songBeats(p) {
    const end = p.clips.reduce((a, c) => Math.max(a, c.start + c.len), 0);
    return Math.max(4, Math.ceil(end / 4 - 1e-6) * 4);
  }
  /* A take's length in beats follows the tempo (audio is not stretched): call after the tempo or a trim changes. */
  function syncAudio(p) {
    for (const x of p.patterns) if (x.audio) x.audio.beats = Math.round(((x.audio.end - x.audio.start) * p.bpm) / 60 * 10000) / 10000;
  }
  const isAudio = (pat) => !!pat && 'audio' in pat;
  const snapBeats = (p) => (p.snap ? 4 / p.snap : 0);

  /* The part that loops: the playlist's loop region in song mode, otherwise everything. */
  function loopRange(p, mode, length) {
    const r = p.region;
    if (mode === 'song' && r && r.end > r.start) return { start: r.start, end: r.end };
    return { start: 0, end: length };
  }

  /* ---------- automation ----------
     track.auto[param] = [{b: beat, v: 0..1}] sorted by beat; a line through the points, flat before the first
     and after the last. Only the song timeline uses it; Pattern mode plays the track's own settings. */
  function autoValue(pts, b) {
    if (!pts || !pts.length) return null;
    if (b <= pts[0].b) return pts[0].v;
    for (let i = 1; i < pts.length; i++) {
      if (b < pts[i].b) {
        const a = pts[i - 1], z = pts[i];
        return a.v + ((z.v - a.v) * (b - a.b)) / (z.b - a.b);
      }
    }
    return pts[pts.length - 1].v;
  }
  const autoParams = (t) => Object.keys(t.auto || {}).filter((k) => t.auto[k] && t.auto[k].length);
  function sortAuto(pts) { pts.sort((a, b) => a.b - b.b || a.v - b.v); return pts; }

  /* ---------- tempo changes ----------
     p.tempo = [{b, bpm}] sorted by beat, every b > 0: from beat b on the song plays at bpm, until the next change.
     Before the first one it plays at p.bpm. Like automation, only the song timeline uses them; Pattern mode
     always plays at p.bpm. Notes and clips live in beats, so they follow; audio takes keep their own speed. */
  const tempoList = (p, mode) => (mode === 'song' && p.tempo && p.tempo.length ? p.tempo : null);
  function tempoAt(p, b, mode) {
    let bpm = p.bpm;
    for (const c of tempoList(p, mode) || []) { if (c.b <= b + 1e-6) bpm = c.bpm; else break; }
    return bpm;
  }
  /* the beat of the first change after b, or Infinity */
  function nextTempo(p, b, mode) {
    for (const c of tempoList(p, mode) || []) if (c.b > b + 1e-6) return c.b;
    return Infinity;
  }
  /* song beats <-> seconds from the song start */
  function tempoMap(p, mode) {
    const seg = [{ b: 0, s: 0, bpm: p.bpm }];
    for (const c of tempoList(p, mode) || []) {
      const z = seg[seg.length - 1];
      if (c.b <= z.b) { z.bpm = c.bpm; continue; }
      seg.push({ b: c.b, s: z.s + ((c.b - z.b) * 60) / z.bpm, bpm: c.bpm });
    }
    const by = (key, v) => { let i = seg.length - 1; while (i > 0 && seg[i][key] > v) i--; return seg[i]; };
    return {
      seg,
      sec: (b) => { const z = by('b', b); return z.s + ((b - z.b) * 60) / z.bpm; },
      beat: (s) => { const z = by('s', s); return z.b + ((s - z.s) * z.bpm) / 60; },
    };
  }
  const songSecs = (p, mode, beats) => tempoMap(p, mode).sec(beats);
  function sortTempo(p) {
    // one change per beat: the later one in the list wins
    const m = new Map();
    for (const c of p.tempo) m.set(c.b, c);
    p.tempo = [...m.values()].sort((a, z) => a.b - z.b);
    return p.tempo;
  }

  function addMarker(p, beat, name) {
    const m = { id: p.nextId++, beat: Math.max(0, beat), name: (name || 'Marker').slice(0, 40) };
    p.markers.push(m);
    p.markers.sort((a, b) => a.beat - b.beat);
    return m;
  }

  /* What plays: [{track, pattern, start, len}] in beats, plus the loop length. */
  function playItems(p, mode) {
    if (mode === 'pattern') {
      const pat = selPattern(p);
      return { items: pat ? [{ track: track(p, pat.trackId), pattern: pat, start: 0, len: patternBeats(pat) }] : [], length: patternBeats(pat) };
    }
    const items = [];
    for (const c of p.clips) {
      const t = track(p, c.trackId), pat = pattern(p, c.patternId);
      if (t && pat) items.push({ track: t, pattern: pat, start: c.start, len: c.len, off: clipOff(p, c), clip: c });
    }
    return { items, length: songBeats(p) };
  }
  const audible = (p, t) => !t.mute && (!p.tracks.some((x) => x.solo) || t.solo);

  /* Slide notes glide in from the note before them: the latest one that starts earlier (the highest, if several
     start together). The first note of a pattern slides from the last one, as the pattern loops. null: no slides. */
  function slideFrom(pat) {
    if (!pat.notes.some((n) => n.slide)) return null;
    const out = new Map(), ns = pat.notes.slice().sort((a, b) => a.start - b.start || a.pitch - b.pitch);
    for (const n of ns) {
      if (!n.slide) continue;
      let prev = null;
      for (const m of ns) if (m.start < n.start - 1e-7) prev = m;
      if (!prev) { const last = ns[ns.length - 1]; if (last !== n && last.start > n.start + 1e-7) prev = last; }
      if (prev) out.set(n, prev.pitch);
    }
    return out;
  }

  /* Calls fn(event) for every note/hit of the items that starts in [lo, hi) song beats.
     event: {track, pattern, item, kind:'note'|'drum', at (beats), len (beats), pitch | drum, vel} */
  function eventsIn(p, items, lo, hi, fn, opt = {}) {
    const EPS = 1e-7;
    for (const it of items) {
      const t = it.track, pat = it.pattern;
      if (!audible(p, t) || (opt.skipTrack && opt.skipTrack === t.id)) continue;
      const a = Math.max(lo, it.start), b = Math.min(hi, it.start + it.len);
      if (b <= a + EPS) continue;
      const L = patternBeats(pat), clipEnd = it.start + it.len, off = it.off || 0;
      // org: the song beat where the pattern (or take) itself would begin; the clip shows it from `off` on
      const org = it.start - off;
      if (t.type === 'audio') {
        // a take plays once from the clip start (from `off` into it); the clip can cut it short. catchUp: also one already under way at lo
        if (!pat.audio) continue;
        const end = it.start + Math.min(it.len, L - off);
        if (end <= it.start + EPS) continue;
        if (it.start >= lo - EPS && it.start < hi - EPS) fn({ track: t, pattern: pat, item: it, kind: 'audio', at: it.start, len: end - it.start, offset: off });
        else if (opt.catchUp && it.start < lo - EPS && end > lo + 0.01) fn({ track: t, pattern: pat, item: it, kind: 'audio', at: lo, len: end - lo, offset: off + lo - it.start });
      } else if (t.type === 'drums') {
        const N = pat.bars * STEPS_PER_BAR;
        const anySolo = t.kit.some((k) => k.solo);
        // same window rule as notes: include at >= a - EPS, exclude at >= b - EPS, so windows never overlap or leave gaps
        for (let s = Math.ceil((a - org - EPS) * 4); (org + s / 4) < b - EPS; s++) {
          const local = ((s % N) + N) % N;
          const at = org + s / 4 + (local % 2 ? (t.swing || 0) * 0.125 : 0);
          for (const k of t.kit) {
            const v = (pat.steps[k.id] || [])[local];
            if (!v || k.mute || (anySolo && !k.solo)) continue;
            const r = pat.rolls && pat.rolls[k.id] ? pat.rolls[k.id][local] || 0 : 0;
            if (r > 1) {
              // a roll: r even hits inside the step, the later ones a little softer
              for (let j = 0; j < r; j++) {
                const aj = at + (j * 0.25) / r;
                if (aj >= clipEnd - EPS) break;
                fn({ track: t, pattern: pat, item: it, kind: 'drum', at: aj, len: 0.2 / r, drum: k.id, vel: j ? Math.max(1, Math.round(v * 0.8)) : v, gain: k.vol });
              }
            } else fn({ track: t, pattern: pat, item: it, kind: 'drum', at, len: 0.2, drum: k.id, vel: v, gain: k.vol });
          }
        }
      } else {
        const k0 = Math.floor((a - org) / L), k1 = Math.floor((b - org - EPS) / L);
        const from = slideFrom(pat);
        for (let k = k0; k <= k1; k++) {
          const base = org + k * L;
          for (const n of pat.notes) {
            const at = base + n.start;
            if (at < a - EPS || at >= b - EPS || at >= clipEnd - EPS) continue;
            const ev = { track: t, pattern: pat, item: it, kind: 'note', at, len: Math.min(n.len, clipEnd - at), pitch: n.pitch, vel: n.vel };
            if (from && from.has(n)) ev.glideFrom = from.get(n);
            fn(ev);
          }
        }
      }
    }
  }

  /* ---------- defaults ---------- */
  function shell() {
    return {
      version: 2, name: 'Untitled', bpm: 120, root: 0, scale: 'major', snap: 16, loop: true, click: false, mode: 'pattern',
      capture: { detail: 0.5, fixTuning: true, playBeat: false, mode: 'melody' },
      master: 0.85, loud: 0, region: null, markers: [], tempo: [], tempoOpen: false,
      tracks: [], patterns: [], clips: [], sel: { trackId: 0, patternId: 0 }, nextId: 1,
    };
  }

  function blank() {
    const p = shell();
    const mel = addTrack(p, 'synth', { name: 'Melody' });
    addTrack(p, 'drums', { name: 'Drums' });
    select(p, mel.id);
    return p;
  }

  function example() {
    const p = shell();
    Object.assign(p, { name: 'Example', bpm: 124, root: 9, scale: 'minor', mode: 'song' });
    const drums = addTrack(p, 'drums', { name: 'Drums', color: '#58d6c5' });
    const bass = addTrack(p, 'synth', { name: 'Bass', instrument: 'bass', echo: false, color: '#a58bff' });
    const lead = addTrack(p, 'synth', { name: 'Lead', instrument: 'pluck', color: '#ffb04f' });

    const beat = patternsOf(p, drums.id)[0];
    beat.name = 'House';
    applyPreset(p, beat, 'house');
    const fill = addPattern(p, drums.id, 'Fill');
    applyPreset(p, fill, 'fill');

    const bl = patternsOf(p, bass.id)[0];
    bl.name = 'Bassline';
    const bassNotes = [[33, 0, .5], [33, .75, .25], [45, 1.5, .5], [33, 2, .5], [33, 2.75, .25], [36, 3.5, .5],
      [29, 4, .5], [29, 4.75, .25], [41, 5.5, .5], [31, 6, .5], [31, 6.75, .25], [43, 7.5, .5]];
    bl.notes = bassNotes.map(([pitch, start, len]) => ({ id: p.nextId++, start, len, pitch, vel: 100 }));

    const hook = patternsOf(p, lead.id)[0];
    hook.name = 'Hook';
    const ex = [[57, 0, .5], [60, .5, .5], [64, 1, .5], [69, 1.5, 1], [67, 2.5, .5], [64, 3, .75], [65, 4, .5], [64, 4.5, .5], [60, 5, .5], [62, 5.5, 1], [64, 6.5, .5], [57, 7, 1]];
    hook.notes = ex.map(([pitch, start, len], i) => ({ id: p.nextId++, start, len, pitch, vel: [96, 84, 110][i % 3] }));

    addClip(p, beat, 0, 28);
    addClip(p, fill, 28, 4);
    addClip(p, bl, 8, 24);
    addClip(p, hook, 16, 16);
    addMarker(p, 0, 'Intro');
    addMarker(p, 16, 'Hook');
    bass.pan = -0.1; lead.pan = 0.15;
    select(p, lead.id, hook.id);
    return p;
  }

  /* ---------- validation / migration ---------- */
  const num = (v, d, lo, hi) => { v = +v; if (!isFinite(v)) return d; return Math.max(lo, Math.min(hi, v)); };
  const str = (v, d, max = 60) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : d);

  function normNotes(list, p) {
    return (Array.isArray(list) ? list : []).slice(0, 5000).map((n) => ({
      id: p.nextId++,
      start: num(n && n.start, 0, 0, 100000),
      len: num(n && n.len, 1, 1 / 64, 10000),
      pitch: num(n && n.pitch, 60, 0, 127) | 0,
      vel: num(n && n.vel, 100, 1, 127) | 0,
      ...(n && n.slide ? { slide: true } : {}), // glide in from the note before
    }));
  }

  function normAuto(a) {
    const out = {};
    if (!a || typeof a !== 'object') return out;
    for (const prm of BDJ.Sound.PARAMS) {
      const list = Array.isArray(a[prm.id]) ? a[prm.id] : [];
      const pts = list.slice(0, 2000).filter((x) => x && isFinite(+x.b) && isFinite(+x.v))
        .map((x) => ({ b: num(x.b, 0, 0, 100000), v: num(x.v, prm.def, 0, 1) }));
      if (pts.length) out[prm.id] = sortAuto(pts);
    }
    return out;
  }

  /* Version 1 had one melody and one drum loop; turn them into two tracks with a clip each. */
  function migrateV1(o) {
    const p = shell();
    const m = o.melody || {}, d = o.drums || {};
    const mel = addTrack(p, 'synth', { name: 'Melody', instrument: m.instrument, echo: m.echo });
    Object.assign(mel, { volume: m.volume, mute: m.mute });
    const dr = addTrack(p, 'drums', { name: 'Drums' });
    Object.assign(dr, { volume: d.volume, mute: d.mute, swing: d.swing });
    const rows = Array.isArray(d.rows) ? d.rows : [];
    dr.kit = dr.kit.map((k) => { const r = rows.find((x) => x && x.id === k.id) || {}; return { id: k.id, vol: r.vol, mute: r.mute, solo: r.solo }; });
    const mp = patternsOf(p, mel.id)[0];
    Object.assign(mp, { name: 'Melody', notes: m.notes || [], fromTake: m.fromTake, takeOctave: m.takeOctave, bars: o.bars });
    const dp = patternsOf(p, dr.id)[0];
    Object.assign(dp, { name: 'Beat', bars: d.bars });
    dp.steps = Object.fromEntries(rows.filter((r) => r && r.id).map((r) => [r.id, r.steps]));
    const songLen = Math.max(num(o.bars, 4, 1, 128), Math.ceil(notesEnd({ notes: (m.notes || []).map((n) => ({ start: +n.start || 0, len: +n.len || 0 })) }) / 4 - 1e-6)) * 4;
    p.clips = [
      { id: p.nextId++, trackId: mel.id, patternId: mp.id, start: 0, len: songLen },
      { id: p.nextId++, trackId: dr.id, patternId: dp.id, start: 0, len: songLen },
    ];
    for (const k of ['name', 'bpm', 'root', 'scale', 'snap', 'loop', 'click', 'capture']) p[k] = o[k];
    p.mode = 'song';
    p.sel = { trackId: mel.id, patternId: mp.id };
    return p;
  }

  function normalize(obj) {
    if (!obj || typeof obj !== 'object') return blank();
    const o = obj.version === 2 || Array.isArray(obj.tracks) ? obj : migrateV1(obj);
    const p = shell();
    p.name = str(o.name, 'Untitled', 80);
    // which "My songs" entry this is (the app gives songs from elsewhere a fresh one)
    p.songId = typeof o.songId === 'string' && /^s[a-z0-9]{6,30}$/.test(o.songId) ? o.songId : null;
    p.bpm = num(o.bpm, 120, 40, 240);
    p.root = num(o.root, 0, 0, 11) | 0;
    p.scale = E.SCALES[o.scale] ? o.scale : 'major';
    p.snap = [0, 4, 8, 16, 32].includes(+o.snap) ? +o.snap : 16;
    p.loop = o.loop !== false;
    p.click = !!o.click;
    p.mode = o.mode === 'song' ? 'song' : 'pattern';
    const c = o.capture || {};
    p.capture = { detail: num(c.detail, 0.5, 0, 1), fixTuning: c.fixTuning !== false, playBeat: !!c.playBeat, mode: c.mode === 'drums' ? 'drums' : 'melody' };
    p.master = num(o.master, 0.85, 0, 1);
    p.loud = num(o.loud, 0, 0, 1);
    if (o.region && isFinite(+o.region.start) && isFinite(+o.region.end) && +o.region.end - +o.region.start >= 0.25) {
      p.region = { start: num(o.region.start, 0, 0, 100000), end: num(o.region.end, 4, 0.25, 100000) };
    }
    p.markers = (Array.isArray(o.markers) ? o.markers : []).slice(0, 200)
      .filter((m) => m && isFinite(+m.beat))
      .map((m) => ({ id: p.nextId++, beat: num(m.beat, 0, 0, 100000), name: str(m.name, 'Marker', 40) }))
      .sort((a, b) => a.beat - b.beat);
    p.tempo = (Array.isArray(o.tempo) ? o.tempo : []).slice(0, 256)
      .filter((c) => c && isFinite(+c.b) && +c.b > 0 && isFinite(+c.bpm))
      .map((c) => ({ b: Math.round(num(c.b, 4, 0, 100000) * 1000) / 1000, bpm: Math.round(num(c.bpm, 120, 40, 240) * 100) / 100 }));
    sortTempo(p);
    p.tempoOpen = !!o.tempoOpen;

    // ids are renumbered; keep maps from the old ones
    const tMap = new Map(), pMap = new Map();
    for (const t of (Array.isArray(o.tracks) ? o.tracks : []).slice(0, 32)) {
      if (!t || (t.type !== 'synth' && t.type !== 'drums' && t.type !== 'audio')) continue;
      const nt = {
        id: p.nextId++, type: t.type, name: str(t.name, { drums: 'Drums', audio: 'Audio' }[t.type] || 'Synth'),
        color: /^#[0-9a-f]{6}$/i.test(t.color) ? t.color : nextColor(p),
        volume: num(t.volume, 0.8, 0, 1), pan: num(t.pan, 0, -1, 1), drive: num(t.drive, 0, 0, 1), filter: num(t.filter, 0.5, 0, 1),
        reverb: num(t.reverb, 0, 0, 1), pump: num(t.pump, 0, 0, 1),
        mute: !!t.mute, solo: !!t.solo,
        auto: normAuto(t.auto), autoOpen: !!t.autoOpen,
        autoParam: BDJ.Sound.PARAMS.some((x) => x.id === t.autoParam) ? t.autoParam : 'volume',
        // older saves had echo on/off for synths
        echoSend: t.echoSend != null ? num(t.echoSend, 0, 0, 1) : t.type === 'synth' && t.echo !== false ? 1 : 0,
      };
      // EQ in dB, only kept when something is boosted or cut
      if (t.eq && typeof t.eq === 'object') {
        const eq = {};
        for (const b of ['low', 'mid', 'high']) { const g = Math.round(num(t.eq[b], 0, -12, 12) * 2) / 2; if (g) eq[b] = g; }
        if (Object.keys(eq).length) nt.eq = eq;
      }
      if (t.type === 'drums') {
        nt.swing = num(t.swing, 0, 0, 0.6);
        nt.kitStyle = BDJ.Sound.KITS.some((x) => x.id === t.kitStyle) ? t.kitStyle : 'classic';
        const k = Array.isArray(t.kit) ? t.kit : [];
        nt.kit = kit().map((d) => {
          const r = k.find((x) => x && x.id === d.id) || {};
          const row = { id: d.id, vol: num(r.vol, 0.8, 0, 1), mute: !!r.mute, solo: !!r.solo };
          // your own sound: a reference into the browser's sample store
          if (r.sample && /^[0-9a-f]{8,64}$/.test(r.sample.hash)) row.sample = { hash: r.sample.hash, name: str(r.sample.name, 'sample', 120) };
          return row;
        });
      } else if (t.type === 'synth') {
        nt.instrument = BDJ.Sound.INSTRUMENTS.some((i) => i.id === t.instrument) ? t.instrument : 'pluck';
        const sh = t.shape || {};
        nt.shape = { attack: num(sh.attack, 0, 0, 1), release: num(sh.release, 0, 0, 1), tone: num(sh.tone, 0.5, 0, 1), glide: num(sh.glide, 0.3, 0, 1) };
        // movement: a tempo-synced LFO on the filter, volume or pan
        const lf = t.lfo || {};
        nt.lfo = { target: BDJ.Sound.LFO_TARGETS.includes(lf.target) ? lf.target : 'off', rate: BDJ.Sound.LFO_RATES[lf.rate] ? lf.rate : '1/8', depth: num(lf.depth, 0.6, 0, 1) };
        // the Sampler's sound: a reference into the browser's sample store, the note it was recorded at, a level fix
        const sm = t.sampler;
        if (sm && /^[0-9a-f]{8,64}$/.test(sm.hash)) nt.sampler = { hash: sm.hash, name: str(sm.name, 'sound', 120), root: num(sm.root, 60, 0, 127), gain: num(sm.gain, 1, 0.05, 20) };
      }
      tMap.set(t.id, nt);
      p.tracks.push(nt);
    }
    for (const x of (Array.isArray(o.patterns) ? o.patterns : []).slice(0, 512)) {
      const t = x && tMap.get(x.trackId);
      if (!t) continue;
      const np = { id: p.nextId++, trackId: t.id, name: str(x.name, t.type === 'audio' ? 'Take' : 'Pattern') };
      if (t.type === 'audio') {
        // a recording: a reference into the browser's sample store, the part that plays (seconds) and a level fix
        const au = x.audio;
        if (au && /^[0-9a-f]{8,64}$/.test(au.hash)) {
          const secs = num(au.secs, 1, 0.01, 3600), start = num(au.start, 0, 0, secs - 0.01);
          np.audio = { hash: au.hash, name: str(au.name, 'recording', 120), secs, start, end: num(au.end, secs, start + 0.01, secs), gain: num(au.gain, 1, 0, 8) };
        } else np.audio = null;
      } else if (t.type === 'drums') {
        np.bars = num(x.bars, 1, 1, 8) | 0;
        const n = np.bars * STEPS_PER_BAR, st = x.steps && typeof x.steps === 'object' ? x.steps : {};
        np.steps = Object.fromEntries(BDJ.Sound.DRUMS.map((d) => [d.id, Array.from({ length: n }, (_, i) => num((st[d.id] || [])[i], 0, 0, 127) | 0)]));
        // rolls: 2, 3 or 4 hits in a step; kept only for rows that have one
        const ro = x.rolls && typeof x.rolls === 'object' ? x.rolls : {};
        for (const d of BDJ.Sound.DRUMS) {
          if (!Array.isArray(ro[d.id])) continue;
          const row = Array.from({ length: n }, (_, i) => ([2, 3, 4].includes(+ro[d.id][i]) ? +ro[d.id][i] : 0));
          if (row.some((v) => v)) (np.rolls = np.rolls || {})[d.id] = row;
        }
      } else {
        np.bars = num(x.bars, 2, 1, 128) | 0;
        np.notes = normNotes(x.notes, p);
        np.fromTake = !!x.fromTake;
        np.takeOctave = num(x.takeOctave, 0, -4, 4) | 0;
      }
      pMap.set(x.id, np);
      p.patterns.push(np);
    }
    if (!p.tracks.length) return blank();
    for (const t of p.tracks) if (!patternsOf(p, t.id).length) addPattern(p, t.id);
    for (const c of (Array.isArray(o.clips) ? o.clips : []).slice(0, 4000)) {
      const pat = c && pMap.get(c.patternId);
      if (!pat) continue;
      const nc = { id: p.nextId++, trackId: pat.trackId, patternId: pat.id, start: num(c.start, 0, 0, 100000), len: num(c.len, 4, 0.25, 100000) };
      const off = Math.round(num(c.off, 0, 0, 100000) * 10000) / 10000;
      if (off) nc.off = off;
      p.clips.push(nc);
    }
    syncAudio(p);
    const sel = o.sel || {};
    const st = tMap.get(sel.trackId) || p.tracks[0], sp = pMap.get(sel.patternId);
    select(p, st.id, sp && sp.trackId === st.id ? sp.id : undefined);
    return p;
  }

  const serialize = (p) => JSON.stringify(p);

  /* ---------- hum take -> notes ---------- */
  /* take: {raw, tuning, anchor?, tempo?}; returns {notes (beats), shift (s)} */
  function deriveFromTake(p, pat, take) {
    const fin = E.finalize(take.raw, {
      root: p.root, scale: p.scale, fixTuning: p.capture.fixTuning, tuning: take.tuning,
      bpm: take.tempo || p.bpm, grid: p.snap, octave: pat.takeOctave || 0, anchor: take.anchor,
    }, new Map());
    // a take recorded over the song is read at the tempo where it was recorded
    const k = (take.tempo || p.bpm) / 60, r = (v) => Math.round(v * 10000) / 10000;
    const notes = fin.notes.map((n) => ({
      id: p.nextId++, start: r(n.start * k), len: Math.max(1 / 64, r((n.end - n.start) * k)), pitch: n.pitch, vel: n.vel,
    }));
    return { notes, shift: fin.shift };
  }

  function detectKey(p, take) {
    const pat = selPattern(p);
    if (take && pat && pat.fromTake && take.patternId === pat.id) return E.detectKey(take.raw, p.capture.fixTuning ? take.tuning : 0);
    // all synth notes in the project, drums excluded
    const notes = [];
    for (const x of p.patterns) if (x.notes) for (const n of x.notes) notes.push({ midi: n.pitch, start: n.start, end: n.start + n.len });
    return E.detectKey(notes, 0);
  }

  /* ---------- export ---------- */
  function midiTracks(p, mode) {
    const { items, length } = playItems(p, mode);
    const out = [];
    let ch = 0;
    for (const t of p.tracks) {
      if (t.type === 'audio') continue; // recordings are not notes
      const notes = [];
      eventsIn(p, items.filter((it) => it.track === t), 0, length, (ev) => {
        notes.push(ev.kind === 'note'
          ? { start: ev.at, len: ev.len, pitch: ev.pitch, vel: ev.vel }
          : { start: ev.at, len: 0.2, pitch: BDJ.Sound.DRUMS.find((d) => d.id === ev.drum).gm, vel: Math.max(1, Math.round(ev.vel * (0.4 + 0.6 * ev.gain))) });
      });
      if (!notes.length) continue;
      const controllers = [{ cc: 7, value: t.volume * 127 }, { cc: 10, value: 64 + (t.pan || 0) * 63 }, { cc: 91, value: (t.reverb || 0) * 127 }];
      // song automation as controller changes: volume CC7, pan CC10, filter CC74, echo CC91
      const ccEvents = [];
      if (mode === 'song') {
        // the General MIDI way: 91 is the reverb send; echo goes on 94 (often used for delay)
        const CC = { volume: 7, pan: 10, filter: 74, reverb: 91, echo: 94 };
        for (const id of autoParams(t)) {
          if (!CC[id]) continue;
          let last = -1;
          for (let b = 0; b <= length + 1e-9; b += 0.125) {
            const val = Math.round(autoValue(t.auto[id], b) * 127);
            if (val !== last) { ccEvents.push({ beat: b, cc: CC[id], value: val }); last = val; }
          }
        }
      }
      if (t.type === 'drums') { out.push({ name: t.name, channel: 9, notes, controllers, ccEvents }); continue; }
      const inst = BDJ.Sound.INSTRUMENTS.find((i) => i.id === t.instrument);
      out.push({ name: t.name, channel: ch, program: inst ? inst.program : 0, notes, controllers, ccEvents });
      ch = ch + 1 === 9 ? 10 : (ch + 1) % 16;
    }
    return out;
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
    STEPS_PER_BAR, PRESETS, COLORS,
    track, pattern, patternsOf, selTrack, selPattern, select,
    blank, example, normalize, serialize,
    addTrack, addPattern, clonePattern, deletePattern, deleteTrack, addClip, uniqueName,
    applyPreset, setDrumBars, clipOff, splitClip, notesEnd, patternBeats, syncAudio, isAudio, songBeats, snapBeats, playItems, eventsIn, audible, loopRange, addMarker, tempoAt, nextTempo, tempoMap, songSecs, sortTempo, autoValue, autoParams, sortAuto,
    deriveFromTake, detectKey, midiTracks, History, slideFrom,
  };
})();
