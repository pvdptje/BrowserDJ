/* BrowserDJ.agent: a small, stable way for an AI agent (or anyone at the browser console) to make a song in the
   open page, while the person watches it appear. No server: the agent runs JavaScript in this tab.
   Start with  BrowserDJ.agent.help().
   Every change is one undo step and says what it did in the status line. Bars count from 1, like the ruler;
   positions inside a pattern are in beats from 0. listen() renders the song offline and measures it, because an
   agent cannot hear: loudness per section, peak, quiet gaps.
   The pure helpers (note and chord names, note lists, drum step strings, analysis) also run in Node (tests). */
(function (root) {
  'use strict';
  root.BDJ = root.BDJ || {};
  const BDJ = root.BDJ;
  // the hum engine is a plain global in the page (and on globalThis in Node)
  const HE = () => (typeof HumEngine !== 'undefined' ? HumEngine : root.HumEngine);

  /* ---------- music shorthand ---------- */
  const PC = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
  const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  const fail = (msg) => { throw new Error('BrowserDJ.agent: ' + msg); };
  const num = (v, what, lo, hi) => {
    if (typeof v !== 'number' || !isFinite(v)) fail(what + ' must be a number, got ' + JSON.stringify(v));
    if (v < lo || v > hi) fail(what + ' must be between ' + lo + ' and ' + hi + ', got ' + v);
    return v;
  };
  const pitchClass = (s) => {
    const m = /^([A-Ga-g])([#b]?)$/.exec(s);
    if (!m) return null;
    return (PC[m[1].toUpperCase()] + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0) + 12) % 12;
  };
  /* 'C4' = 60 (middle C), 'F#2', 'Bb3'; a number is a MIDI pitch already */
  function note(x) {
    if (typeof x === 'number') { if (!Number.isInteger(x) || x < 0 || x > 127) fail('a pitch number must be a whole number 0..127, got ' + x); return x; }
    const m = /^\s*([A-Ga-g][#b]?)(-?\d)\s*$/.exec(String(x));
    if (!m) fail('not a note name: ' + JSON.stringify(x) + ' (write it like C4, F#2 or Bb3; C4 is middle C = 60)');
    const p = pitchClass(m[1]) + (+m[2] + 1) * 12 + (/^[Cc]b/.test(m[1]) ? 12 : /^[Bb]#/.test(m[1]) ? -12 : 0);
    if (p < 0 || p > 127) fail('note out of range: ' + x);
    return p;
  }
  const noteName = (p) => NAMES[p % 12] + (Math.floor(p / 12) - 1);

  // chord qualities as intervals from the root
  const QUAL = {
    '': [0, 4, 7], maj: [0, 4, 7], M: [0, 4, 7], m: [0, 3, 7], min: [0, 3, 7], dim: [0, 3, 6], aug: [0, 4, 8], '+': [0, 4, 8],
    sus2: [0, 2, 7], sus4: [0, 5, 7], sus: [0, 5, 7], 5: [0, 7], 6: [0, 4, 7, 9], m6: [0, 3, 7, 9],
    7: [0, 4, 7, 10], maj7: [0, 4, 7, 11], M7: [0, 4, 7, 11], m7: [0, 3, 7, 10], m7b5: [0, 3, 6, 10], dim7: [0, 3, 6, 9], mmaj7: [0, 3, 7, 11],
    add9: [0, 4, 7, 14], madd9: [0, 3, 7, 14], 9: [0, 4, 7, 10, 14], maj9: [0, 4, 7, 11, 14], m9: [0, 3, 7, 10, 14], '7sus4': [0, 5, 7, 10],
  };
  /* 'Am7' -> [57, 60, 64, 67] (root in the given octave, default 3), 'G/B' puts B in the bass below */
  function chord(name, octave = 3) {
    const m = /^\s*([A-G][#b]?)([A-Za-z0-9+#]*?)(?:\/([A-G][#b]?))?\s*$/.exec(String(name));
    if (!m || !(m[2] in QUAL)) fail('not a chord name: ' + JSON.stringify(name) + ' (try C, Am, F#m7, Bbmaj7, Dsus4, G7, E5, C/E; qualities: ' + Object.keys(QUAL).filter(Boolean).join(' ') + ')');
    num(octave, 'octave', 0, 8);
    const r = pitchClass(m[1]) + (octave + 1) * 12;
    const out = QUAL[m[2]].map((i) => r + i);
    if (m[3]) { let b = pitchClass(m[3]) + (octave + 1) * 12; while (b >= out[0]) b -= 12; out.unshift(b); }
    return out;
  }
  const chords = (list, octave = 3) => (Array.isArray(list) ? list : String(list).trim().split(/[\s,|]+/)).map((c) => chord(c, octave));

  /* Notes: an array of [pitch, start, len, vel?] or {pitch, start, len, vel?, chance?, slide?}, or a string
     "C4 0 1, E4 1 0.5 90; G4 1.5 0.5". start and len are in beats from the start of the pattern. */
  function parseNotes(input) {
    let list = input;
    if (typeof input === 'string') {
      list = input.split(/[,;\n]+/).map((s) => s.trim()).filter(Boolean).map((s) => {
        const t = s.split(/\s+/);
        if (t.length < 3 || t.length > 4) fail('a note in a string is "pitch start len [vel]", got ' + JSON.stringify(s));
        return [t[0], +t[1], +t[2], t[3] == null ? undefined : +t[3]];
      });
    }
    if (!Array.isArray(list)) fail('notes must be an array or a string');
    return list.map((n, i) => {
      const o = Array.isArray(n) ? { pitch: n[0], start: n[1], len: n[2], vel: n[3] } : n && typeof n === 'object' ? n : fail('note ' + i + ' is not [pitch, start, len, vel] or an object');
      const at = 'note ' + i + ' (' + JSON.stringify(n) + ')';
      const out = {
        pitch: (() => { try { return note(o.pitch); } catch (e) { return fail(at + ': ' + e.message.replace(/^BrowserDJ\.agent: /, '')); } })(),
        start: num(o.start, at + ' start', 0, 4096),
        len: num(o.len, at + ' len', 1 / 64, 1024),
        vel: o.vel == null ? 100 : Math.round(num(o.vel, at + ' vel', 1, 127)),
      };
      if (o.chance != null && o.chance < 100) out.chance = Math.round(num(o.chance, at + ' chance', 1, 100));
      if (o.slide) out.slide = true;
      return out;
    });
  }

  /* Drum steps: one character per 16th note, spaces and | are ignored so a bar can be written "x... o... x... o...".
     . or - rest, g ghost (40), o soft (62), x hit (100), X accent (124). A shorter row repeats to fill the pattern.
     Chance rows use digits: 1..9 = 10%..90% (. = always). */
  const VEL = { '.': 0, '-': 0, g: 40, o: 62, x: 100, X: 124 };
  function rowOf(str, len, what, map) {
    const s = String(str).replace(/[\s|]/g, '');
    if (!s.length) fail(what + ' is empty');
    if (len % s.length) fail(what + ' has ' + s.length + ' steps, which does not fit ' + len + ' (one character per 16th: 16 per bar)');
    return Array.from({ length: len }, (_, i) => {
      const c = s[i % s.length];
      if (!(c in map)) fail(what + ': unknown step "' + c + '" (use ' + Object.keys(map).join(' ') + ')');
      return map[c];
    });
  }
  const CHANCE = { '.': 0, '-': 0, 1: 10, 2: 20, 3: 30, 4: 40, 5: 50, 6: 60, 7: 70, 8: 80, 9: 90 };
  function parseSteps(rows, bars, chance) {
    const ids = BDJ.Sound.DRUMS.map((d) => d.id);
    if (!rows || typeof rows !== 'object') fail('steps must be an object like {kick: "x...x...", snare: "....x..."}');
    const len = bars * 16, steps = Object.fromEntries(ids.map((d) => [d, new Array(len).fill(0)]));
    for (const [k, s] of Object.entries(rows)) {
      if (!ids.includes(k)) fail('no drum called "' + k + '"; the kit has ' + ids.join(', '));
      steps[k] = rowOf(s, len, 'steps.' + k, VEL);
    }
    let ch = null;
    if (chance) {
      ch = {};
      for (const [k, s] of Object.entries(chance)) {
        if (!ids.includes(k)) fail('no drum called "' + k + '" in chance');
        const row = rowOf(s, len, 'chance.' + k, CHANCE);
        if (row.some((v) => v)) ch[k] = row;
      }
      if (!Object.keys(ch).length) ch = null;
    }
    return { steps, chance: ch };
  }
  const barsOfRows = (rows) => Math.max(1, ...Object.values(rows || {}).map((s) => Math.ceil(String(s).replace(/[\s|]/g, '').length / 16)));

  /* ---------- listening: numbers instead of ears ----------
     L, R: Float32Arrays; sections: [{name, from, to}] in seconds. Loudness is the mean square of the mid signal, in dB. */
  function analyze(L, R, sr, sections) {
    const db = (ms) => (ms > 1e-12 ? Math.round(10 * Math.log10(ms) * 10) / 10 : -120);
    let peak = 0, clipped = 0, all = 0;
    for (let i = 0; i < L.length; i++) {
      const a = Math.max(Math.abs(L[i]), Math.abs(R[i]));
      if (a > peak) peak = a;
      if (a >= 0.999) clipped++;
      const m = (L[i] + R[i]) / 2;
      all += m * m;
    }
    const range = (a, b) => {
      const i0 = Math.max(0, Math.round(a * sr)), i1 = Math.min(L.length, Math.round(b * sr));
      let s = 0, side = 0;
      for (let i = i0; i < i1; i++) { const m = (L[i] + R[i]) / 2, d = (L[i] - R[i]) / 2; s += m * m; side += d * d; }
      const n = Math.max(1, i1 - i0);
      return { db: db(s / n), width: db(side / n) - db(s / n) };
    };
    const perSecond = [];
    for (let t = 0; t + 1 <= L.length / sr + 1e-9; t++) perSecond.push(range(t, t + 1).db);
    return {
      seconds: Math.round((L.length / sr) * 10) / 10,
      peak: Math.round(peak * 1000) / 1000,
      clippedSamples: clipped,
      loudness: db(all / Math.max(1, L.length)),
      sections: sections.map((s) => { const r = range(s.from, s.to); return { name: s.name, bar: s.bar, db: r.db, stereoWidth: Math.round(r.width * 10) / 10 }; }),
      perSecond,
    };
  }

  /* ---------- the interface ----------
     host: { get(): project, edit(fn): one undo step on the live project, replace(project), render(opts): {buf},
             play(fromBeat), stop(), shareLink(): Promise<string>, undo(), say(text) } */
  function create(host) {
    const PJ = BDJ.Project, SND = BDJ.Sound;
    const INSTR = SND.INSTRUMENTS.filter((i) => i.id !== 'sampler').map((i) => i.id);
    const KITS = SND.KITS.map((k) => k.id);
    const AUTO = SND.PARAMS.map((x) => x.id);
    const placeholders = new Set(); // the starter tracks of newSong(), removed once the agent adds its own
    const starters = new Set(); // the empty pattern every new track comes with, used by its first addPattern
    const P = () => host.get();
    const findTrack = (id) => P().tracks.find((t) => t.id === id || t.name === id) || fail('no track ' + JSON.stringify(id) + '; tracks: ' + P().tracks.map((t) => t.id + ' "' + t.name + '"').join(', '));
    const findPattern = (id) => P().patterns.find((x) => x.id === id) || fail('no pattern ' + JSON.stringify(id) + ' (use the id addPattern returned)');
    const beatOf = (bar, what) => (num(bar, what, 1, 1025) - 1) * 4;
    const done = (text, value) => { host.say('Agent: ' + text); return value; };

    const TRACK_PROPS = {
      name: (t, v) => { t.name = String(v).slice(0, 40); },
      instrument: (t, v) => { if (t.type !== 'synth') fail('only a synth track has an instrument'); if (!INSTR.includes(v)) fail('no instrument "' + v + '"; pick one of ' + INSTR.join(', ')); t.instrument = v; },
      kit: (t, v) => { if (t.type !== 'drums') fail('only a drum track has a kit'); if (!KITS.includes(v)) fail('no kit "' + v + '"; pick one of ' + KITS.join(', ')); t.kitStyle = v; },
      volume: (t, v) => { t.volume = num(v, 'volume', 0, 1); },
      pan: (t, v) => { t.pan = num(v, 'pan', -1, 1); },
      reverb: (t, v) => { t.reverb = num(v, 'reverb', 0, 1); },
      echo: (t, v) => { t.echoSend = num(v, 'echo', 0, 1); },
      drive: (t, v) => { t.drive = num(v, 'drive', 0, 1); },
      filter: (t, v) => { t.filter = num(v, 'filter', 0, 1); },
      pump: (t, v) => { t.pump = num(v, 'pump', 0, 1); },
      swing: (t, v) => { t.swing = num(v, 'swing', 0, 0.6); },
      eq: (t, v) => { const e = {}; for (const [k, x] of Object.entries(v || {})) { if (!['low', 'mid', 'high'].includes(k)) fail('eq bands are low, mid, high'); e[k] = num(x, 'eq.' + k + ' (dB)', -12, 12); } t.eq = e; },
      shape: (t, v) => { if (t.type !== 'synth') fail('only a synth track has a shape'); for (const [k, x] of Object.entries(v || {})) { if (!(k in SND.SHAPE)) fail('shape has ' + Object.keys(SND.SHAPE).join(', ')); t.shape[k] = num(x, 'shape.' + k, 0, 1); } },
      movement: (t, v) => {
        if (t.type !== 'synth') fail('only a synth track has movement');
        const tg = SND.LFO_TARGETS, rt = Object.keys(SND.LFO_RATES);
        const o = { ...t.lfo, ...v };
        if (!tg.includes(o.target)) fail('movement.target is one of ' + tg.join(', '));
        if (!rt.includes(o.rate)) fail('movement.rate is one of ' + rt.join(', '));
        t.lfo = { target: o.target, rate: o.rate, depth: num(o.depth, 'movement.depth', 0, 1) };
      },
      mute: (t, v) => { t.mute = !!v; },
    };
    const setProps = (t, props) => {
      for (const [k, v] of Object.entries(props || {})) {
        if (k === 'type') continue;
        if (!TRACK_PROPS[k]) fail('a track has no "' + k + '"; you can set ' + Object.keys(TRACK_PROPS).join(', '));
        TRACK_PROPS[k](t, v);
      }
    };
    const fillPattern = (pat, t, spec) => {
      if (t.type === 'drums') {
        const bars = spec.bars != null ? Math.round(num(spec.bars, 'bars', 1, 4)) : Math.min(4, barsOfRows(spec.steps));
        const { steps, chance } = parseSteps(spec.steps || {}, bars, spec.chance);
        pat.bars = bars; pat.steps = steps;
        if (chance) pat.chance = chance; else delete pat.chance;
        delete pat.rolls;
      } else if (t.type === 'synth') {
        const ns = parseNotes(spec.notes || []);
        const end = ns.reduce((a, n) => Math.max(a, n.start + n.len), 0);
        const bars = spec.bars != null ? Math.round(num(spec.bars, 'bars', 1, 256)) : Math.max(1, Math.ceil(end / 4 - 1e-6));
        pat.bars = bars;
        pat.notes = ns.map((n) => ({ id: P().nextId++, ...n }));
        pat.fromTake = false;
      } else fail('an audio track holds recordings, not notes');
      if (spec.name) pat.name = String(spec.name).slice(0, 40);
    };

    const api = {
      version: 1,
      help: () => BDJ.Agent.HELP,

      /* ---- the song ---- */
      newSong({ name = 'Agent song', bpm = 120, key = 'C', scale = 'major' } = {}) {
        const root = pitchClass(key);
        if (root == null) fail('key is a note name like C, F# or Bb');
        if (!(scale in HE().SCALES)) fail('scale is one of ' + Object.keys(HE().SCALES).join(', '));
        const p = PJ.blank();
        Object.assign(p, { name: String(name).slice(0, 60), bpm: Math.round(num(bpm, 'bpm', 40, 300)), root, scale, mode: 'song', loop: false });
        host.replace(p);
        placeholders.clear();
        for (const t of P().tracks) placeholders.add(t.id); // after loading: ids are given out afresh
        return done('started "' + p.name + '" (' + p.bpm + ' BPM, ' + NAMES[root] + ' ' + scale + ').', api.info());
      },
      setSong(props = {}) {
        host.edit((p) => {
          for (const [k, v] of Object.entries(props)) {
            if (k === 'name') p.name = String(v).slice(0, 60);
            else if (k === 'bpm') p.bpm = Math.round(num(v, 'bpm', 40, 300));
            else if (k === 'key') { const r = pitchClass(v); if (r == null) fail('key is a note name'); p.root = r; }
            else if (k === 'scale') { if (!(v in HE().SCALES)) fail('scale is one of ' + Object.keys(HE().SCALES).join(', ')); p.scale = v; }
            else if (k === 'master') p.master = num(v, 'master', 0, 1);
            else fail('setSong takes name, bpm, key, scale, master');
          }
        });
        return done('song settings changed.', api.info());
      },
      info() {
        const p = P();
        return { name: p.name, bpm: p.bpm, key: NAMES[p.root], scale: p.scale, bars: PJ.songBeats(p) / 4,
          tracks: p.tracks.map((t) => ({ id: t.id, name: t.name, type: t.type, instrument: t.instrument, kit: t.kitStyle, patterns: PJ.patternsOf(p, t.id).map((x) => ({ id: x.id, name: x.name, bars: x.bars })) })),
          clips: p.clips.length, markers: p.markers.map((m) => ({ bar: m.beat / 4 + 1, name: m.name })) };
      },
      song: () => JSON.parse(PJ.serialize(P())),
      load(json) { host.replace(PJ.normalize(typeof json === 'string' ? JSON.parse(json) : json)); placeholders.clear(); return done('loaded "' + P().name + '".', api.info()); },

      /* ---- tracks ---- */
      addTrack(props = {}) {
        const type = props.type || 'synth';
        if (!['synth', 'drums'].includes(type)) fail('type is "synth" or "drums"');
        let id;
        host.edit((p) => {
          const t = PJ.addTrack(p, type, { name: props.name, instrument: type === 'synth' ? (INSTR.includes(props.instrument) ? props.instrument : 'pluck') : undefined });
          t.echoSend = 0;
          setProps(t, props);
          // its empty first pattern stays (the editor always shows one) and the track's first addPattern fills it
          for (const x of PJ.patternsOf(p, t.id)) starters.add(x.id);
          for (const ph of [...placeholders]) { const pt = p.tracks.find((x) => x.id === ph); if (!pt || p.clips.some((c) => c.trackId === ph)) { placeholders.delete(ph); continue; } PJ.deleteTrack(p, ph); placeholders.delete(ph); }
          PJ.select(p, t.id);
          id = t.id;
        });
        const t = findTrack(id);
        return done('added the track "' + t.name + '"' + (t.instrument ? ' (' + t.instrument + ')' : t.kitStyle ? ' (' + t.kitStyle + ' kit)' : '') + '.', id);
      },
      setTrack(id, props) { const tid = findTrack(id).id; host.edit((p) => setProps(p.tracks.find((t) => t.id === tid), props)); return done('changed the track "' + findTrack(tid).name + '".', tid); },
      removeTrack(id) {
        const tid = findTrack(id).id;
        if (P().tracks.length < 2) fail('a song keeps at least one track');
        host.edit((p) => PJ.deleteTrack(p, tid));
        return done('removed a track.', true);
      },

      /* ---- patterns ---- */
      addPattern(trackId, spec = {}) {
        const t = findTrack(trackId);
        let id;
        host.edit((p) => {
          const starter = PJ.patternsOf(p, t.id).find((x) => starters.has(x.id));
          const pat = starter || { id: p.nextId++, trackId: t.id, name: PJ.uniqueName(p, t.id, spec.name || 'Pattern') };
          if (starter) { starters.delete(starter.id); pat.name = 'Pattern'; }
          fillPattern(pat, t, spec);
          if (!starter) p.patterns.push(pat);
          p.sel = { trackId: t.id, patternId: pat.id };
          id = pat.id;
        });
        const pat = findPattern(id);
        return done('wrote "' + pat.name + '" on ' + t.name + ' (' + pat.bars + (pat.bars === 1 ? ' bar' : ' bars') + (pat.notes ? ', ' + pat.notes.length + ' notes' : '') + ').', id);
      },
      setPattern(id, spec = {}) {
        const pid = findPattern(id).id;
        host.edit((p) => { const pat = p.patterns.find((x) => x.id === pid); fillPattern(pat, p.tracks.find((t) => t.id === pat.trackId), spec); p.sel = { trackId: pat.trackId, patternId: pid }; });
        return done('rewrote "' + findPattern(pid).name + '".', pid);
      },

      /* ---- arrangement ---- */
      addClip(patternId, bar, bars) {
        const pat = findPattern(patternId);
        const at = beatOf(bar, 'bar'), len = bars == null ? PJ.patternBeats(pat) : num(bars, 'bars', 0.25, 1024) * 4;
        const clash = P().clips.find((c) => c.trackId === pat.trackId && c.start < at + len - 1e-6 && at < c.start + c.len - 1e-6);
        if (clash) fail('that overlaps a clip already on this track (bars ' + (clash.start / 4 + 1) + '..' + ((clash.start + clash.len) / 4) + '); one track plays one clip at a time');
        let id;
        host.edit((p) => { id = PJ.addClip(p, p.patterns.find((x) => x.id === pat.id), at, len).id; });
        return done('placed "' + pat.name + '" at bar ' + bar + ' for ' + len / 4 + (len === 4 ? ' bar' : ' bars') + '.', id);
      },
      clearClips(trackId) {
        const tid = trackId == null ? null : findTrack(trackId).id;
        host.edit((p) => { p.clips = p.clips.filter((c) => tid != null && c.trackId !== tid); });
        return done(tid == null ? 'cleared the arrangement.' : 'cleared the clips of ' + findTrack(tid).name + '.', true);
      },
      addMarker(bar, name) { const at = beatOf(bar, 'bar'); host.edit((p) => PJ.addMarker(p, at, name)); return done('marked bar ' + bar + ' "' + name + '".', true); },
      /* points: [[bar, value], ...]; bar may be fractional (5.5 = halfway through bar 5); value 0..1 (pan: 0 left, 0.5 centre, 1 right) */
      automate(trackId, param, points) {
        const tid = findTrack(trackId).id;
        if (!AUTO.includes(param)) fail('automation params are ' + AUTO.join(', '));
        if (!Array.isArray(points) || !points.length) fail('points is [[bar, value], ...]');
        const pts = points.map(([bar, v], i) => ({ b: beatOf(bar, 'point ' + i + ' bar'), v: num(v, 'point ' + i + ' value', 0, 1) })).sort((a, b) => a.b - b.b);
        host.edit((p) => { const t = p.tracks.find((x) => x.id === tid); t.auto = t.auto || {}; t.auto[param] = pts; });
        return done('drew ' + param + ' on ' + findTrack(tid).name + ' (' + pts.length + ' points).', true);
      },

      /* ---- music helpers ---- */
      note, noteName, chord, chords,
      scale(octave = 4) {
        const p = P(), st = HE().SCALES[p.scale].steps, base = p.root + (octave + 1) * 12;
        return st.map((s) => base + s);
      },

      /* ---- looking and listening ---- */
      summary() {
        const p = P(), lines = [p.name + ': ' + p.bpm + ' BPM, ' + NAMES[p.root] + ' ' + p.scale + ', ' + PJ.songBeats(p) / 4 + ' bars'];
        for (const m of p.markers) lines.push('  marker bar ' + (m.beat / 4 + 1) + ': ' + m.name);
        for (const t of p.tracks) {
          lines.push('track ' + t.id + ' "' + t.name + '" ' + (t.instrument || (t.kitStyle ? t.kitStyle + ' kit' : t.type)) + (t.mute ? ' (muted)' : ''));
          for (const x of PJ.patternsOf(p, t.id)) {
            const uses = p.clips.filter((c) => c.patternId === x.id).map((c) => 'bar ' + (c.start / 4 + 1) + '+' + c.len / 4);
            lines.push('  pattern ' + x.id + ' "' + x.name + '" ' + x.bars + ' bars' + (x.notes ? ', ' + x.notes.length + ' notes' : '') + (uses.length ? ' at ' + uses.join(', ') : ' (not placed)'));
          }
        }
        return lines.join('\n');
      },
      /* things worth a second look: unplaced patterns, empty tracks, notes outside the key, very low or high notes */
      check() {
        const p = P(), out = [], st = HE().SCALES[p.scale].steps;
        if (!p.clips.length) out.push('nothing is placed in the song yet: addClip(patternId, bar)');
        for (const t of p.tracks) {
          if (!p.clips.some((c) => c.trackId === t.id)) out.push('track "' + t.name + '" has no clips');
          for (const x of PJ.patternsOf(p, t.id)) {
            if (!p.clips.some((c) => c.patternId === x.id)) out.push('pattern "' + x.name + '" on ' + t.name + ' is not placed');
            if (x.notes) {
              const off = x.notes.filter((n) => !st.includes((((n.pitch - p.root) % 12) + 12) % 12));
              if (off.length) out.push('"' + x.name + '" on ' + t.name + ': ' + off.length + ' of ' + x.notes.length + ' notes are outside ' + NAMES[p.root] + ' ' + p.scale + ' (' + [...new Set(off.map((n) => noteName(n.pitch)))].slice(0, 6).join(' ') + ')');
              const lo = x.notes.filter((n) => n.pitch < 28 || n.pitch > 100);
              if (lo.length) out.push('"' + x.name + '": ' + lo.length + ' notes are very low or very high');
            }
          }
        }
        return out;
      },
      /* renders the song (or, with no clips, the selected pattern) and measures it; perTrack also renders each track alone */
      async listen({ perTrack = false } = {}) {
        const p = P(), mode = p.clips.length ? 'song' : 'pattern';
        if (p.mode !== mode) host.edit((q) => { q.mode = mode; });
        host.say('Agent: listening…');
        const { buf } = await host.render({});
        const sr = buf.sampleRate, L = buf.getChannelData(0), R = buf.numberOfChannels > 1 ? buf.getChannelData(1) : L;
        const map = PJ.tempoMap(p, mode), end = PJ.playItems(p, mode).length;
        const marks = mode === 'song' && p.markers.length ? p.markers.filter((m) => m.beat < end) : Array.from({ length: Math.ceil(end / 32) }, (_, i) => ({ beat: i * 32, name: 'bars ' + (i * 8 + 1) + '-' + Math.min(end / 4, i * 8 + 8) }));
        const sections = marks.map((m, i) => ({ name: m.name, bar: m.beat / 4 + 1, from: 0.02 + map.sec(m.beat), to: 0.02 + map.sec(i + 1 < marks.length ? marks[i + 1].beat : end) }));
        const r = analyze(L, R, sr, sections);
        r.mode = mode;
        r.warnings = [];
        if (r.peak >= 0.999) r.warnings.push('it clips: ' + r.clippedSamples + ' samples at full scale; turn tracks down');
        if (r.loudness < -30) r.warnings.push('very quiet overall (' + r.loudness + ' dB); around -14 to -18 dB is usual');
        const songSecs = map.sec(end);
        r.perSecond.forEach((d, s) => { if (s < songSecs - 1 && d < -45) r.warnings.push('near silence at ' + s + ' s (bar ' + Math.floor(map.beat(s) / 4 + 1) + ')'); });
        if (perTrack) {
          r.tracks = [];
          for (const t of p.tracks) {
            if (!p.clips.some((c) => c.trackId === t.id) && mode === 'song') continue;
            host.say('Agent: listening to ' + t.name + '…');
            const { buf: b } = await host.render({ only: t.id, label: 'Listening to ' + t.name });
            const a = analyze(b.getChannelData(0), b.numberOfChannels > 1 ? b.getChannelData(1) : b.getChannelData(0), b.sampleRate, []);
            r.tracks.push({ id: t.id, name: t.name, loudness: a.loudness, peak: a.peak });
          }
        }
        return done('listened: ' + r.seconds + ' s, loudness ' + r.loudness + ' dB, peak ' + r.peak + (r.warnings.length ? ', ' + r.warnings.length + ' warnings' : '') + '.', r);
      },
      play(bar = 1) { host.play(beatOf(bar, 'bar')); return done('playing from bar ' + bar + '.', true); },
      stop() { host.stop(); return true; },
      undo() { host.undo(); return true; },
      async shareLink() { return host.shareLink(); },
    };
    return api;
  }

  const HELP = `BrowserDJ.agent: make a song in this page. Every call is one undo step and shows in the status line.
newSong() replaces the open song (Undo brings it back). Mistakes throw a message saying what is allowed, and change nothing.
Bars count from 1. Inside a pattern, start and len are beats (4 per bar). Pitches: 60 or 'C4' (middle C).

SONG      newSong({name, bpm, key: 'G', scale: 'major'})   setSong({...})   info()   summary()   song() (JSON)   load(json)
TRACKS    addTrack({type: 'synth', instrument: 'guitar', name, volume, pan, reverb, echo, drive, filter, pump, swing,
                    eq: {low, mid, high} (dB), shape: {attack, release, tone, glide}, movement: {target, rate, depth}})  -> id
          addTrack({type: 'drums', kit: 'acoustic', name, volume, swing})  -> id      setTrack(id, {...})   removeTrack(id)
PATTERNS  addPattern(trackId, {name, bars, notes})  -> id
            notes: [[pitch, start, len, vel?], ...] or [{pitch, start, len, vel, chance, slide}] or "C4 0 1, E4 1 1 90"
          addPattern(drumTrackId, {name, bars, steps: {kick: 'x... .... x... ....', snare: '.... x... .... x...'},
                                   chance: {chat: '..5. ..5.'}})   one character per 16th: . rest  g ghost  o soft  x hit  X accent
            drums: ${'${DRUMS}'}      chance digits 1-9 = 10%-90%
          setPattern(id, {...}) rewrites one
SONG MAP  addClip(patternId, bar, bars?)  (a pattern loops to fill the clip; one clip at a time per track)
          addMarker(bar, 'Chorus')   automate(trackId, 'filter', [[1, 0.3], [9, 0.7]])  params: ${'${AUTO}'}
          clearClips(trackId?)
HELPERS   chord('Am7', 3) -> pitches   chords('G Em C D')   scale(4)   note('F#3')   noteName(66)
EARS      check() -> warnings   await listen({perTrack: true}) -> loudness per marker section, peak, per second, warnings
          play(bar)   stop()   undo()   await shareLink()
INSTRUMENTS ${'${INSTR}'}
KITS      ${'${KITS}'}

Example:
  const a = BrowserDJ.agent;
  a.newSong({name: 'First try', bpm: 100, key: 'A', scale: 'minor'});
  const keys = a.addTrack({instrument: 'ep', name: 'Keys', reverb: 0.3});
  const chords = a.chords('Am F C G').flatMap((c, i) => c.map((p) => [p + 12, i * 4, 4, 80]));
  const k = a.addPattern(keys, {name: 'Chords', notes: chords});
  const d = a.addTrack({type: 'drums', kit: 'acoustic'});
  const beat = a.addPattern(d, {steps: {kick: 'x.......x.x.....', snare: '....x.......x...', chat: 'x.x.x.x.x.x.x.x.'}});
  a.addClip(k, 1, 8); a.addClip(beat, 5, 4); a.addMarker(1, 'Intro'); a.addMarker(5, 'Groove');
  console.log(await a.listen());`;

  // fill the lists into the help text once the sound engine is there
  const api = { create, note, noteName, chord, chords, parseNotes, parseSteps, analyze };
  Object.defineProperty(api, 'HELP', {
    get: () => HELP.replace('${DRUMS}', BDJ.Sound.DRUMS.map((d) => d.id).join(' ')).replace('${AUTO}', BDJ.Sound.PARAMS.map((x) => x.id).join(' '))
      .replace('${INSTR}', BDJ.Sound.INSTRUMENTS.filter((i) => i.id !== 'sampler').map((i) => i.id).join(' ')).replace('${KITS}', BDJ.Sound.KITS.map((k) => k.id).join(' ')),
  });
  BDJ.Agent = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
