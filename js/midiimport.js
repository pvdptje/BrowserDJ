/* BrowserDJ MIDI import: a standard MIDI file (format 0 or 1) -> a BrowserDJ project (plain JSON; run it through
   BDJ.Project.normalize). Channel 10 becomes drum tracks, everything else synth tracks with an instrument guessed
   from the program number. Each track is cut into 4-bar blocks; identical blocks share one pattern and repeats
   merge into one longer clip, so the song arrives arranged like it was made here.
   Runs in the browser and in Node (tests). */
(function (root) {
  'use strict';

  /* ---------- reading the file ---------- */
  function parse(bytes) {
    const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    let o = 0;
    const str = (n) => { let s = ''; for (let i = 0; i < n; i++) s += String.fromCharCode(b[o + i]); o += n; return s; };
    const u32 = () => { const v = (b[o] << 24 | b[o + 1] << 16 | b[o + 2] << 8 | b[o + 3]) >>> 0; o += 4; return v; };
    const u16 = () => { const v = b[o] << 8 | b[o + 1]; o += 2; return v; };
    const vlq = () => { let v = 0, c; do { c = b[o++]; v = (v << 7) | (c & 0x7f); } while (c & 0x80 && o < b.length); return v; };
    if (b.length < 14 || str(4) !== 'MThd') throw new Error('not a MIDI file');
    const hlen = u32(), format = u16(), ntracks = u16(), division = u16();
    o = 8 + hlen;
    if (division & 0x8000) throw new Error('this MIDI file counts time in SMPTE frames, which is not supported');
    const tracks = [];
    for (let t = 0; t < ntracks && o + 8 <= b.length; t++) {
      const id = str(4), len = u32(), end = Math.min(b.length, o + len);
      if (id !== 'MTrk') { o = end; continue; }
      const ev = [];
      let tick = 0, status = 0;
      while (o < end) {
        tick += vlq();
        let s = b[o];
        if (s & 0x80) { status = s; o++; } else s = status; // running status
        if (s === 0xff) {
          const type = b[o++], l = vlq();
          ev.push({ tick, meta: type, data: b.slice(o, o + l) });
          o += l;
        } else if (s === 0xf0 || s === 0xf7) {
          o += vlq(); // sysex: skip
        } else {
          const kind = s & 0xf0, ch = s & 0x0f;
          const d1 = b[o++], d2 = kind === 0xc0 || kind === 0xd0 ? 0 : b[o++];
          ev.push({ tick, kind, ch, d1, d2 });
        }
      }
      o = end;
      tracks.push(ev);
    }
    return { format, ppq: division, tracks };
  }

  const text = (data) => { try { return new TextDecoder().decode(data).replace(/\0/g, '').trim(); } catch (err) { return ''; } };

  /* ---------- sounds ---------- */
  // BrowserDJ's own exports first (so a round trip comes back exactly), then General MIDI families
  const OWN = { 45: 'pluck', 81: 'lead', 4: 'soft', 80: 'chip', 38: 'bass', 14: 'bell', 89: 'pad', 82: 'supersaw', 39: 'acid', 17: 'organ',
    5: 'ep', 12: 'marimba', 48: 'strings', 61: 'brass', 73: 'flute', 32: 'sub', 87: 'reese' };
  function instrumentFor(program) {
    if (program == null) return 'pluck';
    if (OWN[program]) return OWN[program];
    if (program < 8) return 'soft';      // pianos
    if (program >= 11 && program <= 13) return 'marimba'; // vibraphone, marimba, xylophone
    if (program < 16) return 'bell';     // chromatic percussion
    if (program < 24) return 'organ';
    if (program < 32) return 'pluck';    // guitars
    if (program < 40) return 'bass';
    if (program < 52) return 'strings';  // strings, string ensembles
    if (program < 56) return 'pad';      // choirs
    if (program < 72) return 'brass';    // brass, saxes and other reeds
    if (program < 80) return 'flute';    // pipes
    if (program < 88) return 'lead';     // synth leads
    if (program < 96) return 'pad';      // synth pads
    return 'pluck';
  }
  const GM_DRUM = {
    35: 'hkick', 36: 'kick', 37: 'rim', 38: 'snare', 40: 'snare', 39: 'clap', 42: 'chat', 44: 'chat', 46: 'ohat',
    41: 'tom', 43: 'tom', 45: 'tom', 47: 'tom', 48: 'tom', 50: 'tom', 49: 'crash', 57: 'crash', 51: 'crash', 52: 'crash', 55: 'crash', 59: 'crash',
  };
  const DRUM_IDS = ['kick', 'hkick', 'snare', 'clap', 'chat', 'ohat', 'tom', 'rim', 'crash'];
  const COLORS = ['#ffb04f', '#58d6c5', '#ff5c93', '#a58bff', '#b5e36b', '#5fb4ff', '#ff7a59', '#ffe066'];

  /* ---------- building the project ---------- */
  function toProject(bytes, fileName) {
    const mid = parse(bytes);
    const ppq = mid.ppq || 480;
    const markers = [], tempos = []; // tempos: [{tick, bpm}] from every track
    // collect notes per part: format 1 -> per track (and channel), format 0 -> per channel
    const parts = new Map(); // key -> {name, ch, program, vol, pan, notes: [{start, len, pitch, vel}]}
    mid.tracks.forEach((ev, ti) => {
      let trackName = '';
      const open = new Map(); // ch:pitch -> [start, vel][]
      const programs = new Map(), vols = new Map(), pans = new Map();
      const key = (ch) => (mid.format === 0 ? 'c' + ch : 't' + ti + 'c' + ch);
      for (const e of ev) {
        if (e.meta === 0x51 && e.data.length >= 3) tempos.push({ tick: e.tick, bpm: 60000000 / ((e.data[0] << 16) | (e.data[1] << 8) | e.data[2]) });
        else if (e.meta === 0x03 && !trackName) trackName = text(e.data);
        else if (e.meta === 0x06) markers.push({ beat: e.tick / ppq, name: text(e.data) || 'Marker' });
        else if (e.kind === 0xc0) { if (!programs.has(e.ch)) programs.set(e.ch, e.d1); }
        else if (e.kind === 0xb0 && e.d1 === 7) { if (!vols.has(e.ch)) vols.set(e.ch, e.d2); }
        else if (e.kind === 0xb0 && e.d1 === 10) { if (!pans.has(e.ch)) pans.set(e.ch, e.d2); }
        else if (e.kind === 0x90 && e.d2 > 0) {
          const k = e.ch + ':' + e.d1;
          if (!open.has(k)) open.set(k, []);
          open.get(k).push([e.tick, e.d2]);
        } else if (e.kind === 0x80 || (e.kind === 0x90 && e.d2 === 0)) {
          const k = e.ch + ':' + e.d1, q = open.get(k);
          if (!q || !q.length) continue;
          const [s, vel] = q.shift();
          const pk = key(e.ch);
          if (!parts.has(pk)) parts.set(pk, { name: '', ch: e.ch, notes: [] });
          parts.get(pk).notes.push({ start: s / ppq, len: Math.max(1 / 64, (e.tick - s) / ppq), pitch: e.d1, vel });
        }
      }
      for (const [pk, part] of parts) {
        if (!pk.startsWith(mid.format === 0 ? 'c' : 't' + ti + 'c')) continue;
        if (!part.name && trackName) part.name = trackName;
        if (part.program == null && programs.has(part.ch)) part.program = programs.get(part.ch);
        if (part.vol == null && vols.has(part.ch)) part.vol = vols.get(part.ch);
        if (part.pan == null && pans.has(part.ch)) part.pan = pans.get(part.ch);
      }
    });

    // parts that share a name (one-track files often do) are named after their instrument family instead
    const FAMILY = ['Piano', 'Bells', 'Organ', 'Guitar', 'Bass', 'Strings', 'Ensemble', 'Brass', 'Reed', 'Flute', 'Lead', 'Pad', 'Synth FX', 'Ethnic', 'Percussion', 'Sound FX'];
    const used = new Map();
    for (const part of parts.values()) if (part.name) used.set(part.name, (used.get(part.name) || 0) + 1);
    for (const part of parts.values()) {
      if (part.name && used.get(part.name) < 2) continue;
      part.name = part.ch === 9 ? 'Drums' : part.program != null ? FAMILY[part.program >> 3] : '';
    }
    const taken = new Map();
    for (const part of parts.values()) {
      if (!part.name) continue;
      const n = (taken.get(part.name) || 0) + 1;
      taken.set(part.name, n);
      if (n > 1) part.name += ' ' + n;
    }

    const BLOCK = 16; // beats: 4 bars
    let nextId = 1;
    const tracks = [], patterns = [], clips = [];
    let synthN = 0, drumN = 0;
    for (const part of parts.values()) {
      if (!part.notes.length) continue;
      const drums = part.ch === 9;
      const t = {
        id: nextId++, type: drums ? 'drums' : 'synth',
        name: (part.name || (drums ? 'Drums' + (drumN ? ' ' + (drumN + 1) : '') : 'Track ' + (synthN + 1))).slice(0, 40),
        color: COLORS[tracks.length % COLORS.length],
        volume: part.vol != null ? Math.round((part.vol / 127) * 100) / 100 : 0.8,
        pan: part.pan != null ? Math.round(((part.pan - 64) / 63) * 100) / 100 : 0,
      };
      if (drums) {
        drumN++;
        // swing: every second 16th consistently late -> the track's Swing setting (the hits still land on their steps)
        const late = part.notes.filter((n) => Math.round(n.start * 4) % 2 === 1).map((n) => n.start - Math.round(n.start * 4) / 4).sort((x, y) => x - y);
        const med = late.length >= 4 ? late[late.length >> 1] : 0;
        if (med > 0.004 && late.filter((d) => Math.abs(d - med) < 0.01).length >= late.length * 0.7) t.swing = Math.min(0.6, Math.round((med / 0.125) * 100) / 100);
      } else { synthN++; t.instrument = instrumentFor(part.program); }
      tracks.push(t);
      // cut into 4-bar blocks; identical blocks share a pattern
      const blocks = new Map();
      for (const n of part.notes) {
        const bi = Math.floor(n.start / BLOCK + 1e-9);
        if (!blocks.has(bi)) blocks.set(bi, []);
        blocks.get(bi).push(n);
      }
      const seen = new Map(); // block fingerprint -> pattern id
      const placed = [];
      for (const bi of [...blocks.keys()].sort((a, b) => a - b)) {
        const base = bi * BLOCK;
        let body;
        if (drums) {
          const steps = Object.fromEntries(DRUM_IDS.map((d) => [d, new Array(64).fill(0)]));
          for (const n of blocks.get(bi)) {
            const d = GM_DRUM[n.pitch];
            const s = Math.round((n.start - base) * 4);
            if (d && s >= 0 && s < 64) steps[d][s] = Math.max(steps[d][s], n.vel);
          }
          body = { bars: 4, steps };
        } else {
          const notes = blocks.get(bi).map((n) => ({
            start: Math.round((n.start - base) * 1000) / 1000,
            len: Math.round(Math.min(n.len, BLOCK - (n.start - base)) * 1000) / 1000,
            pitch: n.pitch, vel: n.vel,
          })).sort((a, b) => a.start - b.start || a.pitch - b.pitch);
          body = { bars: 4, notes };
        }
        const fp = JSON.stringify(body);
        let pid = seen.get(fp);
        if (!pid) {
          pid = nextId++;
          seen.set(fp, pid);
          patterns.push({ id: pid, trackId: t.id, name: t.name + ' ' + seen.size, ...body });
        }
        placed.push({ start: base, patternId: pid });
      }
      // repeats of the same block in a row become one longer clip
      for (const p of placed) {
        const prev = clips[clips.length - 1];
        if (prev && prev.trackId === t.id && prev.patternId === p.patternId && prev.start + prev.len === p.start) prev.len += BLOCK;
        else clips.push({ id: nextId++, trackId: t.id, patternId: p.patternId, start: p.start, len: BLOCK });
      }
      // a track with a single pattern needs no number on it
      const own = patterns.filter((x) => x.trackId === t.id);
      if (own.length === 1) own[0].name = t.name;
    }
    if (!tracks.length) throw new Error('this MIDI file has no notes');
    // the first tempo is the song's; later ones become tempo changes (on 16ths, nearest 0.1 BPM, repeats dropped)
    tempos.sort((a, b) => a.tick - b.tick);
    const bpm = tempos.length ? tempos[0].bpm : 120, tempo = [];
    let lastBpm = Math.max(40, Math.min(240, Math.round(bpm)));
    for (const tp of tempos.slice(1)) {
      const b = Math.round((tp.tick / ppq) * 4) / 4, v = Math.round(Math.max(40, Math.min(240, tp.bpm)) * 10) / 10;
      if (b <= 0 || Math.abs(v - lastBpm) < 0.05) continue;
      if (tempo.length && tempo[tempo.length - 1].b === b) tempo.pop();
      tempo.push({ b, bpm: v });
      lastBpm = v;
    }
    const first = tracks.find((t) => t.type === 'synth') || tracks[0];
    const firstPat = patterns.find((x) => x.trackId === first.id);
    return {
      version: 2,
      name: (fileName || 'Imported').replace(/\.(mid|midi|smf)$/i, '').slice(0, 80) || 'Imported',
      bpm: Math.max(40, Math.min(240, Math.round(bpm))),
      mode: 'song', snap: 16, loop: true,
      tracks, patterns, clips, tempo: tempo.slice(0, 256), tempoOpen: tempo.length > 0,
      markers: markers.filter((m) => m.name).map((m, i) => ({ id: 1000 + i, beat: Math.round(m.beat * 4) / 4, name: m.name.slice(0, 40) })),
      sel: { trackId: first.id, patternId: firstPat && firstPat.id },
    };
  }

  const api = { parse, toProject, instrumentFor };
  root.BDJ = root.BDJ || {};
  root.BDJ.MidiImport = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
