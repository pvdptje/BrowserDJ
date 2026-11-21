/* Node tests for the hum engine and project model. Run: node test/engine.test.js */
'use strict';
const assert = require('assert');
const path = require('path');
const fs = require('fs');
const vm = require('vm');

// load the browser scripts into one shared context
const ctx = { console, TextEncoder, Math, Float32Array, Uint8Array, Uint8Array, JSON, Array, Object, Map, Set, isFinite, Number, String };
ctx.window = ctx;
vm.createContext(ctx);
for (const f of ['engine.js', 'sound.js', 'project.js']) {
  const code = fs.readFileSync(path.join(__dirname, '..', 'js', f), 'utf8').replace('const HumEngine =', 'var HumEngine =');
  vm.runInContext(code, ctx, { filename: f });
}
const E = ctx.HumEngine, PJ = ctx.BDJ.Project;

let passed = 0;
// values built inside the vm context have their own Array prototype, so compare plain copies
const eq = (a, b) => assert.deepStrictEqual(JSON.parse(JSON.stringify(a)), JSON.parse(JSON.stringify(b)));
// tests run in order and may be async; the first failure stops the run with a non-zero exit
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

/* synthesize a hummed melody: [midi, startSec, durSec] with a little vibrato and gaps */
function hum(notes, sr = 44100, lead = 0.3) {
  const total = lead + Math.max(...notes.map(([, s, d]) => s + d)) + 0.4;
  const out = new Float32Array(Math.ceil(total * sr));
  for (const [m, s, d] of notes) {
    const f = 440 * Math.pow(2, (m - 69) / 12);
    let ph = 0;
    const a = Math.round((lead + s) * sr), n = Math.round(d * sr);
    for (let i = 0; i < n; i++) {
      const t = i / sr;
      const env = Math.min(1, t / 0.02, (d - t) / 0.03);
      ph += (2 * Math.PI * f * (1 + 0.004 * Math.sin(2 * Math.PI * 5 * t))) / sr;
      out[a + i] += 0.3 * env * (Math.sin(ph) + 0.4 * Math.sin(2 * ph) + 0.2 * Math.sin(3 * ph));
    }
  }
  return { out, sr, lead };
}
function analyze(sig) {
  const an = new E.Analyzer(sig.sr);
  for (let i = 0; i < sig.out.length; i += 4096) { an.push(sig.out.subarray(i, i + 4096)); an.process(); }
  return an.frames();
}

const spb = 60 / 120;
const melody = [[60, 0, spb * 0.9], [62, spb, spb * 0.9], [64, 2 * spb, spb * 0.9], [67, 3 * spb, spb * 1.9], [64, 5 * spb, spb * 0.9]];

test('pitch tracking + segmentation finds the hummed notes', () => {
  const F = analyze(hum(melody));
  const seg = E.segment(F, 0.5);
  eq(seg.notes.map((n) => Math.round(n.midi)), [60, 62, 64, 67, 64]);
});

test('finalize on a 1/16 grid starts at beat 0 and keeps the rhythm', () => {
  const F = analyze(hum(melody));
  const seg = E.segment(F, 0.5);
  const fin = E.finalize(seg.notes, { root: 0, scale: 'major', fixTuning: true, tuning: seg.tuning, bpm: 120, grid: 16, octave: 0 });
  const beats = fin.notes.map((n) => +(n.start / spb).toFixed(2));
  eq(beats, [0, 1, 2, 3, 5]);
});

test('anchored finalize keeps notes where they were sung against the beat', () => {
  const sig = hum(melody, 44100, 0.3);
  const F = analyze(sig);
  const seg = E.segment(F, 0.5);
  // beat 0 at 0.3 - 2 beats => first note should land on beat 2
  const anchor = sig.lead - 2 * spb;
  const fin = E.finalize(seg.notes, { root: 0, scale: 'major', fixTuning: true, tuning: seg.tuning, bpm: 120, grid: 16, octave: 0, anchor });
  eq(fin.notes.map((n) => +(n.start / spb).toFixed(2)), [2, 3, 4, 5, 7]);
});

test('anchored finalize drops notes sung during the count-in', () => {
  const sig = hum(melody, 44100, 0.3);
  const seg = E.segment(analyze(sig), 0.5);
  const anchor = sig.lead + 2 * spb; // beat 0 falls on the third note
  const fin = E.finalize(seg.notes, { root: 0, scale: 'major', fixTuning: true, tuning: seg.tuning, bpm: 120, grid: 16, octave: 0, anchor });
  eq(fin.notes.map((n) => n.pitch), [64, 67, 64]);
  assert.strictEqual(+(fin.notes[0].start / spb).toFixed(2), 0);
});

test('deriveFromTake returns notes in beats', () => {
  const sig = hum(melody);
  const seg = E.segment(analyze(sig), 0.5);
  const p = PJ.blank();
  p.bpm = 120;
  const pat = PJ.selPattern(p);
  const d = PJ.deriveFromTake(p, pat, { raw: seg.notes, tuning: seg.tuning, anchor: null });
  eq(d.notes.map((n) => [n.start, n.pitch]), [[0, 60], [1, 62], [2, 64], [3, 67], [5, 64]]);
  assert.ok(d.notes.every((n) => n.len > 0.5));
});

/* minimal MIDI parser to check what we write */
function parseMidi(b) {
  const u32 = (o) => (b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3];
  assert.strictEqual(String.fromCharCode(...b.slice(0, 4)), 'MThd');
  const format = (b[8] << 8) | b[9], ntr = (b[10] << 8) | b[11], ppq = (b[12] << 8) | b[13];
  let o = 14;
  const tracks = [];
  for (let t = 0; t < ntr; t++) {
    assert.strictEqual(String.fromCharCode(...b.slice(o, o + 4)), 'MTrk');
    const len = u32(o + 4);
    let i = o + 8;
    const endAt = i + len;
    let tick = 0, status = 0;
    const ev = [];
    while (i < endAt) {
      let v = 0, c;
      do { c = b[i++]; v = (v << 7) | (c & 0x7f); } while (c & 0x80);
      tick += v;
      let s = b[i];
      if (s & 0x80) { status = s; i++; } else s = status;
      if (s === 0xff) {
        const type = b[i++];
        let l = 0;
        do { c = b[i++]; l = (l << 7) | (c & 0x7f); } while (c & 0x80);
        ev.push({ tick, meta: type, data: b.slice(i, i + l) });
        i += l;
      } else if ((s & 0xf0) === 0xc0) { ev.push({ tick, prog: b[i++], ch: s & 0xf }); }
      else { ev.push({ tick, type: s & 0xf0, ch: s & 0xf, a: b[i++], b: b[i++] }); }
    }
    assert.strictEqual(i, endAt);
    tracks.push(ev);
    o = endAt;
  }
  return { format, ppq, tracks };
}

test('example song: tracks, patterns and clips', () => {
  const p = PJ.example();
  eq(p.tracks.map((t) => [t.name, t.type]), [['Drums', 'drums'], ['Bass', 'synth'], ['Lead', 'synth']]);
  assert.strictEqual(PJ.songBeats(p), 32);
  assert.strictEqual(PJ.selPattern(p).name, 'Hook');
  assert.strictEqual(PJ.playItems(p, 'pattern').length, 8);
  assert.strictEqual(PJ.playItems(p, 'song').items.length, 4);
});

test('eventsIn repeats patterns inside clips and stops at the clip end', () => {
  const p = PJ.blank();
  const t = p.tracks[0], pat = PJ.selPattern(p);
  pat.bars = 1;
  pat.notes = [{ id: 1, start: 0, len: 1, pitch: 60, vel: 100 }, { id: 2, start: 3.5, len: 2, pitch: 62, vel: 100 }];
  // the second note runs past the bar, so the pattern loops every 2 bars; a 6-beat clip plays it once, cut short
  PJ.addClip(p, pat, 8, 6);
  const got = [];
  const { items } = PJ.playItems(p, 'song');
  // uneven windows, like the scheduler uses, must not double or drop anything
  const cuts = [0, 3.3, 8, 8.07, 11.5, 12, 13.99, 20];
  for (let i = 0; i < cuts.length - 1; i++) PJ.eventsIn(p, items, cuts[i], cuts[i + 1], (ev) => got.push([ev.at, ev.pitch, ev.len]));
  eq(got, [[8, 60, 1], [11.5, 62, 2]]);
  pat.notes[1].len = 0.5; // now it is a 1-bar pattern: plays 1.5 times, the last note cut at the clip end
  got.length = 0;
  PJ.addClip(p, pat, 20, 6);
  const it2 = PJ.playItems(p, 'song').items;
  for (let i = 0; i < 40; i++) PJ.eventsIn(p, it2, 20 + i * 0.17, 20 + (i + 1) * 0.17, (ev) => got.push([ev.at, ev.pitch, ev.len]));
  eq(got, [[20, 60, 1], [23.5, 62, 0.5], [24, 60, 1]]);
  t.mute = true;
  let n = 0;
  PJ.eventsIn(p, it2, 0, 40, () => n++);
  assert.strictEqual(n, 0);
});

test('drum events: windows, swing, solo inside the kit', () => {
  const p = PJ.blank();
  const dt = p.tracks.find((t) => t.type === 'drums'), pat = PJ.patternsOf(p, dt.id)[0];
  PJ.applyPreset(p, pat, 'house');
  PJ.addClip(p, pat, 0, 4);
  const { items } = PJ.playItems(p, 'song');
  const hats = [];
  for (let a = 0; a < 4 - 1e-9; a += 0.33) PJ.eventsIn(p, items, a, Math.min(4, a + 0.33), (ev) => { if (ev.drum === 'chat') hats.push(+ev.at.toFixed(3)); });
  eq(hats, [0.5, 1.5, 2.5, 3.5]); // on even 16th steps, so swing does not move them
  pat.steps.rim = new Array(16).fill(0); pat.steps.rim[3] = 100;
  dt.swing = 0.4;
  const rim = [];
  PJ.eventsIn(p, items, 0, 4, (ev) => { if (ev.drum === 'rim') rim.push(+ev.at.toFixed(3)); });
  eq(rim, [0.75 + 0.05]); // odd step pushed late by swing
  dt.kit.find((k) => k.id === 'kick').solo = true;
  const ids = new Set();
  PJ.eventsIn(p, items, 0, 4, (ev) => ids.add(ev.drum));
  eq([...ids], ['kick']);
});

test('writeMidiTracks writes a valid format-1 file, one track per instrument', () => {
  const p = PJ.example();
  const m = parseMidi(E.writeMidiTracks(PJ.midiTracks(p, 'song'), p.bpm));
  assert.strictEqual(m.format, 1);
  assert.strictEqual(m.ppq, 480);
  assert.strictEqual(m.tracks.length, 4); // tempo + drums + bass + lead
  const tempo = m.tracks[0].find((e) => e.meta === 0x51).data;
  assert.strictEqual(Math.round(60000000 / ((tempo[0] << 16) | (tempo[1] << 8) | tempo[2])), 124);
  const dr = m.tracks[1].filter((e) => e.type === 0x90);
  assert.ok(dr.every((e) => e.ch === 9));
  const kicks = dr.filter((e) => e.a === 36).map((e) => e.tick / 480);
  eq(kicks.slice(0, 4), [0, 1, 2, 3]);
  assert.strictEqual(kicks.length, 28 + 1); // house over 7 bars, plus the fill's single kick
  const bass = m.tracks[2].filter((e) => e.type === 0x90);
  assert.ok(bass.every((e) => e.ch === 0));
  assert.strictEqual(bass[0].tick, 8 * 480);
  assert.strictEqual(bass.length, 12 * 3); // a 2-bar bassline over 6 bars
  const lead = m.tracks[3].filter((e) => e.type === 0x90);
  assert.ok(lead.every((e) => e.ch === 1));
  assert.strictEqual(lead[0].tick, 16 * 480);
  assert.strictEqual(lead.length, 24);
  // pattern mode exports only the selected pattern, from 0
  const pm = parseMidi(E.writeMidiTracks(PJ.midiTracks(p, 'pattern'), p.bpm));
  assert.strictEqual(pm.tracks.length, 2);
  assert.strictEqual(pm.tracks[1].filter((e) => e.type === 0x90)[0].tick, 0);
});

test('patterns: clone, delete removes its clips, tracks keep one pattern', () => {
  const p = PJ.example();
  const lead = p.tracks.find((t) => t.name === 'Lead');
  const hook = PJ.selPattern(p);
  const copy = PJ.clonePattern(p, hook);
  assert.strictEqual(copy.name, 'Hook 2');
  copy.notes[0].pitch = 99;
  assert.notStrictEqual(hook.notes[0].pitch, 99);
  PJ.addClip(p, copy, 32);
  assert.ok(PJ.deletePattern(p, copy.id));
  assert.ok(!p.clips.some((c) => c.patternId === copy.id));
  assert.ok(!PJ.deletePattern(p, hook.id)); // the last pattern on a track stays
  assert.ok(PJ.deleteTrack(p, lead.id));
  assert.ok(!p.clips.some((c) => c.trackId === lead.id));
  assert.notStrictEqual(PJ.selTrack(p).id, lead.id);
});

test('normalize round-trips v2 and migrates a v1 project', () => {
  const p = PJ.example();
  const back = PJ.normalize(JSON.parse(PJ.serialize(p)));
  eq(back.tracks.map((t) => t.name), p.tracks.map((t) => t.name));
  eq(back.clips.map((c) => [c.start, c.len]), p.clips.map((c) => [c.start, c.len]));
  const shape = (q) => q.patterns.map((x) => (x.notes ? x.notes.map((n) => n.pitch) : x.steps.kick));
  eq(shape(back), shape(p));
  assert.strictEqual(PJ.selPattern(back).name, 'Hook');
  for (const c of back.clips) { assert.ok(PJ.pattern(back, c.patternId)); assert.strictEqual(PJ.pattern(back, c.patternId).trackId, c.trackId); }

  const v1 = {
    version: 1, name: 'Old', bpm: 98, root: 2, scale: 'dorian', bars: 4, snap: 8,
    melody: { instrument: 'bell', echo: false, volume: 0.5, notes: [{ start: 0, len: 1, pitch: 62, vel: 90 }, { start: 13, len: 2, pitch: 65, vel: 90 }] },
    drums: { bars: 1, swing: 0.2, rows: [{ id: 'kick', vol: 0.5, steps: [100, 0, 0, 0, 100, 0, 0, 0, 100, 0, 0, 0, 100, 0, 0, 0] }] },
  };
  const m = PJ.normalize(v1);
  assert.strictEqual(m.version, 2);
  assert.strictEqual(m.mode, 'song');
  assert.strictEqual(m.bpm, 98);
  eq(m.tracks.map((t) => [t.name, t.type]), [['Melody', 'synth'], ['Drums', 'drums']]);
  assert.strictEqual(m.tracks[0].instrument, 'bell');
  assert.strictEqual(m.tracks[0].echoSend, 0); // echo was off in the old save
  assert.strictEqual(m.tracks[1].swing, 0.2);
  assert.strictEqual(m.tracks[1].kit.find((k) => k.id === 'kick').vol, 0.5);
  eq(m.clips.map((c) => [c.start, c.len]), [[0, 16], [0, 16]]);
  assert.strictEqual(PJ.songBeats(m), 16);
  const junk = PJ.normalize({ version: 2, tracks: [{ id: 5, type: 'nope' }], clips: [{ patternId: 77 }] });
  assert.ok(junk.tracks.length >= 1 && junk.clips.length === 0);
  // a v2 save from before the mixer: echo on/off becomes an amount, pan defaults to centre
  const pre = PJ.normalize({ version: 2, tracks: [{ id: 1, type: 'synth', echo: true }, { id: 2, type: 'synth', echo: false }, { id: 3, type: 'drums' }] });
  eq(pre.tracks.map((t) => [t.echoSend, t.pan]), [[1, 0], [0, 0], [0, 0]]);
  assert.strictEqual(pre.master, 0.85);
  assert.strictEqual(pre.region, null);
});

test('loop region, markers and mixer settings round-trip', () => {
  const p = PJ.example();
  eq(PJ.loopRange(p, 'song', 32), { start: 0, end: 32 });
  p.region = { start: 8, end: 16 };
  eq(PJ.loopRange(p, 'song', 32), { start: 8, end: 16 });
  eq(PJ.loopRange(p, 'pattern', 8), { start: 0, end: 8 }); // the region only applies to the song
  PJ.addMarker(p, 24, 'Drop');
  p.tracks[0].pan = -0.5; p.tracks[0].echoSend = 0.3; p.master = 0.6;
  const back = PJ.normalize(JSON.parse(PJ.serialize(p)));
  eq(back.region, { start: 8, end: 16 });
  eq(back.markers.map((m) => [m.beat, m.name]), [[0, 'Intro'], [16, 'Hook'], [24, 'Drop']]);
  eq([back.tracks[0].pan, back.tracks[0].echoSend, back.master], [-0.5, 0.3, 0.6]);
  // a region too short to loop is dropped
  assert.strictEqual(PJ.normalize({ ...JSON.parse(PJ.serialize(p)), region: { start: 4, end: 4 } }).region, null);
});

test('MIDI carries markers and per-track volume and pan', () => {
  const p = PJ.example();
  p.tracks[1].pan = -1; p.tracks[1].volume = 0.5;
  const m = parseMidi(E.writeMidiTracks(PJ.midiTracks(p, 'song'), p.bpm, p.markers));
  const marks = m.tracks[0].filter((e) => e.meta === 0x06).map((e) => [e.tick / 480, String.fromCharCode(...e.data)]);
  eq(marks, [[0, 'Intro'], [16, 'Hook']]);
  const cc = m.tracks[2].filter((e) => e.type === 0xb0).map((e) => [e.a, e.b]); // the bass track
  eq(cc, [[7, 64], [10, 1], [91, 0]]); // volume, pan, reverb send
});

test('drive and the hard kick', () => {
  const p = PJ.blank();
  assert.strictEqual(p.tracks[0].drive, 0);
  const back = PJ.normalize({ ...JSON.parse(PJ.serialize(p)), tracks: p.tracks.map((t) => ({ ...t, drive: 7 })) });
  assert.ok(back.tracks.every((t) => t.drive === 1)); // clamped
  const dt = p.tracks.find((t) => t.type === 'drums'), pat = PJ.patternsOf(p, dt.id)[0];
  assert.ok(dt.kit.some((k) => k.id === 'hkick'));
  pat.steps.hkick[0] = 127;
  PJ.addClip(p, pat, 0, 4);
  const m = parseMidi(E.writeMidiTracks(PJ.midiTracks(p, 'song'), p.bpm));
  eq(m.tracks[1].filter((e) => e.type === 0x90).map((e) => [e.ch, e.a]), [[9, 35]]);
});

test('automation: values between points, cleanup, MIDI controllers', () => {
  const pts = [{ b: 4, v: 0 }, { b: 8, v: 1 }, { b: 12, v: 0.5 }];
  eq([0, 4, 6, 8, 10, 12, 99].map((b) => PJ.autoValue(pts, b)), [0, 0, 0.5, 1, 0.75, 0.5, 0.5]);
  assert.strictEqual(PJ.autoValue([], 3), null);
  const p = PJ.example();
  const bass = p.tracks.find((t) => t.name === 'Bass');
  const back = PJ.normalize({ ...JSON.parse(PJ.serialize(p)), tracks: p.tracks.map((t) => (t.id === bass.id
    ? { ...t, auto: { filter: [{ b: 16, v: 0.5 }, { b: 'x', v: 1 }, { b: 8, v: 9 }, { b: 12, v: 0.2 }], volume: [], bogus: [{ b: 1, v: 1 }] }, autoParam: 'nope' }
    : t)) });
  const bb = back.tracks.find((t) => t.name === 'Bass');
  eq(bb.auto, { filter: [{ b: 8, v: 1 }, { b: 12, v: 0.2 }, { b: 16, v: 0.5 }] }); // sorted, clamped, junk and empties dropped
  assert.strictEqual(bb.autoParam, 'volume');
  eq(PJ.autoParams(bb), ['filter']);
  // filter automation becomes CC74 on the bass track, only when it changes
  const m = parseMidi(E.writeMidiTracks(PJ.midiTracks(back, 'song'), back.bpm));
  const cc74 = m.tracks[2].filter((e) => e.type === 0xb0 && e.a === 74).map((e) => [e.tick / 480, e.b]);
  eq(cc74.slice(0, 2), [[0, 127], [8.125, 124]]);
  eq(cc74[cc74.length - 1], [16, 64]);
  assert.ok(cc74.every((c, i) => !i || c[1] !== cc74[i - 1][1]));
  // pattern mode exports no automation
  const pm = parseMidi(E.writeMidiTracks(PJ.midiTracks(back, 'pattern'), back.bpm));
  assert.ok(pm.tracks.every((tr) => !tr.some((e) => e.type === 0xb0 && e.a === 74)));
});

test('synth shape: defaults, round trip, clamping; new instruments are known', () => {
  const p = PJ.blank();
  const syn = p.tracks.find((t) => t.type === 'synth'), drums = p.tracks.find((t) => t.type === 'drums');
  eq(syn.shape, { attack: 0, release: 0, tone: 0.5 });
  assert.strictEqual(drums.shape, undefined);
  syn.shape = { attack: 0.4, release: 7, tone: -1 };
  syn.instrument = 'supersaw';
  const back = PJ.normalize(JSON.parse(PJ.serialize(p)));
  const s2 = back.tracks.find((t) => t.type === 'synth');
  eq(s2.shape, { attack: 0.4, release: 1, tone: 0 });
  assert.strictEqual(s2.instrument, 'supersaw');
  for (const id of ['supersaw', 'acid', 'organ']) assert.ok(ctx.BDJ.Sound.INSTRUMENTS.some((i) => i.id === id));
  // older saves without a shape get the neutral one
  const old = PJ.normalize({ version: 2, tracks: [{ id: 1, type: 'synth', instrument: 'acid' }] });
  eq(old.tracks[0].shape, { attack: 0, release: 0, tone: 0.5 });
});

test('movement (LFO): off by default, round trip, bad values cleaned up', () => {
  const p = PJ.blank();
  const syn = p.tracks.find((t) => t.type === 'synth'), drums = p.tracks.find((t) => t.type === 'drums');
  eq(syn.lfo, { target: 'off', rate: '1/8', depth: 0.6 });
  assert.strictEqual(drums.lfo, undefined);
  syn.lfo = { target: 'filter', rate: '1/4T', depth: 0.3 };
  eq(PJ.normalize(JSON.parse(PJ.serialize(p))).tracks.find((t) => t.type === 'synth').lfo, { target: 'filter', rate: '1/4T', depth: 0.3 });
  const bad = PJ.normalize({ version: 2, tracks: [{ id: 1, type: 'synth', lfo: { target: 'pitch', rate: '1/3', depth: 9 } }, { id: 2, type: 'synth' }] });
  eq(bad.tracks[0].lfo, { target: 'off', rate: '1/8', depth: 1 });
  eq(bad.tracks[1].lfo, { target: 'off', rate: '1/8', depth: 0.6 });
  for (const r of Object.keys(ctx.BDJ.Sound.LFO_RATES)) assert.ok(ctx.BDJ.Sound.LFO_RATES[r] > 0);
});

test('kit sample references: kept when valid, dropped when not', () => {
  const p = PJ.blank();
  const dt = p.tracks.find((t) => t.type === 'drums');
  dt.kit.find((k) => k.id === 'snare').sample = { hash: '0fe912a76f03ec8026170740', name: 'tone.wav' };
  dt.kit.find((k) => k.id === 'kick').sample = { hash: 'not a hash!', name: 'x.wav' };
  dt.kit.find((k) => k.id === 'clap').sample = { hash: 'abcdef0123', name: '' };
  const back = PJ.normalize(JSON.parse(PJ.serialize(p))).tracks.find((t) => t.type === 'drums').kit;
  eq(back.find((k) => k.id === 'snare').sample, { hash: '0fe912a76f03ec8026170740', name: 'tone.wav' });
  assert.strictEqual(back.find((k) => k.id === 'kick').sample, undefined);
  eq(back.find((k) => k.id === 'clap').sample, { hash: 'abcdef0123', name: 'sample' });
});

test('reverb and pump: defaults, clamping, reverb is automatable', () => {
  const p = PJ.blank();
  eq(p.tracks.map((t) => [t.reverb, t.pump]), [[0, 0], [0, 0]]);
  const back = PJ.normalize({ ...JSON.parse(PJ.serialize(p)), tracks: p.tracks.map((t, i) => ({ ...t, reverb: i ? 0.4 : 3, pump: i ? -1 : 0.5 })) });
  eq(back.tracks.map((t) => [t.reverb, t.pump]), [[1, 0.5], [0.4, 0]]);
  assert.ok(ctx.BDJ.Sound.PARAMS.some((x) => x.id === 'reverb'));
  // an old save without the fields gets none
  const old = PJ.normalize({ version: 2, tracks: [{ id: 1, type: 'synth' }] });
  eq([old.tracks[0].reverb, old.tracks[0].pump], [0, 0]);
});

test('master loudness: default none, clamped, survives a round trip', () => {
  const p = PJ.blank();
  assert.strictEqual(p.loud, 0);
  assert.strictEqual(PJ.normalize({ ...JSON.parse(PJ.serialize(p)), loud: 0.6 }).loud, 0.6);
  assert.strictEqual(PJ.normalize({ ...JSON.parse(PJ.serialize(p)), loud: 5 }).loud, 1);
  assert.strictEqual(PJ.normalize({ version: 2, tracks: [{ id: 1, type: 'synth' }] }).loud, 0);
});

test('offline: the service worker keeps every file the page loads, and they all exist', () => {
  const root = path.join(__dirname, '..');
  const sw = fs.readFileSync(path.join(root, 'sw.js'), 'utf8');
  const shell = JSON.parse(sw.match(/const SHELL = (\[[\s\S]*?\]);/)[1].replace(/'/g, '"').replace(/,\s*\]/, ']'));
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const used = [...html.matchAll(/(?:src|href)="([^"#:]+)"/g)].map((m) => m[1]);
  used.push('examples/examples.js');
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.webmanifest'), 'utf8'));
  for (const i of manifest.icons) used.push(i.src);
  for (const u of used) assert.ok(shell.includes(u), u + ' is not in the service worker list');
  for (const u of shell) if (u !== './') assert.ok(fs.existsSync(path.join(root, u)), u + ' does not exist');
});

test('example library: examples.js matches the song files, and every song loads cleanly', () => {
  const { build } = require('../tools/pack-examples.js');
  const packed = fs.readFileSync(path.join(__dirname, '..', 'examples', 'examples.js'), 'utf8');
  assert.strictEqual(packed, build(), 'examples/examples.js is out of date: run node tools/pack-examples.js');
  const lib = { window: {} };
  lib.BDJ = lib.window.BDJ = {};
  vm.runInNewContext(packed, lib);
  const list = lib.BDJ.EXAMPLES;
  assert.ok(list.length >= 4);
  assert.strictEqual(new Set(list.map((x) => x.id)).size, list.length);
  for (const ex of list) {
    const raw = JSON.parse(JSON.stringify(ex.project));
    const p = PJ.normalize(raw);
    assert.strictEqual(p.clips.length, raw.clips.length, ex.id + ': every clip survives');
    assert.ok(ex.title && ex.style && ex.blurb && ex.bpm === p.bpm && ex.secs > 30, ex.id + ': catalogue details');
  }
});

test('share links: every example survives the trip, links stay short, bad links fail clearly', async () => {
  const S = require('../js/share.js');
  const dir = path.join(__dirname, '..', 'examples');
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json') && x !== 'catalog.json')) {
    const raw = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    const token = await S.encode(raw);
    assert.ok(/^z[A-Za-z0-9_-]+$/.test(token), f + ': URL-safe');
    assert.ok(token.length < 8000, f + ': ' + token.length + ' characters');
    eq(await S.decode(token), raw);
  }
  // sample audio never goes into a link
  const withData = { name: 'x', tracks: [], sampleData: { abc: { data: 'A'.repeat(5000) } } };
  assert.strictEqual((await S.decode(await S.encode(withData))).sampleData, undefined);
  for (const bad of ['', 'q123', 'zAAAA', 'z' + 'B'.repeat(40)]) {
    await assert.rejects(() => S.decode(bad), undefined, 'bad link: ' + bad);
  }
});

/* synthetic mouth drums: 'K' boots (low pitch drop), 'S' ka (mid noise + a little body), 'H' ts (bright hiss) */
function beatbox(pattern, bpm, sr = 44100, sloppy = 0.012) {
  const step = 60 / bpm / 4, lead = 0.4, out = new Float32Array(Math.ceil((lead + pattern.length * step + 0.5) * sr));
  let seed = 7;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x3fffffff - 1; };
  for (let i = 0; i < out.length; i++) out[i] = rnd() * 0.002; // room noise
  [...pattern].forEach((ch, i) => {
    if (ch === '.') return;
    const a = Math.round((lead + i * step + rnd() * sloppy) * sr);
    let ph = 0, lp = 0, hp = 0, prev = 0, bp = 0;
    const len = Math.round(sr * (ch === 'K' ? 0.16 : ch === 'S' ? 0.12 : 0.06));
    for (let j = 0; j < len && a + j < out.length; j++) {
      const t = j / sr, n = rnd();
      let v;
      if (ch === 'K') { ph += (2 * Math.PI * (60 + 90 * Math.exp(-t / 0.03))) / sr; v = Math.sin(ph) * Math.exp(-t / 0.05) * 0.8; }
      // a 'ka': noise band-limited to roughly 1-5 kHz (two low-passes minus a slow one), plus a little body
      else if (ch === 'S') { lp += 0.25 * (n - lp); bp += 0.25 * (lp - bp); hp += 0.03 * (bp - hp); ph += (2 * Math.PI * 190) / sr; v = ((bp - hp) * 2.2 + Math.sin(ph) * 0.12) * Math.exp(-t / 0.04) * 0.7; }
      else { hp = n - prev; prev = n; v = hp * Math.exp(-t / 0.018) * 0.35; }
      out[a + j] += v * Math.min(1, j / 40);
    }
  });
  return { samples: out, sr, lead };
}

test('beatbox: boots / ka / ts become kick, snare and hi-hat on the right steps', () => {
  const BB = require('../js/beatbox.js');
  const pat = 'K.H.S.H.K.H.S.HHK.H.S.H.KKH.S.H.';
  const { samples, sr, lead } = beatbox(pat, 100);
  const hits = BB.analyze(samples, sr);
  const want = [...pat].map((c, i) => [i, c]).filter(([, c]) => c !== '.');
  assert.strictEqual(hits.length, want.length, 'found ' + hits.length + ' of ' + want.length + ' hits');
  const names = { K: 'kick', S: 'snare', H: 'chat' };
  const wrong = want.filter(([, c], i) => hits[i].drum !== names[c]);
  assert.strictEqual(wrong.length, 0, 'misheard: ' + JSON.stringify(wrong.map(([i, c]) => [i, c, hits[want.findIndex((w) => w[0] === i)].drum])));
  const st = BB.toSteps(hits, 100, lead);
  assert.strictEqual(st.bars, 2);
  for (const [i, c] of want) assert.ok(st.steps[names[c]][i] > 0, 'step ' + i + ' ' + c);
  // without an anchor, the first hit is beat 0
  const st2 = BB.toSteps(hits, 100, null);
  assert.ok(st2.steps.kick[0] > 0 && st2.steps.chat[2] > 0);
});

test('beatbox: just two sounds, or silence', () => {
  const BB = require('../js/beatbox.js');
  const two = BB.analyze(beatbox('K.H.K.H.K.H.KKH.', 120).samples, 44100).map((h) => h.drum);
  eq(two, ['kick', 'chat', 'kick', 'chat', 'kick', 'chat', 'kick', 'kick', 'chat']);
  const ks = BB.analyze(beatbox('K...S...K...S...', 110).samples, 44100).map((h) => h.drum);
  eq(ks, ['kick', 'snare', 'kick', 'snare']);
  assert.strictEqual(BB.analyze(new Float32Array(44100), 44100).length, 0);
  assert.strictEqual(BB.toSteps([], 120, null), null);
});

test('song id for My songs: kept when valid, dropped when not', () => {
  const p = PJ.blank();
  assert.strictEqual(PJ.normalize({ ...JSON.parse(PJ.serialize(p)), songId: 'slx9k2abc12' }).songId, 'slx9k2abc12');
  for (const bad of ['', 'x123456', 's1', 42, '<script>']) assert.strictEqual(PJ.normalize({ ...JSON.parse(PJ.serialize(p)), songId: bad }).songId, null);
});

test('MIDI import: every example survives export -> import, note for note', () => {
  const MI = require('../js/midiimport.js');
  const dir = path.join(__dirname, '..', 'examples');
  // what plays, per track: [time, pitch-or-drum, length], sorted
  const playing = (p) => {
    const { items, length } = PJ.playItems(p, 'song');
    const out = {};
    PJ.eventsIn(p, items, 0, length, (ev) => {
      (out[ev.track.name] = out[ev.track.name] || []).push(ev.kind === 'note'
        ? [Math.round(ev.at * 1000), ev.pitch, Math.round(ev.len * 1000)]
        : [Math.round(ev.at * 1000), ev.drum]);
    });
    for (const k of Object.keys(out)) out[k].sort((a, b) => a[0] - b[0] || String(a[1]).localeCompare(String(b[1])) || (a[2] || 0) - (b[2] || 0));
    return out;
  };
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json') && x !== 'catalog.json')) {
    const orig = PJ.normalize(JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
    for (const t of orig.tracks) { t.mute = false; t.solo = false; if (t.kit) for (const k of t.kit) { k.mute = false; k.solo = false; } }
    const bytes = E.writeMidiTracks(PJ.midiTracks(orig, 'song'), orig.bpm, orig.markers);
    const back = PJ.normalize(MI.toProject(bytes, f));
    assert.strictEqual(back.bpm, orig.bpm, f + ': tempo');
    const a = playing(orig), b = playing(back);
    for (const name of Object.keys(a)) {
      assert.ok(b[name], f + ': track "' + name + '" is missing');
      eq(b[name], a[name]);
    }
    for (const t of orig.tracks.filter((x) => x.type === 'synth' && a[x.name])) assert.strictEqual(back.tracks.find((x) => x.name === t.name).instrument, t.instrument, f + ': instrument of ' + t.name);
    eq(back.markers.map((m) => [m.beat, m.name]), orig.markers.map((m) => [m.beat, m.name]));
    // repeats come back as patterns used more than once, not one pattern per block
    assert.ok(back.patterns.length < back.clips.length + back.tracks.length, f + ': ' + back.patterns.length + ' patterns for ' + back.clips.length + ' clips');
  }
  assert.throws(() => MI.toProject(new Uint8Array([1, 2, 3, 4]), 'x.mid'), /not a MIDI file/);
});

test('Sampler sound reference: kept when valid, cleaned up, dropped when not', () => {
  const p = PJ.blank();
  const syn = p.tracks.find((t) => t.type === 'synth');
  syn.instrument = 'sampler';
  syn.sampler = { hash: 'abcdef012345', name: 'ooh.wav', root: 69.2, gain: 3 };
  let back = PJ.normalize(JSON.parse(PJ.serialize(p))).tracks.find((t) => t.type === 'synth');
  assert.strictEqual(back.instrument, 'sampler');
  eq(back.sampler, { hash: 'abcdef012345', name: 'ooh.wav', root: 69.2, gain: 3 });
  syn.sampler = { hash: 'nope', name: 'x' };
  back = PJ.normalize(JSON.parse(PJ.serialize(p))).tracks.find((t) => t.type === 'synth');
  assert.strictEqual(back.sampler, undefined);
  syn.sampler = { hash: 'abcdef012345', root: 500, gain: 0 };
  back = PJ.normalize(JSON.parse(PJ.serialize(p))).tracks.find((t) => t.type === 'synth');
  eq(back.sampler, { hash: 'abcdef012345', name: 'sound', root: 127, gain: 0.05 });
});

test('history undo/redo', () => {
  const h = new PJ.History();
  h.push('a'); h.push('b');
  assert.strictEqual(h.back('c'), 'b');
  assert.strictEqual(h.back('b'), 'a');
  assert.strictEqual(h.forward('a'), 'b');
  h.push('x');
  assert.strictEqual(h.redo.length, 0);
});

(async () => {
  for (const [name, fn] of tests) { await fn(); passed++; console.log('  ok  ' + name); }
  console.log(passed + ' tests passed');
})().catch((e) => { console.error(e); process.exit(1); });
