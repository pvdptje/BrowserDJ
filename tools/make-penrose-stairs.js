/* Writes examples/penrose-stairs.browserdj.json: "Penrose Stairs".
   A filter-house disco tune at 118 BPM built like the impossible staircase: it only ever climbs, and ends where it began.
   The loop is i9 - IV9 - VImaj9 - V7#9. Three times the V chord, instead of falling home, is reheard as the relative
   major of a key a major third higher (E is V of A minor and III of C# minor) while a line rises D - D# - E through
   the change: A minor -> C# minor -> F minor -> A minor. Three major thirds make an octave, so the third climb lands
   in the first key, and the last bar's push is the first bar's chord: with Loop on it climbs for ever.
   The melody is two 4-bar phrases written to fit over each other, so it is played as a round: the bell four bars
   behind the flute in C# minor, a saw lead (with slides) behind the flute at home. In the break the harmony moves at
   half speed and the bell plays the first phrase augmented (every note twice as long); the flute joins it in the build.
   Shows off: the round, key changes, filter sweeps and automation, sidechain pump, swing, drum kit styles and rolls,
   slides, Movement (auto-pan, tremolo), EQ.
   Run: node tools/make-penrose-stairs.js && node tools/pack-examples.js */
'use strict';
const fs = require('fs');
const path = require('path');

const BAR = 4, BPM = 118, SWING = 0.28;
let id = 1;
const nid = () => id++;
const r4 = (v) => Math.round(v * 10000) / 10000;
// off-beat sixteenths lean back as far as the drum kit's swing does
const sw = (start) => (Math.round(start * 4) % 2 && Math.abs(start * 4 - Math.round(start * 4)) < 1e-6 ? r4(start + SWING * 0.125) : start);
// notes carry no ids (the app numbers them when it loads the song) and put the pitch first: a transposed copy of a
// pattern then differs in one number per note, which keeps the share link short (a unit test holds it under 8000 characters)
const notes = (list, o = {}) => list.map(([pitch, start, len, vel, slide]) => ({ pitch, start: o.straight ? start : sw(start), len, vel: vel || 100, ...(slide ? { slide: true } : {}) }));

/* ---------- harmony, written in A minor; t moves it to another key ---------- */
const KEY = { A: { t: 0, name: 'A minor' }, Cs: { t: 4, name: 'C# minor' }, F: { t: -4, name: 'F minor' } };
const EPV = [[55, 59, 60, 64], [54, 57, 60, 64], [57, 60, 64, 67], [56, 59, 62, 67]]; // Am9  D9  Fmaj9  E7#9, rootless
const ROOT = [45, 50, 41, 40];
const STR = [[67, 72, 76], [66, 72, 76], [69, 72, 76], [68, 71, 74]];                // three smooth lines
const BRS = [[64, 67, 72], [66, 69, 72], [65, 69, 72], [68, 71, 74]];
const V7 = [56, 59, 62, 64], VMAJ9 = [56, 59, 63, 66];                                // the V chord, then as the next key's III
const tr = (list, t) => list.map((p) => p + t);
const fold = (p, lo, hi) => { while (p < lo) p += 12; while (p > hi) p -= 12; return p; };
const bassRoot = (i, t) => fold(ROOT[i % 4] + t, 40, 51);

/* ---------- the melody: two phrases that fit over each other ---------- */
const PH_A = [
  [76, 0.5, 0.5], [79, 1, 0.5], [76, 1.5, 0.75], [74, 2.5, 0.25], [72, 2.75, 0.25], [74, 3, 0.5], [76, 3.5, 0.5],
  [78, 4, 1.5, 0, 1], [76, 5.5, 0.5], [74, 6, 0.5], [72, 6.5, 0.5], [69, 7, 1],
  [72, 8.5, 0.5], [76, 9, 0.5], [72, 9.5, 0.75], [71, 10.5, 0.25], [69, 10.75, 0.25], [71, 11, 0.5], [72, 11.5, 0.5],
  [71, 12, 1], [74, 13, 0.5], [71, 13.5, 0.5], [68, 14, 1.5],
];
const PH_B = [
  [81, 0, 1.5], [79, 1.5, 0.5], [81, 2, 0.5], [84, 2.5, 1, 0, 1], [83, 3.5, 0.5],
  [81, 4, 0.5], [83, 4.5, 0.5], [84, 5, 1], [83, 6, 0.5], [81, 6.5, 0.5], [78, 7, 1],
  [79, 8, 1.5], [76, 9.5, 0.5], [77, 10, 1], [76, 11, 0.5], [72, 11.5, 0.5],
  [74, 12, 0.5], [76, 12.5, 0.5], [80, 13, 0.5], [83, 13.5, 1], [80, 14.5, 0.5], [76, 15, 1],
];
// phrase starts and long notes a little louder
const phrase = (ph, at, t, o = {}) => ph.map(([p, s, l, , slide], i) => [p + t, at + s * (o.aug || 1), l * (o.aug || 1), (o.vel || 98) + (i === 0 || l >= 1 ? 6 : 0), o.slides && slide]);

/* ---------- tracks ---------- */
// only what differs from the app's defaults is written (it fills in the rest on load): that also keeps the link short
const kit = (over) => Object.entries(over).map(([k, v]) => ({ id: k, ...v }));
const synth = (name, color, instrument, o) => ({ id: nid(), type: 'synth', name, color, instrument, echoSend: 0, ...o });
const T = {
  drums: { id: nid(), type: 'drums', name: 'House kit', color: '#58d6c5', kitStyle: 'classic', volume: 0.8, drive: 0.08, reverb: 0.05, echoSend: 0, swing: SWING,
    eq: { low: 1.5, high: 1 }, kit: kit({ kick: { vol: 1 }, snare: { vol: 0.62 }, clap: { vol: 0.72 }, chat: { vol: 0.42 }, ohat: { vol: 0.4 }, rim: { vol: 0.5 }, tom: { vol: 0.6 }, crash: { vol: 0.5 } }) },
  perc: { id: nid(), type: 'drums', name: 'Clave & congas', color: '#3fbfa8', kitStyle: '808', volume: 0.62, pan: 0.3, reverb: 0.18, echoSend: 0.1, swing: SWING,
    kit: kit({ rim: { vol: 0.7 }, tom: { vol: 0.6 }, chat: { vol: 0.35 } }) },
  bass: synth('Bass', '#a58bff', 'bass', { volume: 0.62, drive: 0.1, pump: 0.45, eq: { mid: 2 } }),
  sub: synth('Sub', '#8b6bff', 'sub', { volume: 0.6, pump: 0.55 }),
  ep: synth('Electric piano', '#ff7a59', 'ep', { volume: 0.46, pan: -0.1, reverb: 0.22, echoSend: 0.1, pump: 0.35, eq: { low: -4, high: 1.5 } }),
  keys: synth('Tremolo piano', '#ff9c7a', 'ep', { volume: 0.5, pan: 0.05, reverb: 0.4, echoSend: 0.1, eq: { low: -3 }, shape: { release: 0.45, tone: 0.46 },
    lfo: { target: 'volume', rate: '1/8T', depth: 0.34 } }),
  marimba: synth('Marimba', '#ffe066', 'marimba', { volume: 0.6, reverb: 0.2, echoSend: 0.22, lfo: { target: 'pan', rate: '1/2', depth: 0.55 } }),
  flute: synth('Flute', '#b5e36b', 'flute', { volume: 0.56, pan: -0.12, reverb: 0.35, echoSend: 0.22, eq: { mid: 1.5 }, shape: { attack: 0.05, release: 0.25 } }),
  bell: synth('Bell', '#ff5c93', 'bell', { volume: 0.42, pan: 0.3, reverb: 0.45, echoSend: 0.3, eq: { low: -4 }, lfo: { target: 'pan', rate: '1/1', depth: 0.3 } }),
  lead: synth('Saw lead', '#ffb04f', 'lead', { volume: 0.75, pan: 0.18, reverb: 0.25, echoSend: 0.18, pump: 0.2, eq: { low: -3 }, shape: { release: 0.2, tone: 0.4, glide: 0.36 } }),
  strings: synth('Strings', '#5fb4ff', 'strings', { volume: 0.46, reverb: 0.45, pump: 0.3, eq: { low: -6 }, shape: { attack: 0.12, release: 0.4 } }),
  brass: synth('Brass', '#ffd27a', 'brass', { volume: 0.78, pan: -0.22, reverb: 0.25, echoSend: 0.12, eq: { low: -3, high: 1 } }),
};

/* ---------- patterns (made the first time a section asks for them) ---------- */
const P = {};
const pat = (key, track, name, body) => (P[key] = { id: nid(), trackId: track.id, name, ...body });
const made = (key, make) => P[key] || make();
const chordAt = (list, at, len, vel) => list.map((p) => [p, at, len, vel]);

// electric piano: stabs between the kicks; every chord arrives an eighth early (the push)
const epBar = (c, next, at) => [...chordAt(c, at + 0.75, 0.25, 84), ...chordAt(c, at + 1.5, 1, 100), ...chordAt(c, at + 2.75, 0.25, 78), ...chordAt(next, at + 3.5, 0.5, 106)];
const ep = (k) => made('ep' + k, () => pat('ep' + k, T.ep, 'Stabs, ' + KEY[k].name, { bars: 4, notes: notes(EPV.flatMap((c, b) => epBar(tr(c, KEY[k].t), tr(EPV[(b + 1) % 4], KEY[k].t), b * BAR))) }));
const firstChord = () => made('first', () => pat('first', T.keys, 'The first chord', { bars: 1, notes: notes(chordAt(EPV[0], 0, 3.5, 78)) }));
// the climb: V7, then the same chord as the next key's III (its seventh raised), then the push of the new key's i9
const epLift = (k, n) => made('epLift' + k, () => pat('epLift' + k, T.ep, 'Climb to ' + KEY[n].name, { bars: 1, notes: notes([
  ...chordAt(tr(V7, KEY[k].t), 1.5, 0.5, 100), ...chordAt(tr(VMAJ9, KEY[k].t), 2.75, 0.5, 96), ...chordAt(tr(EPV[0], KEY[n].t), 3.5, 0.5, 112),
]) }));
// the break: two bars per chord, held, on the tremolo piano
const keysBreak = (k) => made('keys' + k, () => pat('keys' + k, T.keys, 'Held chords, ' + KEY[k].name, { bars: 8, notes: notes(EPV.flatMap((c, b) => [...chordAt(tr(c, KEY[k].t), b * 8, 4, 84), ...chordAt(tr(c, KEY[k].t), b * 8 + 4, 3.75, 66)])) }));

// bass: root and octave between the kicks, a note that leans into the next root; every second bar is busier
const APPROACH = [-2, -1, 3, -1];
const bassBar = (R, next, d, at, busy) => [
  [R, at, 0.45, 112], [R, at + 0.75, 0.2, 84], ...(busy ? [[R, at + 1, 0.2, 74]] : []), [R + 12, at + 1.5, 0.2, 100], [R, at + 2, busy ? 0.25 : 0.4, 104],
  ...(busy ? [[R + 12, at + 2.5, 0.2, 90]] : []), [R + 12, at + 2.75, 0.2, 88], [R + 7, at + 3, 0.25, 96], ...(busy ? [[R + 12, at + 3.25, 0.2, 78]] : []), [next + d, at + 3.5, 0.3, 100],
];
const bass = (k) => made('bass' + k, () => pat('bass' + k, T.bass, 'Bass, ' + KEY[k].name, { bars: 4,
  notes: notes(Array.from({ length: 4 }, (_, b) => bassBar(bassRoot(b, KEY[k].t), bassRoot(b + 1, KEY[k].t), APPROACH[b], b * BAR, b % 2 === 1)).flat()) }));
// the climb: eighths walking up the new key's scale from the old V to the new tonic
const bassLift = (k, n) => made('bassLift' + k, () => {
  const s = fold(bassRoot(0, KEY[n].t) - 9, 40, 51);
  return pat('bassLift' + k, T.bass, 'Walk up to ' + KEY[n].name, { bars: 1, notes: notes([0, 0, 2, 4, 5, 7, 8, 8].map((d, i) => [s + d, i * 0.5, 0.4, 92 + i * 4])) });
});
const SUBROOT = [41, 34, 37, 36]; // F  Bb  Db  C, low
const subBreak = () => made('subBreak', () => pat('subBreak', T.sub, 'Sub (long)', { bars: 8, notes: notes(SUBROOT.flatMap((r, b) => [[r, b * 8, 7.5, 104]])) }));

// marimba: a note every three sixteenths against the four of the beat, walking round the chord of the bar
const marimba = (k) => made('mar' + k, () => {
  const order = [0, 2, 3, 1, 2, 3], out = [];
  let n = 0;
  for (let u = 0; u < 2; u++) for (let s = 0; s < 32; s += 3, n++) {
    const bar = u * 2 + (s >> 4);
    out.push([EPV[bar][order[n % order.length]] + 12 + KEY[k].t, u * 8 + s / 4, 0.25, s % 4 === 0 ? 98 : 80]);
  }
  return pat('mar' + k, T.marimba, 'Threes, ' + KEY[k].name, { bars: 4, notes: notes(out) });
});

// melody: phrase A then phrase B; oct moves it for the other voices of the round
const melody = (track, k, oct, label, o) => made('mel' + track.name + k + oct, () => pat('mel' + track.name + k + oct, track, label + ', ' + KEY[k].name,
  { bars: 8, notes: notes([...phrase(PH_A, 0, KEY[k].t + oct, o), ...phrase(PH_B, 16, KEY[k].t + oct, o)]) }));
// the last bar of phrase B before a climb: up the V chord, then its seventh and raised seventh (D, D#) on the way to the new key
const melodyLift = (k, n, o) => made('melLift' + k, () => pat('melLift' + k, T.flute, 'Climb to ' + KEY[n].name, { bars: 1,
  notes: notes([[74, 0, 0.45, 100], [76, 0.5, 0.45, 100], [80, 1, 0.45, 102], [83, 1.5, 0.45, 104], [74 + o, 2, 0.96, 108], [75 + o, 3, 0.96, 114]].map(([p, ...x]) => [p + KEY[k].t, ...x])) }));
// the break: phrase A augmented (every note twice as long) over the harmony at half speed
const slow = (track, k, oct, vel) => made('slow' + track.name, () => pat('slow' + track.name, track, 'Phrase A, twice as slow', { bars: 8, notes: notes(phrase(PH_A, 0, KEY[k].t + oct, { aug: 2, vel })) }));

// strings: the pad, the pad at half speed, the climb (a run up the new key's scale), and the high line of the last eight bars
const strings = (k) => made('str' + k, () => pat('str' + k, T.strings, 'Pad, ' + KEY[k].name, { bars: 4, notes: notes(STR.flatMap((c, b) => chordAt(tr(c, KEY[k].t), b * BAR, 4, 84)), { straight: true }) }));
const stringsSlow = (k) => made('strSlow' + k, () => pat('strSlow' + k, T.strings, 'Pad (2 bars each), ' + KEY[k].name, { bars: 8, notes: notes(STR.flatMap((c, b) => chordAt(tr(c, KEY[k].t), b * 8, 8, 80)), { straight: true }) }));
const RUN = [62, 64, 65, 67, 69, 71, 72, 74];
const stringsLift = (k, n) => made('strLift' + k, () => pat('strLift' + k, T.strings, 'Climb to ' + KEY[n].name, { bars: 1, notes: notes([
  ...chordAt(tr([68, 71, 74], KEY[k].t), 0, 2, 86), ...chordAt(tr([56, 59, 63], KEY[k].t), 2, 2, 80), // an octave down, out of the way of the run
  ...RUN.map((p, i) => [p + KEY[k].t + 4, 2 + i * 0.25, 0.25, 74 + i * 6]), // always a major third above the old key: the stairs only go up
], { straight: true }) }));
const stringsHigh = () => made('strHigh', () => pat('strHigh', T.strings, 'High line', { bars: 4, notes: notes([
  [88, 0, 4, 88], [86, 4, 2, 84], [84, 6, 2, 84], [84, 8, 3, 86], [83, 11, 0.5, 80], [81, 11.5, 0.5, 80], [80, 12, 2, 86],
  ...[76, 78, 80, 81, 83, 84, 86, 87].map((p, i) => [p, 14 + i * 0.25, 0.25, 72 + i * 5]),
], { straight: true }) }));

// brass: pushes with the piano, and two answers in the gaps of the melody
const stab = (c, at, len, v) => c.map((p) => [p, at, len, v]);
const brass = (k) => made('brass' + k, () => {
  const B = BRS.map((c) => tr(c, KEY[k].t));
  return pat('brass' + k, T.brass, 'Stabs, ' + KEY[k].name, { bars: 4, notes: notes([
    ...stab(B[1], 3.5, 0.4, 104), ...stab(B[1], 5.5, 0.2, 92), ...stab(B[2], 7.5, 0.4, 104),
    ...stab(B[3], 11.5, 0.4, 106), ...stab(B[3], 13.5, 0.2, 92), ...stab(B[0], 15.5, 0.5, 112),
  ]) });
});

/* ---------- drums ---------- */
const VEL = { '.': 0, g: 40, o: 62, x: 100, X: 124 };
const row = (bars, s) => (Array.isArray(s) ? s : Array.from({ length: bars * 16 }, (_, i) => VEL[s[i % s.length]] || 0));
const D = (key, track, name, bars, rows, rolls) => pat(key, track, name, {
  bars, steps: Object.fromEntries(Object.entries(rows).map(([k, s]) => [k, row(bars, s)])),
  ...(rolls ? { rolls: Object.fromEntries(Object.entries(rolls).map(([k, s]) => [k, Array.from({ length: bars * 16 }, (_, i) => +(s[i % s.length]) || 0)])) } : {}),
});
const FOUR = 'X...X...X...X...';
const HATS = 'xo.oxo.oxo.oxo.o';
D('introKick', T.drums, 'Kick', 1, { kick: FOUR, rim: '..........g.....' });
D('introHats', T.drums, 'Kick + hats', 1, { kick: FOUR, chat: 'x.o.x.o.x.o.x.o.', rim: '.......g..g.....' });
D('introFill', T.drums, 'Intro fill', 1, { kick: FOUR, chat: 'x.o.x.o.x.......', snare: '..........o.x.xX', ohat: '..x...x.........' }, { snare: '0000000000000020' });
D('house', T.drums, 'House', 2, {
  kick: FOUR, clap: '....X.......X...', chat: HATS, ohat: '..x...x...x...x.', rim: '.......o..o.....' + '..o....o.....o..',
});
D('houseCrash', T.drums, 'House + crash', 2, {
  kick: FOUR, clap: '....X.......X...', chat: HATS, ohat: '..x...x...x...x.', rim: '.......o..o.....' + '..o....o.....o..', crash: 'x...............' + '................',
});
D('fill', T.drums, 'Climb fill', 1, {
  kick: FOUR, clap: '....X...........', chat: 'xo.oxo.o........', ohat: '..x...x.........', tom: '........x..x..x.', snare: '.........o.ox.xX',
}, { snare: '0000000000000022' });
// the build: the snare doubles its speed every two bars and grows all the way; the last eighth is left empty
const ramp = (bars, every, from, to) => Array.from({ length: bars * 16 }, (_, i) => {
  const e = every[i >> 4];
  return i % e === (e === 8 ? 4 : 0) && i < bars * 16 - 2 ? Math.round(from + ((to - from) * (i >> 4)) / (bars - 1)) : 0;
});
D('build', T.drums, 'Build', 8, {
  kick: FOUR.repeat(7) + 'X...X...X...X...', snare: ramp(8, [8, 8, 4, 4, 2, 2, 1, 1], 48, 127),
  clap: ('................').repeat(4) + ('....x.......x...').repeat(3) + '....x.......x...', chat: ('................').repeat(2) + ('x.o.x.o.x.o.x.o.').repeat(5) + 'x.o.x.o.x.o.x...',
}, { snare: ('0000000000000000').repeat(7) + '0000000022223300' });
D('outro', T.drums, 'Outro beat', 1, { kick: FOUR, chat: 'x.o.x.o.x.o.x.o.', rim: '.......o..o.....' });
D('outroEnd', T.drums, 'Outro (last bar)', 1, { kick: 'X...X...X.......', chat: 'x.o.x.o.x.o.....', rim: '.......o..o.....' });
D('clave', T.perc, 'Clave', 1, { rim: 'x..x..x...x.x...' });
D('congas', T.perc, 'Clave + congas', 2, { rim: 'x..x..x...x.x...', tom: '..........o..x..' + '......o...o..x.x', chat: '.o.o.o.o.o.o.o.o' });

/* ---------- arrangement (bars) ---------- */
const clips = [];
const clip = (p, bar, bars, off) => clips.push({ trackId: p.trackId, patternId: p.id, start: bar * BAR, len: bars * BAR, ...(off ? { off: off * BAR } : {}) });
// a climb: the last bar of a section, on the way from key k to key n
const climb = (bar, k, n, o) => {
  clip(epLift(k, n), bar, 1); clip(bassLift(k, n), bar, 1); clip(stringsLift(k, n), bar, 1);
  clip(melodyLift(k, n, o), bar, 1); clip(P.fill, bar, 1);
};

// intro 1-8 (A minor): the piano behind a closed filter, the marimba's threes, then the kick
clip(firstChord(), 0, 1); clip(ep('A'), 0, 23);
clip(marimba('A'), 0, 16);
clip(P.introKick, 4, 2); clip(P.introHats, 6, 1); clip(P.introFill, 7, 1);

// first flight 9-24 (A minor): the groove, brass pushes; the melody from 17
clip(P.houseCrash, 8, 2); clip(P.house, 10, 6); clip(P.houseCrash, 16, 2); clip(P.house, 18, 5);
clip(bass('A'), 8, 15);
clip(brass('A'), 8, 15);
clip(melody(T.flute, 'A', 0, 'Melody'), 16, 7);
clip(strings('A'), 16, 7);
climb(23, 'A', 'Cs', 12);

// second flight 25-40 (C# minor): the round begins, the bell four bars behind the flute
clip(P.houseCrash, 24, 2); clip(P.house, 26, 6); clip(P.houseCrash, 32, 2); clip(P.house, 34, 5);
clip(P.clave, 24, 8); clip(P.congas, 32, 8);
clip(ep('Cs'), 24, 15); clip(bass('Cs'), 24, 15); clip(strings('Cs'), 24, 15);
clip(melody(T.flute, 'Cs', 0, 'Melody'), 24, 15);
clip(melody(T.bell, 'Cs', 0, 'Melody (round)', { vel: 90 }), 28, 12);
clip(marimba('Cs'), 32, 7);
clip(brass('Cs'), 32, 7);
climb(39, 'Cs', 'F', 0);

// landing 41-48 (F minor): no drums, the harmony at half speed, phrase A twice as slow on the bell
clip(keysBreak('F'), 40, 15); clip(stringsSlow('F'), 40, 15); clip(subBreak(), 40, 15); // from 49 on the kick pumps it
clip(slow(T.bell, 'F', 12, 92), 40, 16);
clip(P.clave, 44, 4);

// third flight 49-56 (F minor): the build; the flute joins the slow phrase an octave under the bell, the bass comes back for the walk up
clip(P.build, 48, 8);
clip(slow(T.flute, 'F', 0, 100), 48, 7);
clip(P.congas, 52, 4);
climb(55, 'F', 'A', 12);
clips.pop(); // the build has its own fill

// home 57-72 (A minor again): everything; the round in three voices, the strings' high line
clip(P.houseCrash, 56, 2); clip(P.house, 58, 6); clip(P.houseCrash, 64, 2); clip(P.house, 66, 6);
clip(P.congas, 56, 16);
clip(ep('A'), 56, 24); clip(bass('A'), 56, 20); clip(strings('A'), 56, 20); clip(brass('A'), 56, 16);
clip(melody(T.flute, 'A', 0, 'Melody'), 56, 16);
clip(melody(T.lead, 'A', -12, 'Melody (round)', { vel: 108, slides: true }), 60, 12);
clip(stringsHigh(), 64, 8);
clip(marimba('A'), 64, 16);

// the first step again 73-80: the filter closes; the last push is the first chord of the song
clip(P.outro, 72, 3); clip(P.outroEnd, 75, 1);
clip(P.clave, 72, 6);
clip(melody(T.flute, 'A', 0, 'Melody'), 72, 2);

/* ---------- automation (song beats), markers ---------- */
const B = (bar) => bar * BAR;
T.ep.auto = { filter: [{ b: 0, v: 0.2 }, { b: B(7.5), v: 0.5 }, { b: B(72), v: 0.5 }, { b: B(79.5), v: 0.21 }] };       // opens in the intro, closes again at the end
const sweep = (bar) => [{ b: B(bar), v: 0.5 }, { b: B(bar + 1) - 0.1, v: 0.7 }, { b: B(bar + 1), v: 0.5 }];             // a climb thins the drums out, the new key lands in full
T.drums.auto = { filter: [{ b: B(4), v: 0.2 }, { b: B(7.5), v: 0.5 }, ...sweep(23), ...sweep(39), { b: B(48), v: 0.22 }, { b: B(54), v: 0.5 }, ...sweep(55), { b: B(72), v: 0.5 }, { b: B(76), v: 0.3 }] };
T.bass.auto = { filter: [{ b: B(72), v: 0.5 }, { b: B(76), v: 0.3 }] };
T.marimba.auto = { volume: [{ b: 0, v: 0.2 }, { b: B(8), v: 0.6 }, { b: B(72), v: 0.6 }, { b: B(80), v: 0.22 }] };
T.strings.auto = { volume: [{ b: B(16), v: 0.26 }, { b: B(23), v: 0.46 }, { b: B(40), v: 0.3 }, { b: B(48), v: 0.4 }, { b: B(56) - 0.1, v: 0.56 }, { b: B(56), v: 0.46 }, { b: B(72), v: 0.46 }, { b: B(76), v: 0.2 }] };
T.sub.auto = { volume: [{ b: 0, v: 0.56 }, { b: B(40), v: 0.56 }, { b: B(48), v: 0.38 }, { b: B(55), v: 0.66 }] };
T.keys.auto = { volume: [{ b: 0, v: 0.5 }, { b: B(40), v: 0.5 }, { b: B(48), v: 0.4 }, { b: B(55), v: 0.6 }] };                                    // the build grows

const project = {
  version: 2, name: 'Penrose Stairs', bpm: BPM, root: 9, scale: 'minor', snap: 16, loop: true, click: false, mode: 'song',
  capture: { detail: 0.5, fixTuning: true, playBeat: false, mode: 'melody' },
  master: 0.85, loud: 0.2, region: null, tempo: [], tempoOpen: false,
  markers: [
    { beat: 0, name: 'Ground floor (A minor)' }, { beat: B(8), name: 'First flight' }, { beat: B(24), name: 'Up a third (C# minor)' },
    { beat: B(40), name: 'Landing (F minor)' }, { beat: B(48), name: 'Third flight' }, { beat: B(56), name: 'Home? (A minor)' },
    { beat: B(72), name: 'Ground floor again' },
  ],
  tracks: [T.drums, T.perc, T.bass, T.sub, T.ep, T.keys, T.marimba, T.flute, T.bell, T.lead, T.strings, T.brass],
  patterns: Object.values(P),
  clips,
  sel: { trackId: T.flute.id, patternId: P['mel' + T.flute.name + 'A0'].id },
  nextId: id,
};

const out = path.join(__dirname, '..', 'examples', 'penrose-stairs.browserdj.json');
fs.writeFileSync(out, JSON.stringify(project, null, 1));
const end = clips.reduce((a, c) => Math.max(a, c.start + c.len), 0);
console.log('wrote', path.relative(process.cwd(), out), '-', clips.length, 'clips,', Object.keys(P).length, 'patterns,', end / BAR, 'bars,', Math.round((end * 60) / BPM), 's');
