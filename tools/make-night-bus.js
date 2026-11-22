/* Writes examples/night-bus.browserdj.json: "Night Bus".
   UK garage at 132 BPM in F minor, Fm9 - Dbmaj7 - Ab - Eb. A two-step beat with swung hats, organ stabs and a bass
   that skip on the swung 16ths, a glassy pluck that writes itself (every note has a chance, so no two passes are
   the same), a pad and a bell hook that comes in after the break.
   Shows off: swing on synth tracks, Chance on notes and drum steps, chord progressions (voiced by HumEngine),
   slides, pump, EQ and automation.
   Run: node tools/make-night-bus.js && node tools/pack-examples.js */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// the browser's engine voices the chords, the same way the Chords... menu does
const ctx = { Math, Float32Array, Uint8Array, Array, Object, Map, Set, JSON, Number, String, isFinite, TextEncoder };
ctx.window = ctx;
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'js', 'engine.js'), 'utf8').replace('const HumEngine =', 'var HumEngine ='), ctx);
const E = ctx.HumEngine;

const BAR = 4, ROOT = 5, SCALE = 'minor', SWING = 0.38; // F minor; the same swing on drums, bass, organ and pluck
let id = 1;
const nid = () => id++;
// [pitch, start, len, vel, slide, chance]
const notes = (list, vel = 100) => list.map(([pitch, start, len, v, slide, chance]) => ({ id: nid(), start, len, pitch, vel: v || vel, ...(slide ? { slide: true } : {}), ...(chance && chance < 100 ? { chance } : {}) }));
const steps = (bars, s) => Array.from({ length: bars * 16 }, (_, i) => ({ '.': 0, g: 40, o: 62, x: 100, X: 124 }[s[i % s.length]] || 0));
// chance per step: 7 = 75%, 5 = 50%, 2 = 25%, 1 = 10%; '.' = always
const chances = (bars, s) => Array.from({ length: bars * 16 }, (_, i) => ({ 7: 75, 5: 50, 2: 25, 1: 10 }[s[i % s.length]] || 0));

/* ---------- harmony: i - VI - III - VII ---------- */
const DEGREES = [0, 5, 2, 6];
const st = E.SCALES[SCALE].steps;
const CH = E.progressionChords(ROOT, SCALE, DEGREES).map((c) => {
  // add the seventh inside the voiced triad (Fm7, Dbmaj7, Abmaj7, Eb7), close to its other notes
  const pc = (ROOT + st[(c.degree + 6) % 7]) % 12;
  let q = c.pitches[0] + 1;
  while (q % 12 !== pc) q++;
  return { pitches: [...c.pitches, q].sort((x, y) => x - y), triad: c.pitches, bass: c.bass, degree: c.degree };
});
const ROOTS = [41, 37, 44, 39]; // F2 Db2 Ab2 Eb2
// the F minor pentatonic over two octaves, for the pluck
const PENTA = [65, 68, 70, 72, 75, 77, 80, 82, 84, 87];

/* ---------- tracks ---------- */
const kit = (over) => ['kick', 'hkick', 'snare', 'clap', 'chat', 'ohat', 'tom', 'rim', 'crash'].map((k) => ({ id: k, vol: 0.8, mute: false, solo: false, ...(over[k] || {}) }));
const LFO_OFF = { target: 'off', rate: '1/8', depth: 0.6 };
const synth = (name, color, instrument, o) => ({ id: nid(), type: 'synth', name, color, instrument, volume: 0.6, pan: 0, drive: 0, filter: 0.5, reverb: 0, pump: 0, echoSend: 0,
  shape: { attack: 0, release: 0, tone: 0.5, glide: 0.3 }, lfo: LFO_OFF, ...o });
const T = {
  drums: { id: nid(), type: 'drums', name: 'Two-step', color: '#58d6c5', kitStyle: 'classic', volume: 0.8, pan: 0, drive: 0.08, filter: 0.5, reverb: 0.06, pump: 0, echoSend: 0, swing: SWING,
    eq: { low: 1.5, high: 1.5 }, kit: kit({ kick: { vol: 0.95 }, snare: { vol: 0.75 }, clap: { vol: 0.6 }, chat: { vol: 0.55 }, ohat: { vol: 0.45 }, rim: { vol: 0.55 }, crash: { vol: 0.5 } }) },
  bass: synth('Bass', '#a58bff', 'bass', { volume: 0.62, pump: 0.2, drive: 0.12, swing: SWING, eq: { mid: 2 }, shape: { attack: 0, release: 0.08, tone: 0.45, glide: 0.25 } }),
  organ: synth('Organ', '#ff7a59', 'organ', { volume: 0.4, pan: -0.06, reverb: 0.22, echoSend: 0.12, pump: 0.35, swing: SWING, eq: { low: -6, high: -1.5 },
    shape: { attack: 0, release: 0.12, tone: 0.5, glide: 0.3 } }),
  pluck: synth('Glass', '#ffe066', 'pluck', { volume: 0.4, pan: 0.12, reverb: 0.35, echoSend: 0.3, swing: SWING, eq: { low: -5, high: 1 },
    lfo: { target: 'pan', rate: '1/2', depth: 0.45 } }),
  pad: synth('Pad', '#5fb4ff', 'pad', { volume: 0.38, reverb: 0.5, pump: 0.45, eq: { low: -8 }, shape: { attack: 0.35, release: 0.5, tone: 0.45, glide: 0.3 } }),
  bell: synth('Bell hook', '#ffb04f', 'bell', { volume: 0.4, pan: -0.1, reverb: 0.38, echoSend: 0.28, eq: { low: -4 } }),
};

/* ---------- patterns ---------- */
const P = {};
const pat = (key, track, name, body) => { P[key] = { id: nid(), trackId: track.id, name, ...body }; return P[key]; };

// organ: short stabs that skip on the swung 16ths (the "a" of 1, the "e" of 3), and one on the "and" of 2
const STABS = [[0.75, 0.25, 104], [1.5, 0.3, 92], [2.25, 0.25, 98], [3.5, 0.3, 88]];
pat('organ', T.organ, 'Stabs', { bars: 4, notes: notes(CH.flatMap((c, b) => STABS.flatMap(([s, l, v]) => c.pitches.map((p) => [p, b * BAR + s, l, v])))) });
// intro: just the first stab of each bar, held a little longer
pat('organIntro', T.organ, 'Stabs (sparse)', { bars: 4, notes: notes(CH.flatMap((c, b) => c.pitches.map((p) => [p, b * BAR + 0.75, 0.75, 92]))) });

// bass: the root on 1, a swung pickup, an octave pop that slides back down, and a push into the next bar
pat('bass', T.bass, 'Bassline', {
  bars: 4,
  notes: notes(ROOTS.flatMap((r, b) => {
    const at = b * BAR, next = ROOTS[(b + 1) % 4];
    return [[r, at, 0.7, 116], [r, at + 0.75, 0.25, 92], [r + 12, at + 1.75, 0.25, 100], [r, at + 2.5, 0.5, 108, true], [r, at + 3.25, 0.25, 90], [next, at + 3.5, 0.5, 98, true, 75]];
  })),
});

// the pluck writes itself: a 16th line over the chord, the notes on the beat always play, the rest each have a chance
const nearestChordTone = (c, p) => { let best = PENTA[0]; for (const q of PENTA) if (c.pitches.some((x) => x % 12 === q % 12) && Math.abs(q - p) < Math.abs(best - p)) best = q; return best; };
const CONTOUR = [0, 2, 4, 3, 5, 4, 2, 6, 7, 5, 4, 3, 2, 4, 1, 0];
const pluckNotes = [];
CH.forEach((c, b) => {
  for (let s = 0; s < 16; s++) {
    const want = PENTA[(CONTOUR[s] + b) % PENTA.length];
    const p = s % 4 === 0 ? nearestChordTone(c, want) : want;
    const ch = s % 4 === 0 ? 100 : s % 2 === 0 ? 70 : 40;
    pluckNotes.push([p, b * BAR + s * 0.25, 0.25, s % 4 === 0 ? 104 : 82 + (s % 3) * 6, false, ch]);
  }
});
pat('pluck', T.pluck, 'Glass (left to chance)', { bars: 4, notes: notes(pluckNotes) });
// the break: sparser, longer notes, more space
pat('pluckSparse', T.pluck, 'Glass (sparse)', { bars: 4, notes: notes(pluckNotes.filter((n, i) => i % 2 === 0).map(([p, s, , v, , ch]) => [p, s, 0.5, v, false, ch === 100 ? 100 : 45])) });

// pad: the triad, an octave apart from the organ, a whole bar each
pat('pad', T.pad, 'Pad', { bars: 4, notes: notes(CH.flatMap((c, b) => c.triad.map((p) => [p + 12, b * BAR, BAR, 84]))) });

// bell hook: two bars of call, two of answer; the echo of the last note only sometimes
const HOOK = [
  [77, 0, 0.5], [80, 0.75, 0.25], [77, 1.5, 0.5], [75, 2.25, 0.75], [72, 3.25, 0.25, 70],
  [73, 4, 0.5], [77, 4.75, 0.5], [80, 5.5, 1], [82, 6.75, 0.25, 50], [80, 7.25, 0.75],
  [80, 8, 0.5], [84, 8.75, 0.25], [80, 9.5, 0.5], [77, 10.25, 0.75], [75, 11.25, 0.25, 70],
  [75, 12, 0.5], [79, 12.75, 0.5], [77, 13.5, 2], [80, 15.5, 0.25, 25], [82, 15.75, 0.25, 25],
];
pat('bell', T.bell, 'Hook', { bars: 4, notes: notes(HOOK.map(([p, s, l, ch], i) => [p, s, l, i % 5 === 0 ? 110 : 96, false, ch])) });

// drums
const D = (key, name, bars, rows, ch) => pat(key, T.drums, name, {
  bars, steps: Object.fromEntries(Object.entries(rows).map(([k, s]) => [k, steps(bars, s)])),
  ...(ch ? { chance: Object.fromEntries(Object.entries(ch).map(([k, s]) => [k, chances(bars, s)])) } : {}),
});
// the hats: off-beat 8ths always, 16ths in between left to chance; a ghost kick and rim that come and go
D('hats', 'Hats', 1, { chat: '..x.ox.o..x.oxxo', ohat: '..............x.' }, { chat: '....5..2....75.5' });
D('twostep', 'Two-step', 2, {
  kick: 'X.........x.....' + 'X......g..x..g..',
  snare: '....x.......x...',
  chat: '..x.ox.o..x.oxxo',
  ohat: '..............x.',
  rim: '.......g...g....' + '...g.......g...g',
}, { kick: '................' + '.......2.....5..', chat: '....5..2....75.5', rim: '.......5...2....' + '...5.......2...5' });
D('twostepClap', 'Two-step + clap', 2, {
  kick: 'X.........x.....' + 'X......g..x..g..',
  snare: '....x.......x...', clap: '....x.......x...',
  chat: '..x.ox.o..x.oxxo',
  ohat: '..............x.',
  rim: '.......g...g....' + '...g.......g...g',
  crash: 'x...............' + '................',
}, { kick: '................' + '.......2.....5..', chat: '....5..2....75.5', rim: '.......5...2....' + '...5.......2...5' });
D('groove', 'Two-step (no crash)', 2, {
  kick: 'X.........x.....' + 'X......g..x..g..',
  snare: '....x.......x...', clap: '....x.......x...',
  chat: '..x.ox.o..x.oxxo',
  ohat: '..............x.',
  rim: '.......g...g....' + '...g.......g...g',
}, { kick: '................' + '.......2.....5..', chat: '....5..2....75.5', rim: '.......5...2....' + '...5.......2...5' });
D('fill', 'Fill', 1, { kick: 'X.........x.....', snare: '....x...x.x.xxxx', chat: '..x.ox.o', tom: '..........x.x...' }, { snare: '........5.7.7...' });
D('breakRim', 'Rim and hats', 2, { rim: '....x.......x...', chat: '..x...x...x...x.', ohat: '..............x.' }, { chat: '......5.......2.' });

/* ---------- arrangement (in bars) ---------- */
const clips = [];
const clip = (p, bar, bars, off) => clips.push({ id: nid(), trackId: p.trackId, patternId: p.id, start: bar * BAR, len: bars * BAR, ...(off ? { off: off * BAR } : {}) });
// intro 1-8: the sparse organ and the pad; hats from 5, the pluck creeps in
clip(P.organIntro, 0, 8);
clip(P.pad, 0, 8);
clip(P.hats, 4, 4);
clip(P.pluckSparse, 4, 4);
// verse 9-24: the two-step, bass, stabs; the pluck sparse at first, then the full line
clip(P.twostep, 8, 15); clip(P.fill, 23, 1);
clip(P.bass, 8, 16);
clip(P.organ, 8, 16);
clip(P.pluckSparse, 8, 8); clip(P.pluck, 16, 8);
clip(P.pad, 16, 8);
// break 25-32: rim and hats, pad, sparse pluck, the hook appears; the bass comes back for the last two bars
clip(P.breakRim, 24, 8);
clip(P.pad, 24, 8);
clip(P.pluckSparse, 24, 8);
clip(P.bell, 28, 4);
clip(P.bass, 30, 2, 2);
// drop 33-48: everything, with the clap and the hook
clip(P.twostepClap, 32, 2); clip(P.groove, 34, 13); clip(P.fill, 47, 1);
clip(P.bass, 32, 16);
clip(P.organ, 32, 16);
clip(P.pluck, 32, 16);
clip(P.pad, 32, 16);
clip(P.bell, 32, 16);
// outro 49-56: back down to the organ, hats and the pluck
clip(P.organ, 48, 8);
clip(P.hats, 48, 6);
clip(P.pluck, 48, 8);
clip(P.pad, 48, 8);
clip(P.bass, 48, 4);

/* ---------- automation (song beats), markers ---------- */
T.pad.auto = { filter: [{ b: 0, v: 0.25 }, { b: 32, v: 0.5 }, { b: 96, v: 0.5 }, { b: 124, v: 0.72 }, { b: 128, v: 0.5 }] }; // opens up through the break
T.organ.auto = { filter: [{ b: 0, v: 0.38 }, { b: 32, v: 0.5 }], volume: [{ b: 192, v: 0.4 }, { b: 224, v: 0 }] };
T.drums.auto = { filter: [{ b: 112, v: 0.5 }, { b: 127.5, v: 0.74 }, { b: 128, v: 0.5 }] }; // the break thins out into the drop
T.pluck.auto = { echo: [{ b: 96, v: 0.3 }, { b: 100, v: 0.55 }, { b: 128, v: 0.55 }, { b: 132, v: 0.3 }], volume: [{ b: 208, v: 0.4 }, { b: 224, v: 0 }] };
T.pad.auto.volume = [{ b: 0, v: 0.52 }, { b: 28, v: 0.52 }, { b: 32, v: 0.38 }, { b: 200, v: 0.38 }, { b: 224, v: 0 }]; // fuller in the intro
// the drop leans on the bass and the beat a little more than the verse
T.bass.auto = { volume: [{ b: 32, v: 0.56 }, { b: 127.9, v: 0.56 }, { b: 128, v: 0.66 }, { b: 191.9, v: 0.66 }, { b: 192, v: 0.56 }] };
T.drums.auto.volume = [{ b: 32, v: 0.74 }, { b: 127.9, v: 0.74 }, { b: 128, v: 0.84 }, { b: 191.9, v: 0.84 }, { b: 192, v: 0.74 }];

const project = {
  version: 2, name: 'Night Bus', bpm: 132, root: ROOT, scale: SCALE, snap: 16, loop: true, click: false, mode: 'song',
  capture: { detail: 0.5, fixTuning: true, playBeat: false, mode: 'melody' },
  master: 0.85, loud: 0.2, region: null, tempo: [], tempoOpen: false,
  markers: [
    { id: nid(), beat: 0, name: 'Intro' }, { id: nid(), beat: 32, name: 'Verse' }, { id: nid(), beat: 96, name: 'Break' },
    { id: nid(), beat: 128, name: 'Drop' }, { id: nid(), beat: 192, name: 'Outro' },
  ],
  tracks: [T.drums, T.bass, T.organ, T.pluck, T.pad, T.bell],
  patterns: Object.values(P),
  clips,
  sel: { trackId: T.pluck.id, patternId: P.pluck.id },
  nextId: id,
};

const out = path.join(__dirname, '..', 'examples', 'night-bus.browserdj.json');
fs.writeFileSync(out, JSON.stringify(project, null, 1));
console.log('wrote', path.relative(process.cwd(), out), '-', clips.length, 'clips,', Object.keys(P).length, 'patterns;',
  'chords', CH.map((c) => c.pitches.join('/')).join('  '), '; pluck chance notes', pluckNotes.filter((n) => n[5] < 100).length);
