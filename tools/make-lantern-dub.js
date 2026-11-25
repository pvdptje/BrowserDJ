/* Writes examples/lantern-dub.browserdj.json: "Lantern Dub".
   Dub reggae at 74 BPM in G minor. A one-drop beat, a round bass that leaves room, a strummed nylon guitar on the
   off-beats with the organ bubbling around it, and a two-part horn line. Half-way the mixing desk takes over:
   the band drops to drums and bass, and guitar chords, horn phrases, a voice and single snare hits are thrown
   into the echo (a dotted eighth, the dub delay) and left to trail off. It comes back as a four-on-the-floor steppers.
   Shows off: echo sends and their automation, a second drum track just for echo throws, the DJ filter, swing on
   a synth track, drum rolls, the Voice and the nylon guitar.
   Run: node tools/make-lantern-dub.js && node tools/pack-examples.js */
'use strict';
const fs = require('fs');
const path = require('path');

const BAR = 4, ROOT = 7, SCALE = 'minor', SWING = 0.3; // G minor
const KEY = [7, 9, 10, 0, 2, 3, 5]; // G A Bb C D Eb F
let id = 1;
const nid = () => id++;
// [pitch, start, len, vel]
const notes = (list, vel = 100) => list.map(([pitch, start, len, v]) => ({ id: nid(), start: Math.round(start * 1000) / 1000, len, pitch, vel: v || vel }));
const steps = (bars, s) => Array.from({ length: bars * 16 }, (_, i) => ({ '.': 0, g: 38, o: 64, x: 100, X: 122 }[s[i % s.length]] || 0));
const rolls = (bars, s) => Array.from({ length: bars * 16 }, (_, i) => +s[i % s.length] || 0);
// the note a third below, staying in the key (for the second horn)
const thirdBelow = (p) => { let q = p, n = 0; while (n < 2) { q--; if (KEY.includes(q % 12)) n++; } return q; };

/* ---------- harmony ---------- */
// the riddim: Gm | Gm | Cm | Dm; the horn section: Eb | Dm | Cm | Dm
const CHORDS = {
  Gm: { gtr: [58, 62, 67], org: [55, 58, 62] },
  Cm: { gtr: [60, 63, 67], org: [55, 60, 63] },
  Dm: { gtr: [57, 62, 65], org: [53, 57, 62] },
  Eb: { gtr: [58, 63, 67], org: [55, 58, 63] },
};
const A = ['Gm', 'Gm', 'Cm', 'Dm'], B = ['Eb', 'Dm', 'Cm', 'Dm'];

/* ---------- tracks ---------- */
const kit = (over) => ['kick', 'hkick', 'snare', 'clap', 'chat', 'ohat', 'tom', 'rim', 'crash'].map((k) => ({ id: k, vol: 0.8, mute: false, solo: false, ...(over[k] || {}) }));
const LFO_OFF = { target: 'off', rate: '1/8', depth: 0.6 };
const synth = (name, color, instrument, o) => ({ id: nid(), type: 'synth', name, color, instrument, volume: 0.6, pan: 0, drive: 0, filter: 0.5, reverb: 0, pump: 0, echoSend: 0,
  shape: { attack: 0, release: 0, tone: 0.5, glide: 0.3 }, lfo: LFO_OFF, ...o });
const T = {
  drums: { id: nid(), type: 'drums', name: 'One drop', color: '#ffb04f', kitStyle: 'acoustic', volume: 0.92, pan: 0, drive: 0.05, filter: 0.5, reverb: 0.1, pump: 0, echoSend: 0, swing: SWING,
    eq: { low: 2 }, kit: kit({ kick: { vol: 0.95 }, snare: { vol: 0.7 }, rim: { vol: 0.75 }, chat: { vol: 0.5 }, ohat: { vol: 0.4 }, tom: { vol: 0.7 }, crash: { vol: 0.45 } }) },
  // a second kit that only plays the hits that get thrown into the echo
  throws: { id: nid(), type: 'drums', name: 'Echo throws', color: '#ff7a59', kitStyle: 'acoustic', volume: 0.5, pan: 0.15, drive: 0, filter: 0.6, reverb: 0.35, pump: 0, echoSend: 0.85, swing: 0,
    eq: { low: -6 }, kit: kit({ snare: { vol: 0.8 }, rim: { vol: 0.8 }, tom: { vol: 0.7 } }) },
  bass: synth('Bass', '#a58bff', 'bass', { volume: 0.52, drive: 0.06, eq: { low: 1.5, high: -6 }, shape: { attack: 0, release: 0.1, tone: 0.3, glide: 0.3 } }),
  guitar: synth('Skank guitar', '#58d6c5', 'guitar', { volume: 0.5, pan: -0.2, reverb: 0.18, echoSend: 0.08, eq: { low: -6, high: 1.5 } }),
  organ: synth('Organ bubble', '#5fb4ff', 'organ', { volume: 0.42, pan: 0.2, reverb: 0.15, swing: SWING, eq: { low: -4, high: -2 }, shape: { attack: 0, release: 0.05, tone: 0.42, glide: 0.3 } }),
  horns: synth('Horns', '#ffe066', 'brass', { volume: 0.62, pan: 0.05, reverb: 0.3, echoSend: 0.2, eq: { low: -3 }, shape: { attack: 0.12, release: 0.2, tone: 0.5, glide: 0.3 } }),
  voice: synth('Voice', '#ff8fd0', 'voice', { volume: 0.56, pan: -0.1, reverb: 0.35, echoSend: 0.55, eq: { low: -3 } }),
};

/* ---------- patterns ---------- */
const P = {};
const pat = (key, track, name, body) => { P[key] = { id: nid(), trackId: track.id, name, ...body }; return P[key]; };

// guitar: a short downstroke on every off-beat, the strings a few milliseconds apart; the last one of each bar a touch softer
const skank = (prog) => notes(prog.flatMap((c, b) => [0.5, 1.5, 2.5, 3.5].flatMap((s, i) => CHORDS[c].gtr.map((p, k) => [p, b * BAR + s + k * 0.02, 0.22, (i === 3 ? 88 : 100) + k * 4]))));
pat('gtrA', T.guitar, 'Skank', { bars: 4, notes: skank(A) });
pat('gtrB', T.guitar, 'Skank (horn section)', { bars: 4, notes: skank(B) });

// organ: the bubble. Two soft low notes on the 16ths either side of the skank, and the chord with it
const bubble = (prog) => notes(prog.flatMap((c, b) => [0, 1, 2, 3].flatMap((beat) => {
  const o = CHORDS[c].org, at = b * BAR + beat;
  return [[o[0], at + 0.25, 0.2, 62], [o[1], at + 0.25, 0.2, 58], ...o.map((p) => [p, at + 0.5, 0.2, 92]), [o[0], at + 0.75, 0.2, 66], [o[1], at + 0.75, 0.2, 60]];
})));
pat('orgA', T.organ, 'Bubble', { bars: 4, notes: bubble(A) });
pat('orgB', T.organ, 'Bubble (horn section)', { bars: 4, notes: bubble(B) });

// bass: lands on the one, answers after the drop, and leaves the rest of the bar alone
pat('bassA', T.bass, 'Riddim', { bars: 4, notes: notes([
  [43, 0, 0.75, 118], [43, 1, 0.25, 96], [46, 1.5, 0.5, 104], [43, 2.5, 0.5, 108], [41, 3.25, 0.25, 92], [43, 3.5, 0.5, 100],
  [43, 4, 0.75, 118], [50, 5.5, 0.5, 104], [48, 6, 0.5, 100], [46, 6.5, 0.5, 100], [43, 7, 0.5, 106],
  [48, 8, 0.75, 118], [48, 9, 0.25, 96], [51, 9.5, 0.5, 104], [48, 10.5, 0.5, 108], [46, 11.25, 0.25, 92], [48, 11.5, 0.5, 100],
  [50, 12, 0.75, 118], [50, 13.5, 0.5, 104], [48, 14, 0.5, 100], [45, 14.5, 0.5, 100], [38, 15, 0.75, 110],
]) });
pat('bassB', T.bass, 'Horn section', { bars: 4, notes: notes([
  [39, 0, 1, 118], [46, 1.5, 0.5, 100], [43, 2, 0.5, 100], [39, 2.5, 0.75, 108], [39, 3.5, 0.5, 98],
  [38, 4, 1, 118], [45, 5.5, 0.5, 100], [41, 6, 0.5, 100], [38, 6.5, 0.75, 108], [38, 7.5, 0.5, 98],
  [36, 8, 1, 118], [43, 9.5, 0.5, 100], [39, 10, 0.5, 100], [36, 10.5, 0.75, 108], [36, 11.5, 0.5, 98],
  [38, 12, 0.75, 118], [45, 13.5, 0.5, 100], [48, 14, 0.5, 100], [50, 14.5, 0.5, 104], [38, 15.25, 0.25, 92], [41, 15.5, 0.5, 100],
]) });

// horns: the tune, with a second horn a third below
const twoHorns = (list) => notes(list.flatMap(([p, s, l, v = 104]) => [[p, s, l, v], [thirdBelow(p), s, l, v - 18]]));
pat('hornsA', T.horns, 'Tune', { bars: 4, notes: twoHorns([
  [74, 0, 1.5], [72, 1.5, 0.5], [70, 2, 1], [67, 3, 1],
  [70, 4, 0.5], [72, 4.5, 0.5], [70, 5, 2],
  [75, 8, 1.5], [74, 9.5, 0.5], [72, 10, 1], [67, 11, 1],
  [69, 12, 0.5], [72, 12.5, 0.5], [74, 13, 2.5],
]) });
pat('hornsB', T.horns, 'Long notes', { bars: 4, notes: twoHorns([
  [79, 0, 3, 100], [77, 3, 1, 96],
  [77, 4, 3, 100], [74, 7, 1, 96],
  [75, 8, 2, 100], [74, 10, 1, 96], [72, 11, 1, 96],
  [74, 12, 1.5, 104], [72, 13.5, 0.5, 96], [69, 14, 2, 100],
]) });

// voice: soft notes say "lo", hard ones "la"
pat('voiceDub', T.voice, 'Call', { bars: 2, notes: notes([[67, 0.5, 0.5, 78], [70, 1, 0.5, 96], [72, 1.5, 1.5, 116], [70, 4.5, 0.5, 80], [67, 5, 0.5, 96], [62, 5.5, 2, 112]]) });
pat('voiceA', T.voice, 'Under the horns', { bars: 4, notes: notes([
  [62, 6.5, 0.5, 80], [65, 7, 0.5, 96], [67, 7.5, 0.5, 104], [67, 8, 2, 116],
  [65, 14, 0.5, 84], [67, 14.5, 0.5, 100], [62, 15, 1, 112],
]) });

// drums
const D = (key, track, name, bars, rows, ro) => pat(key, track, name, {
  bars, steps: Object.fromEntries(Object.entries(rows).map(([k, s]) => [k, steps(bars, s)])),
  ...(ro ? { rolls: Object.fromEntries(Object.entries(ro).map(([k, s]) => [k, rolls(bars, s)])) } : {}),
});
const HATS = 'x.xgx.xgx.xgx.xg' + 'x.xgx.xgx.xgo.xg';
// one drop: nothing on the one, kick and cross-stick together on three
D('onedrop', T.drums, 'One drop', 2, { kick: '........X.......', rim: '........x.......' + '........x.....g.', chat: HATS, ohat: '................' + '..............o.' });
// rockers: the kick on one as well
D('rockers', T.drums, 'Rockers', 2, { kick: 'X.......X.......', rim: '........x.......' + '........x.....g.', chat: HATS, ohat: '................' + '..............o.' });
// steppers: a kick on every beat
D('steppers', T.drums, 'Steppers', 2, { kick: 'X...x...X...x...', snare: '........x.......', rim: '........x.......' + '........x..g..g.', chat: HATS, ohat: '..o...........o.' });
D('fill', T.drums, 'Fill', 1, { kick: '........X.......', snare: '..........x.x.xx', tom: '........x..x.x..', chat: 'x.xgx.xg........', crash: '................' },
  { snare: '..............2.', tom: '...........2....' });
D('intro', T.drums, 'Pick-up', 1, { snare: '........x.xx.x.x', tom: '............x.x.', kick: '..............x.' }, { snare: '........2.......' });
D('hats', T.drums, 'Hats', 2, { chat: HATS, rim: '................' + '........g.......' });
// the throws: one hit at the end of a phrase, left to echo away
D('throw', T.throws, 'Throw (every 4 bars)', 4, { snare: '.'.repeat(56) + 'x.......' });
D('throwDub', T.throws, 'Throws (dub)', 2, { snare: '........x.......' + '................', rim: '................' + '..........x..x..', tom: '................' + '..............o.' });

/* ---------- arrangement (in bars, from 0) ---------- */
const clips = [];
const clip = (p, bar, bars, off) => clips.push({ id: nid(), trackId: p.trackId, patternId: p.id, start: bar * BAR, len: bars * BAR, ...(off ? { off: off * BAR } : {}) });
// intro 1-4: guitar and organ through a closed filter, a drum pick-up
clip(P.gtrA, 0, 4); clip(P.orgA, 0, 4); clip(P.intro, 3, 1);
// riddim 5-20: the band; rockers and the horn tune from 13
clip(P.onedrop, 4, 8); clip(P.rockers, 12, 7); clip(P.fill, 19, 1);
clip(P.bassA, 4, 16); clip(P.gtrA, 4, 16); clip(P.orgA, 4, 16);
clip(P.hornsA, 12, 8);
clip(P.throw, 4, 16);
// horn section 21-28
clip(P.rockers, 20, 7); clip(P.fill, 27, 1);
clip(P.bassB, 20, 8); clip(P.gtrB, 20, 8); clip(P.orgB, 20, 8); clip(P.hornsB, 20, 8);
clip(P.throw, 20, 8);
// dub 29-44: drums and bass; everything else is a bar here and there, thrown into the echo
clip(P.onedrop, 28, 8); clip(P.hats, 36, 2); clip(P.onedrop, 38, 5); clip(P.fill, 43, 1);
clip(P.bassA, 28, 8); clip(P.bassA, 38, 6, 2);
clip(P.throwDub, 28, 16);
clip(P.gtrA, 28, 1); clip(P.gtrA, 31, 1, 3); clip(P.gtrA, 33, 1, 1); clip(P.gtrA, 36, 2); clip(P.gtrA, 40, 1); clip(P.gtrA, 43, 1, 3);
clip(P.orgA, 32, 4); clip(P.orgA, 40, 4);
clip(P.hornsA, 30, 1); clip(P.hornsA, 34, 1, 2); clip(P.hornsA, 38, 2);
clip(P.voiceDub, 36, 2); clip(P.voiceDub, 42, 2);
// steppers 45-56: everybody back, a kick on every beat
clip(P.steppers, 44, 11); clip(P.fill, 55, 1);
clip(P.bassA, 44, 12); clip(P.gtrA, 44, 12); clip(P.orgA, 44, 12);
clip(P.hornsA, 44, 12); clip(P.voiceA, 48, 8);
clip(P.throw, 44, 12);
// outro 57-60: guitar, organ and hats, fading into the echo
clip(P.gtrA, 56, 4); clip(P.orgA, 56, 4); clip(P.hats, 56, 2); clip(P.throwDub, 56, 4);
clip(P.bassA, 56, 1);

/* ---------- automation (song beats), markers ---------- */
const b = (bar) => bar * BAR;
T.guitar.auto = {
  filter: [{ b: 0, v: 0.38 }, { b: b(4), v: 0.5 }],
  // in the dub every chord goes into the echo
  echo: [{ b: b(28) - 0.1, v: 0.08 }, { b: b(28), v: 0.8 }, { b: b(44) - 0.1, v: 0.8 }, { b: b(44), v: 0.08 }, { b: b(56), v: 0.08 }, { b: b(58), v: 0.7 }],
  volume: [{ b: 0, v: 0.7 }, { b: b(4) - 0.1, v: 0.7 }, { b: b(4), v: 0.5 }, { b: b(56), v: 0.5 }, { b: b(60), v: 0.12 }],
};
T.organ.auto = {
  filter: [{ b: 0, v: 0.36 }, { b: b(4), v: 0.5 }, { b: b(32) - 0.1, v: 0.5 }, { b: b(32), v: 0.24 }, { b: b(36), v: 0.5 }, { b: b(40) - 0.1, v: 0.5 }, { b: b(40), v: 0.76 }, { b: b(44), v: 0.5 }],
  echo: [{ b: b(28), v: 0 }, { b: b(32), v: 0.45 }, { b: b(44) - 0.1, v: 0.45 }, { b: b(44), v: 0 }, { b: b(56), v: 0 }, { b: b(58), v: 0.5 }],
  volume: [{ b: 0, v: 0.6 }, { b: b(4) - 0.1, v: 0.6 }, { b: b(4), v: 0.42 }, { b: b(56), v: 0.42 }, { b: b(60), v: 0.1 }],
};
T.horns.auto = { echo: [{ b: b(28) - 0.1, v: 0.2 }, { b: b(28), v: 0.75 }, { b: b(44) - 0.1, v: 0.75 }, { b: b(44), v: 0.2 }] };
// the drums duck under the desk's filter while the bass is out, and open up again into the steppers
T.drums.auto = { filter: [{ b: b(36) - 0.1, v: 0.5 }, { b: b(36), v: 0.7 }, { b: b(38) - 0.1, v: 0.6 }, { b: b(38), v: 0.5 }] };
T.bass.auto = { filter: [{ b: b(38), v: 0.3 }, { b: b(40), v: 0.5 }] };

const project = {
  version: 2, name: 'Lantern Dub', bpm: 74, root: ROOT, scale: SCALE, snap: 16, loop: true, click: false, mode: 'song',
  capture: { detail: 0.5, fixTuning: true, playBeat: false, mode: 'melody' },
  master: 0.85, loud: 0.35, region: null, tempo: [], tempoOpen: false,
  markers: [
    { id: nid(), beat: 0, name: 'Intro' }, { id: nid(), beat: b(4), name: 'Riddim' }, { id: nid(), beat: b(20), name: 'Horns' },
    { id: nid(), beat: b(28), name: 'Dub' }, { id: nid(), beat: b(44), name: 'Steppers' }, { id: nid(), beat: b(56), name: 'Outro' },
  ],
  tracks: [T.drums, T.throws, T.bass, T.guitar, T.organ, T.horns, T.voice],
  patterns: Object.values(P),
  clips,
  sel: { trackId: T.bass.id, patternId: P.bassA.id },
  nextId: id,
};

const out = path.join(__dirname, '..', 'examples', 'lantern-dub.browserdj.json');
fs.writeFileSync(out, JSON.stringify(project, null, 1));
console.log('wrote', path.relative(process.cwd(), out), '-', clips.length, 'clips,', Object.keys(P).length, 'patterns');
