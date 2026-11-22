/* Writes examples/tidewater.browserdj.json: "Tidewater".
   E minor, Em7 - Am7 - Cmaj7 - Bm7. Starts as an 86 BPM neo-soul groove: electric piano with tremolo, a marimba
   figure drifting left and right, a flute melody over a lo-fi kit and a sub. A lift with strings and brass, then
   the tempo doubles to 172 for a drum & bass section: breakbeat, a sliding Reese bass, strings and brass stabs, and
   the flute melody at half speed so it floats over the drums. A break, then back down to 86 for the outro, where a
   split clip picks the melody up half-way through.
   Shows off: the new instruments, chord progressions (voiced by HumEngine), tempo changes, EQ, split clips (off),
   drum kit styles and rolls, slides, Movement (LFOs) and automation.
   Run: node tools/make-tidewater.js && node tools/pack-examples.js */
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

const BAR = 4, ROOT = 4, SCALE = 'minor'; // E minor
let id = 1;
const nid = () => id++;
const notes = (list, vel = 100) => list.map(([pitch, start, len, v, slide]) => ({ id: nid(), start, len, pitch, vel: v || vel, ...(slide ? { slide: true } : {}) }));
const steps = (bars, s) => Array.from({ length: bars * 16 }, (_, i) => ({ '.': 0, g: 40, o: 62, x: 100, X: 124 }[s[i % s.length]] || 0));

/* ---------- harmony: i - iv - VI - v with sevenths ---------- */
const DEGREES = [0, 3, 5, 4];
const steps7 = E.SCALES[SCALE].steps;
const CH = E.progressionChords(ROOT, SCALE, DEGREES).map((c) => {
  // add the seventh (scale degree d + 6) inside the voiced triad, close to its other notes
  const pc = (ROOT + steps7[(c.degree + 6) % 7]) % 12;
  let q = c.pitches[0] + 1;
  while (q % 12 !== pc) q++;
  return { pitches: [...c.pitches, q].sort((x, y) => x - y), triad: c.pitches, bass: c.bass, degree: c.degree };
});
const ROOTS = [40, 45, 36, 35]; // E2 A2 C2 B1: close together, stepping down to B and up to E again

/* ---------- tracks ---------- */
const kit = (over) => ['kick', 'hkick', 'snare', 'clap', 'chat', 'ohat', 'tom', 'rim', 'crash'].map((k) => ({ id: k, vol: 0.8, mute: false, solo: false, ...(over[k] || {}) }));
const LFO_OFF = { target: 'off', rate: '1/8', depth: 0.6 };
const synth = (name, color, instrument, o) => ({ id: nid(), type: 'synth', name, color, instrument, volume: 0.6, pan: 0, drive: 0, filter: 0.5, reverb: 0, pump: 0, echoSend: 0,
  shape: { attack: 0, release: 0, tone: 0.5, glide: 0.3 }, lfo: LFO_OFF, ...o });
const T = {
  lofi: { id: nid(), type: 'drums', name: 'Lo-fi kit', color: '#58d6c5', kitStyle: 'lofi', volume: 0.66, pan: 0, drive: 0.12, filter: 0.5, reverb: 0.08, pump: 0, echoSend: 0, swing: 0.22,
    eq: { high: -3 }, kit: kit({ kick: { vol: 0.95 }, snare: { vol: 0.8 }, chat: { vol: 0.5 }, rim: { vol: 0.6 }, ohat: { vol: 0.45 } }) },
  breaks: { id: nid(), type: 'drums', name: 'Breaks', color: '#3fbfa8', kitStyle: 'acoustic', volume: 0.84, pan: 0, drive: 0.06, filter: 0.5, reverb: 0.1, pump: 0, echoSend: 0, swing: 0,
    eq: { low: 2, high: 2.5 }, kit: kit({ kick: { vol: 1 }, snare: { vol: 0.9 }, chat: { vol: 0.5 }, ohat: { vol: 0.45 }, crash: { vol: 0.55 }, tom: { vol: 0.7 } }) },
  sub: synth('Sub', '#a58bff', 'sub', { volume: 0.62, pump: 0.25 }),
  reese: synth('Reese', '#8b6bff', 'reese', { volume: 0.56, drive: 0.15, pump: 0.3, eq: { low: -9, mid: 4 }, shape: { attack: 0, release: 0.1, tone: 0.55, glide: 0.45 },
    lfo: { target: 'filter', rate: '1/2', depth: 0.25 } }),
  ep: synth('Electric piano', '#ff7a59', 'ep', { volume: 0.58, pan: -0.08, reverb: 0.3, echoSend: 0.12, eq: { low: -4, high: 1.5 }, shape: { attack: 0, release: 0.4, tone: 0.5, glide: 0.3 },
    lfo: { target: 'volume', rate: '1/8T', depth: 0.28 } }),
  marimba: synth('Marimba', '#ffe066', 'marimba', { volume: 0.42, reverb: 0.25, echoSend: 0.2, lfo: { target: 'pan', rate: '1/1', depth: 0.55 } }),
  flute: synth('Flute', '#b5e36b', 'flute', { volume: 0.5, pan: 0.1, reverb: 0.42, echoSend: 0.25, eq: { mid: 1.5 }, shape: { attack: 0.1, release: 0.3, tone: 0.5, glide: 0.3 } }),
  strings: synth('Strings', '#5fb4ff', 'strings', { volume: 0.55, reverb: 0.5, pump: 0.35, eq: { low: -6 }, shape: { attack: 0.3, release: 0.45, tone: 0.48, glide: 0.3 } }),
  brass: synth('Brass', '#ffb04f', 'brass', { volume: 0.4, pan: -0.15, reverb: 0.3, echoSend: 0.15, eq: { low: -3, high: 1 } }),
};

/* ---------- patterns ---------- */
const P = {};
const pat = (key, track, name, body) => { P[key] = { id: nid(), trackId: track.id, name, ...body }; return P[key]; };

// electric piano: each chord held, re-struck lighter on the "and" of 3; at 172 every chord lasts two bars
const epBar = (c, at, span) => c.pitches.flatMap((p) => [[p, at, span * 0.6, 92], [p, at + span * 0.625, span * 0.375, 74]]);
pat('ep', T.ep, 'Chords', { bars: 4, notes: notes(CH.flatMap((c, b) => epBar(c, b * BAR, BAR))) });
pat('epSlow', T.ep, 'Chords (2 bars each)', { bars: 8, notes: notes(CH.flatMap((c, b) => epBar(c, b * 2 * BAR, 2 * BAR))) });

// marimba: eighths walking up and down each chord an octave up
const MORDER = [0, 2, 1, 3, 2, 1, 3, 2];
pat('marimba', T.marimba, 'Ripples', { bars: 4, notes: notes(CH.flatMap((c, b) => MORDER.map((k, s) => [c.pitches[k] + 12, b * BAR + s * 0.5, 0.5, s % 2 ? 78 : 96]))) });

// sub: the root, pushed a little ahead of the bar
pat('sub', T.sub, 'Sub', { bars: 4, notes: notes(ROOTS.flatMap((r, b) => [[r, b * BAR, 1.5, 108], [r, b * BAR + 2.5, 0.5, 90], [r, b * BAR + 3, 1, 100]])) });
pat('subLong', T.sub, 'Sub (long)', { bars: 8, notes: notes(ROOTS.flatMap((r, b) => [[r, b * 8, 6, 110], [r, b * 8 + 6.5, 1.5, 96]])) });

// Reese: two bars per chord, an octave pop and slides into the next root
pat('reese', T.reese, 'Reese', {
  bars: 8,
  notes: notes(ROOTS.flatMap((r, b) => {
    const at = b * 8, next = ROOTS[(b + 1) % 4];
    return [[r, at, 2.5, 112], [r + 12, at + 2.5, 0.5, 96, true], [r, at + 3, 1, 104, true], [r, at + 4.5, 2, 108], [r + 7, at + 6.5, 0.5, 92], [next, at + 7, 1, 100, true]];
  })),
});

// strings: two bars per chord, the triad an octave up with the root doubled below
pat('strings', T.strings, 'Strings', { bars: 8, notes: notes(CH.flatMap((c, b) => [...c.triad.map((p) => [p + 12, b * 8, 8, 86]), [c.bass + 12, b * 8, 8, 80]])) });
pat('swell', T.strings, 'Swell', { bars: 4, notes: notes(CH.flatMap((c, b) => c.triad.map((p) => [p + 12, b * BAR, BAR, 70 + b * 12]))) });

// brass: short stabs. At 86, one on the last eighth of every bar of the lift; at 172, on the "and" of 2 and on 4
const stab = (c, at, len, v) => c.triad.map((p) => [p, at, len, v]);
pat('brassLift', T.brass, 'Stabs (lift)', { bars: 4, notes: notes(CH.flatMap((c, b) => [...stab(c, b * BAR, 1, 96), ...stab(CH[(b + 1) % 4], b * BAR + 3.5, 0.5, 108)])) });
pat('brass', T.brass, 'Stabs', { bars: 8, notes: notes(CH.flatMap((c, b) => [...stab(c, b * 8 + 1.5, 0.4, 104), ...stab(c, b * 8 + 3, 0.6, 96), ...stab(c, b * 8 + 5.5, 0.4, 100), ...stab(c, b * 8 + 7.5, 0.5, 110)])) });

// the melody: 8 bars at 86, a question and its answer, landing on E
const MEL = [
  [71, 0, 1], [74, 1, 0.5], [76, 1.5, 1.5], [79, 3, 0.5], [78, 3.5, 0.5],
  [76, 4, 1], [72, 5, 1], [74, 6, 0.5], [76, 6.5, 1.5],
  [79, 8, 1.5], [78, 9.5, 0.5], [76, 10, 1], [71, 11, 1],
  [78, 12, 1.5], [76, 13.5, 0.5], [74, 14, 2],
  [71, 16, 0.5], [74, 16.5, 0.5], [76, 17, 1], [79, 18, 1], [81, 19, 1],
  [83, 20, 1.5], [81, 21.5, 0.5], [79, 22, 1], [76, 23, 1],
  [79, 24, 1], [76, 25, 0.5], [74, 25.5, 0.5], [72, 26, 1.5], [71, 27.5, 0.5],
  [74, 28, 1], [78, 29, 1], [76, 30, 2],
];
pat('flute', T.flute, 'Melody', { bars: 8, notes: notes(MEL.map(([p, s, l], i) => [p, s, l, i % 4 === 0 ? 108 : 96])) });
// at 172 the same melody with every length doubled: it sounds just as it did at 86
pat('fluteHalf', T.flute, 'Melody (half speed)', { bars: 16, notes: notes(MEL.map(([p, s, l], i) => [p, s * 2, l * 2, i % 4 === 0 ? 110 : 98])) });

// drums
const D = (key, track, name, bars, rows, rolls) => pat(key, track, name, {
  bars, steps: Object.fromEntries(Object.entries(rows).map(([k, s]) => [k, steps(bars, s)])),
  ...(rolls ? { rolls: Object.fromEntries(Object.entries(rolls).map(([k, s]) => [k, Array.from({ length: bars * 16 }, (_, i) => +(s[i % s.length]) || 0)])) } : {}),
});
D('lofi', T.lofi, 'Lo-fi beat', 2, {
  kick: 'X.....x...x.....' + 'X.....x..x..x...', snare: '....x.......x...' + '....x.......x..g', chat: 'x.o.x.o.x.o.x.o.' + 'x.o.x.o.x.o.xoo.', rim: '..........g.....' + '.......g........',
});
D('lofiFill', T.lofi, 'Lo-fi fill', 1, { kick: 'X.....x...x.....', snare: '....x...x.x.xxxx', chat: 'x.o.x.o.x.......' }, { snare: '............2233' });
D('lift', T.lofi, 'Lift', 4, {
  kick: 'X.......X.......' + 'X.......X.......' + 'X...X...X...X...' + 'X.X.X.X.XXXXXXXX',
  snare: '................' + '....x.......x...' + '..x...x...x...x.' + 'x.x.x.x.xxxxXXXX', chat: 'x.x.x.x.x.x.x.x.',
  ohat: '..............x.' + '..............x.' + '..x...x...x...x.' + '................',
}, { chat: '0000000000000000' + '0000000000000000' + '0002000200020002' + '0000000000000000', snare: '0000000000000000' + '0000000000000000' + '0000000000000000' + '0000000033334444' });
D('dnb', T.breaks, 'Break', 2, {
  kick: 'X.........X.....' + '..X.......X.....', snare: '....X.......X...' + '....X..g....X..g', chat: 'x.x.x.x.x.x.x.x.' + 'x.x.x.x.x.x.x.xx', ohat: '..............x.' + '......x.........',
});
D('dnbCrash', T.breaks, 'Break + crash', 2, {
  kick: 'X.........X.....' + '..X.......X.....', snare: '....X.......X...' + '....X..g....X..g', chat: '..x.x.x.x.x.x.x.' + 'x.x.x.x.x.x.x.xx', crash: 'x...............',
});
D('dnbFill', T.breaks, 'Break fill', 1, { kick: 'X.........X.....', snare: '....X..g.XX.XXXX', tom: '..........x.x...', chat: 'x.x.x.x.' }, { snare: '0000000000000023' });
D('outro', T.lofi, 'Outro beat', 1, { kick: 'X.........x.....', rim: '....x.......x...', chat: 'x.o.x.o.x.o.x.o.' });

/* ---------- arrangement (in bars; from bar 28 on each bar is twice as quick) ---------- */
const clips = [];
const clip = (p, bar, bars, off) => clips.push({ id: nid(), trackId: p.trackId, patternId: p.id, start: bar * BAR, len: bars * BAR, ...(off ? { off: off * BAR } : {}) });
// intro 1-8 (86): electric piano, the marimba joins at 5
clip(P.ep, 0, 28);
clip(P.marimba, 4, 20);
// verse 9-24: beat, sub, the melody twice
clip(P.lofi, 8, 15); clip(P.lofiFill, 23, 1);
clip(P.sub, 8, 16);
clip(P.flute, 8, 16);
// lift 25-28: strings swell, brass, the beat builds
clip(P.lift, 24, 4);
clip(P.swell, 24, 4);
clip(P.brassLift, 24, 4);
clip(P.sub, 24, 4);
// drop 29-60 (172): break, Reese, sub, strings, stabs; the melody at half speed from 37
clip(P.dnbCrash, 28, 2); clip(P.dnb, 30, 13); clip(P.dnbFill, 43, 1);
clip(P.dnbCrash, 44, 2); clip(P.dnb, 46, 13); clip(P.dnbFill, 59, 1);
clip(P.reese, 28, 32);
clip(P.subLong, 28, 32);
clip(P.strings, 28, 32);
clip(P.brass, 44, 16);
clip(P.marimba, 44, 16); // at 172 the ripples run twice as fast
clip(P.fluteHalf, 36, 16);
// break 61-68 (172): electric piano and strings alone, the second half of the melody
clip(P.epSlow, 60, 8);
clip(P.strings, 60, 8);
clip(P.fluteHalf, 60, 8, 8); // a split clip: starts 8 bars into its pattern
// outro 69-76 (86 again): the first groove, and the melody's last phrase (off: 4 bars in)
clip(P.ep, 68, 8);
clip(P.marimba, 68, 8);
clip(P.outro, 68, 6);
clip(P.sub, 68, 4);
clip(P.flute, 72, 4, 4);

/* ---------- tempo, automation (song beats), markers ---------- */
const tempo = [{ b: 28 * BAR, bpm: 172 }, { b: 68 * BAR, bpm: 86 }];
T.ep.auto = {
  filter: [{ b: 0, v: 0.2 }, { b: 28, v: 0.5 }],                                  // the intro opens up
  volume: [{ b: 100, v: 0.58 }, { b: 112, v: 0.3 }, { b: 240, v: 0.3 }, { b: 244, v: 0.58 }, { b: 288, v: 0.58 }, { b: 304, v: 0 }], // steps back for the strings, fades at the end
};
T.lofi.auto = { filter: [{ b: 96, v: 0.5 }, { b: 111.5, v: 0.78 }, { b: 112, v: 0.5 }] }; // the lift thins out into the drop
// the sub sits back in the groove and comes forward for the drop
T.sub.auto = { volume: [{ b: 0, v: 0.5 }, { b: 111.9, v: 0.5 }, { b: 112, v: 0.64 }, { b: 271.9, v: 0.64 }, { b: 272, v: 0.5 }] };
T.strings.auto = { volume: [{ b: 96, v: 0.15 }, { b: 112, v: 0.55 }] };
T.reese.auto = { filter: [{ b: 112, v: 0.22 }, { b: 128, v: 0.5 }] };                  // the Reese opens up over the first 4 bars
T.flute.auto = { reverb: [{ b: 240, v: 0.42 }, { b: 244, v: 0.7 }, { b: 272, v: 0.7 }, { b: 280, v: 0.42 }] };
T.marimba.auto = { volume: [{ b: 288, v: 0.42 }, { b: 304, v: 0.1 }] };

const project = {
  version: 2, name: 'Tidewater', bpm: 86, root: ROOT, scale: SCALE, snap: 16, loop: true, click: false, mode: 'song',
  capture: { detail: 0.5, fixTuning: true, playBeat: false, mode: 'melody' },
  master: 0.85, loud: 0.25, region: null, tempo, tempoOpen: true,
  markers: [
    { id: nid(), beat: 0, name: 'Intro' }, { id: nid(), beat: 32, name: 'Verse' }, { id: nid(), beat: 96, name: 'Lift' },
    { id: nid(), beat: 112, name: 'Drop (172)' }, { id: nid(), beat: 240, name: 'Break' }, { id: nid(), beat: 272, name: 'Outro (86)' },
  ],
  tracks: [T.lofi, T.breaks, T.sub, T.reese, T.ep, T.marimba, T.flute, T.strings, T.brass],
  patterns: Object.values(P),
  clips,
  sel: { trackId: T.flute.id, patternId: P.flute.id },
  nextId: id,
};

const out = path.join(__dirname, '..', 'examples', 'tidewater.browserdj.json');
fs.writeFileSync(out, JSON.stringify(project, null, 1));
console.log('wrote', path.relative(process.cwd(), out), '-', clips.length, 'clips,', Object.keys(P).length, 'patterns;',
  'chords', CH.map((c) => c.pitches.join('/')).join('  '));
