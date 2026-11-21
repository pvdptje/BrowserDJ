/* Writes examples/first-light.browserdj.json: "First Light", the intro demo.
   Melodic house, 122 BPM, F major over the loop Dm7 - Bbmaj7 - F - C, 64 bars (about 2:06).
   Intro: filtered pad opening up, an arpeggio fades in. Groove: drums and a pumping bass.
   Theme: a lead melody, a bell answers it. Breakdown: the melody on soft keys, drenched in reverb.
   Build: snare roll and a high-pass sweep on the drums. Drop: everything. Outro: the pad fades out.
   Run: node tools/make-first-light.js */
'use strict';
const fs = require('fs');
const path = require('path');

const BAR = 4;
let id = 1;
const nid = () => id++;
const notes = (list, vel = 100) => list.map(([pitch, start, len, v]) => ({ id: nid(), start, len, pitch, vel: v || vel }));
const steps = (bars, s) => Array.from({ length: bars * 16 }, (_, i) => ({ '.': 0, o: 55, x: 100, X: 124 }[s[i % s.length]] || 0));

/* ---------- harmony: one bar each ---------- */
const CHORDS = [
  [50, 53, 57, 60], // Dm7     D F A C
  [46, 50, 53, 57], // Bbmaj7  Bb D F A
  [48, 53, 57, 60], // F       C F A C
  [48, 52, 55, 60], // C       C E G C
];
const ROOTS = [38, 34, 41, 36]; // D2 Bb1 F2 C2

/* ---------- tracks ---------- */
const kit = (over) => ['kick', 'hkick', 'snare', 'clap', 'chat', 'ohat', 'tom', 'rim', 'crash'].map((k) => ({ id: k, vol: 0.8, mute: false, solo: false, ...(over[k] || {}) }));
const T = {
  drums: { id: nid(), type: 'drums', name: 'Drums', color: '#58d6c5', volume: 0.82, pan: 0, drive: 0, filter: 0.5, reverb: 0.06, pump: 0, echoSend: 0, swing: 0.12,
    kit: kit({ kick: { vol: 1 }, clap: { vol: 0.75 }, chat: { vol: 0.45 }, ohat: { vol: 0.5 }, crash: { vol: 0.55 }, snare: { vol: 0.65 } }) },
  bass: { id: nid(), type: 'synth', name: 'Bass', color: '#a58bff', instrument: 'bass', volume: 0.66, pan: 0, drive: 0.08, filter: 0.5, reverb: 0, pump: 0.5, echoSend: 0, shape: { attack: 0, release: 0, tone: 0.45 } },
  pad: { id: nid(), type: 'synth', name: 'Pad', color: '#5fb4ff', instrument: 'pad', volume: 0.5, pan: 0, drive: 0, filter: 0.5, reverb: 0.55, pump: 0.55, echoSend: 0, shape: { attack: 0.3, release: 0.45, tone: 0.48 } },
  arp: { id: nid(), type: 'synth', name: 'Arp', color: '#b5e36b', instrument: 'pluck', volume: 0.44, pan: 0.22, drive: 0, filter: 0.5, reverb: 0.25, pump: 0.3, echoSend: 0.45, shape: { attack: 0, release: 0.15, tone: 0.5 } },
  lead: { id: nid(), type: 'synth', name: 'Lead', color: '#ffb04f', instrument: 'supersaw', volume: 0.46, pan: 0, drive: 0, filter: 0.5, reverb: 0.35, pump: 0.2, echoSend: 0.22, shape: { attack: 0.12, release: 0.3, tone: 0.42 } },
  keys: { id: nid(), type: 'synth', name: 'Keys', color: '#ff7a59', instrument: 'soft', volume: 0.58, pan: -0.1, drive: 0, filter: 0.5, reverb: 0.62, pump: 0, echoSend: 0.3, shape: { attack: 0, release: 0.5, tone: 0.5 } },
  bell: { id: nid(), type: 'synth', name: 'Bells', color: '#ffe066', instrument: 'bell', volume: 0.34, pan: -0.3, drive: 0, filter: 0.5, reverb: 0.5, pump: 0.15, echoSend: 0.45, shape: { attack: 0, release: 0, tone: 0.5 } },
};

/* ---------- patterns ---------- */
const P = {};
const pat = (key, track, name, body) => { P[key] = { id: nid(), trackId: track.id, name, ...body }; return P[key]; };

// pad: one chord per bar, held
pat('chords', T.pad, 'Chords', { bars: 4, notes: notes(CHORDS.flatMap((c, b) => c.map((p) => [p, b * BAR, BAR])), 88) });

// bass: root on the one, offbeat eighths, an octave jump to finish each bar
pat('bass', T.bass, 'Bassline', {
  bars: 4,
  notes: notes(ROOTS.flatMap((r, b) => [
    [r, b * BAR, 0.5, 110], [r, b * BAR + 1.5, 0.4], [r, b * BAR + 2.5, 0.4], [r + 12, b * BAR + 3.5, 0.4, 92],
  ]), 100),
});

// arp: 16ths through each chord in a higher voicing, accents on the beat
const ARPV = [[62, 65, 69, 72], [58, 62, 65, 69], [60, 65, 69, 72], [60, 64, 67, 72]];
const ARP_ORDER = [0, 1, 2, 3, 2, 1, 2, 3, 0, 1, 2, 3, 2, 3, 1, 2];
pat('arp', T.arp, 'Arp', {
  bars: 4,
  notes: notes(ARPV.flatMap((v, b) => ARP_ORDER.map((k, s) => [v[k], b * BAR + s * 0.25, 0.25, s % 4 === 0 ? 104 : s % 2 === 0 ? 86 : 72]))),
});

// the theme: a question (bars 1-4) and its answer (bars 5-8), all in F major
const A4 = 69, C5 = 72, D5 = 74, Bb4 = 70, F4 = 65, F5 = 77, E5 = 76, G4 = 67, E4 = 64;
const THEME = [
  [A4, 0, 1], [C5, 1, 0.5], [D5, 1.5, 1.5], [C5, 3, 0.5], [A4, 3.5, 0.5],
  [D5, 4, 1], [C5, 5, 0.5], [Bb4, 5.5, 0.5], [A4, 6, 1.5], [F4, 7.5, 0.5],
  [A4, 8, 0.5], [C5, 8.5, 0.5], [F5, 9, 1.5], [E5, 10.5, 0.5], [C5, 11, 1],
  [D5, 12, 0.5], [C5, 12.5, 0.5], [G4, 13, 1], [E4, 14, 0.5], [G4, 14.5, 0.5], [C5, 15, 1],
  [F5, 16, 1], [E5, 17, 0.5], [D5, 17.5, 1], [C5, 18.5, 0.5], [D5, 19, 1],
  [Bb4, 20, 0.5], [C5, 20.5, 0.5], [D5, 21, 1.5], [F5, 22.5, 0.5], [D5, 23, 1],
  [C5, 24, 1], [A4, 25, 0.5], [C5, 25.5, 0.5], [F5, 26, 1], [E5, 27, 0.5], [C5, 27.5, 0.5],
  [E5, 28, 1.5], [D5, 29.5, 0.5], [C5, 30, 2],
];
pat('theme', T.lead, 'Theme', { bars: 8, notes: notes(THEME.map(([p, s, l], i) => [p, s, l, i % 5 === 0 ? 112 : 98])) });
// the same melody on keys, an octave down, for the breakdown
pat('keys', T.keys, 'Theme (keys)', { bars: 8, notes: notes(THEME.map(([p, s, l]) => [p - 12, s, l, 92])) });
// and doubled at the lead's height in the drop, a piano shimmer on top of the saws
pat('keysHigh', T.keys, 'Theme (keys, high)', { bars: 8, notes: notes(THEME.map(([p, s, l]) => [p, s, l, 84])) });

// bells: a little answer after each phrase
pat('bells', T.bell, 'Sparkle', {
  bars: 4,
  notes: notes([[81, 2.5, 0.5], [77, 3, 1], [77, 6.5, 0.5], [74, 7, 1], [84, 10.5, 0.5], [81, 11, 1], [79, 14.5, 0.5], [76, 15, 1]], 96),
});

// drums
const D = (key, name, bars, rows) => pat(key, T.drums, name, { bars, steps: Object.fromEntries(Object.entries(rows).map(([k, s]) => [k, steps(bars, s)])) });
D('groove', 'Groove', 1, { kick: 'X...x...x...x...', ohat: '..x...x...x...x.', chat: '.o.o.o.o.o.o.o.o' });
D('beat', 'Beat', 1, { kick: 'X...x...x...x...', clap: '....x.......x...', ohat: '..x...x...x...x.', chat: '.o.o.o.o.o.o.o.o' });
D('crash', 'Beat + crash', 1, { kick: 'X...x...x...x...', clap: '....x.......x...', ohat: '..x...x...x...x.', chat: '.o.o.o.o.o.o.o.o', crash: 'x...............' });
D('fill', 'Fill', 1, { kick: 'X...x...x.......', clap: '....x...........', snare: '..........xxxXXX', chat: '.o.o.o.o' + '........' });
D('build', 'Build', 4, {
  kick: 'X...x...x...x...' + 'X...x...x...x...' + 'X.x.x.x.x.x.x.x.' + 'XxxxXxxxXxxxXxxx',
  snare: 'x...x...x...x...' + 'x.x.x.x.x.x.x.x.' + 'xxxxxxxxxxxxxxxx' + 'xxxxxxxxXXXXXXXX',
});
D('outro', 'Outro hats', 1, { ohat: '..x...x...x...x.', chat: '.o.o.o.o.o.o.o.o' });

/* ---------- arrangement (in bars) ---------- */
const clips = [];
const clip = (p, bar, bars) => clips.push({ id: nid(), trackId: p.trackId, patternId: p.id, start: bar * BAR, len: bars * BAR });
// intro 1-8: pad alone, the arp fades in at bar 5
clip(P.chords, 0, 64);
clip(P.arp, 4, 28);
// groove 9-16
clip(P.groove, 8, 7); clip(P.fill, 15, 1);
clip(P.bass, 8, 24);
// theme 17-32 (bells join for the answer the second time round)
clip(P.crash, 16, 1); clip(P.beat, 17, 14); clip(P.fill, 31, 1);
clip(P.theme, 16, 16);
clip(P.bells, 24, 8);
// breakdown 33-40: keys alone over the pad
clip(P.keys, 32, 8);
// build 41-44
clip(P.build, 40, 4);
clip(P.arp, 40, 4);
// drop 45-60
clip(P.crash, 44, 1); clip(P.beat, 45, 14); clip(P.fill, 59, 1);
clip(P.bass, 44, 16);
clip(P.arp, 44, 16);
clip(P.theme, 44, 16);
clip(P.keysHigh, 44, 16);
clip(P.bells, 44, 16);
// outro 61-64
clip(P.crash, 60, 1); clip(P.outro, 61, 3);

/* ---------- automation (song beats) ---------- */
T.pad.auto = {
  filter: [{ b: 0, v: 0.16 }, { b: 32, v: 0.5 }],          // the intro opens up
  // without kicks the pad stops pumping, so it dips in the breakdown, swells back for the build, fades at the end
  volume: [{ b: 124, v: 0.5 }, { b: 128, v: 0.32 }, { b: 156, v: 0.32 }, { b: 172, v: 0.5 }, { b: 240, v: 0.5 }, { b: 256, v: 0 }],
};
T.keys.auto = { volume: [{ b: 128, v: 0.4 }, { b: 175.9, v: 0.4 }, { b: 176, v: 0.26 }] }; // soft in the breakdown, a light double in the drop
T.drums.auto = { filter: [{ b: 160, v: 0.5 }, { b: 175.75, v: 0.8 }, { b: 176, v: 0.5 }] }; // the build thins out, the drop lands full
T.arp.auto = { filter: [{ b: 16, v: 0.22 }, { b: 30, v: 0.5 }] };                         // the arp fades in through the filter
T.drums.autoOpen = false;

const project = {
  version: 2, name: 'First Light', bpm: 122, root: 5, scale: 'major', snap: 16, loop: true, click: false, mode: 'song',
  capture: { detail: 0.5, fixTuning: true, playBeat: false, mode: 'melody' },
  master: 0.85, loud: 0.3, region: null,
  markers: [
    { id: nid(), beat: 0, name: 'Intro' }, { id: nid(), beat: 32, name: 'Groove' }, { id: nid(), beat: 64, name: 'Theme' },
    { id: nid(), beat: 128, name: 'Breakdown' }, { id: nid(), beat: 160, name: 'Build' }, { id: nid(), beat: 176, name: 'Drop' }, { id: nid(), beat: 240, name: 'Outro' },
  ],
  tracks: [T.drums, T.bass, T.pad, T.arp, T.lead, T.keys, T.bell],
  patterns: Object.values(P),
  clips,
  sel: { trackId: T.lead.id, patternId: P.theme.id },
  nextId: id,
};

const out = path.join(__dirname, '..', 'examples', 'first-light.browserdj.json');
fs.writeFileSync(out, JSON.stringify(project, null, 1));
console.log('wrote', path.relative(process.cwd(), out), '-', clips.length, 'clips,', Object.keys(P).length, 'patterns');
