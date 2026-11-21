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
const test = (name, fn) => { fn(); passed++; console.log('  ok  ' + name); };

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
  const d = PJ.deriveFromTake(p, { raw: seg.notes, tuning: seg.tuning, anchor: null });
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

test('writeMidiTracks writes a valid format-1 file with melody and drums', () => {
  const p = PJ.example();
  const bytes = E.writeMidiTracks(PJ.midiTracks(p), p.bpm);
  const m = parseMidi(bytes);
  assert.strictEqual(m.format, 1);
  assert.strictEqual(m.ppq, 480);
  assert.strictEqual(m.tracks.length, 3);
  const tempo = m.tracks[0].find((e) => e.meta === 0x51).data;
  assert.strictEqual(Math.round(60000000 / ((tempo[0] << 16) | (tempo[1] << 8) | tempo[2])), 124);
  const mel = m.tracks[1].filter((e) => e.type === 0x90);
  assert.strictEqual(mel.length, p.melody.notes.length);
  assert.ok(mel.every((e) => e.ch === 0));
  assert.strictEqual(mel[3].tick, 1.5 * 480);
  const dr = m.tracks[2].filter((e) => e.type === 0x90);
  assert.ok(dr.every((e) => e.ch === 9));
  // four on the floor over 2 bars: 8 kicks on every beat
  const kicks = dr.filter((e) => e.a === 36).map((e) => e.tick);
  eq(kicks, [0, 1, 2, 3, 4, 5, 6, 7].map((b) => b * 480));
});

test('presets, drum length changes and normalize round-trip', () => {
  const p = PJ.blank();
  PJ.applyPreset(p, 'boombap');
  assert.strictEqual(p.drums.rows.find((r) => r.id === 'snare').steps[4], 127);
  PJ.setDrumBars(p, 2);
  const kick = p.drums.rows.find((r) => r.id === 'kick').steps;
  assert.strictEqual(kick.length, 32);
  eq(kick.slice(16), kick.slice(0, 16));
  const back = PJ.normalize(JSON.parse(PJ.serialize(p)));
  eq(back.drums.rows.map((r) => r.steps), p.drums.rows.map((r) => r.steps));
  assert.strictEqual(back.drums.swing, p.drums.swing);
  const junk = PJ.normalize({ bpm: 'x', melody: { notes: [{ start: -5, len: 0, pitch: 300, vel: 0 }] }, drums: { bars: 99 } });
  assert.strictEqual(junk.bpm, 120);
  eq(junk.melody.notes.map((n) => [n.start, n.pitch, n.vel]), [[0, 127, 1]]);
  assert.strictEqual(junk.drums.bars, 8);
});

test('song length grows to fit notes and drums', () => {
  const p = PJ.blank();
  p.bars = 1;
  assert.strictEqual(PJ.songBeats(p), 4);
  p.melody.notes.push({ id: 1, start: 9, len: 1, pitch: 60, vel: 100 });
  assert.strictEqual(PJ.songBeats(p), 12);
  PJ.setDrumBars(p, 4);
  assert.strictEqual(PJ.songBeats(p), 16);
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

console.log(passed + ' tests passed');
