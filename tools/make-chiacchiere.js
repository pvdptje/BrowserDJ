/* Writes examples/chiacchiere.browserdj.json: "Chiacchiere" (Italian for chatter).
   Italo dance at 160 BPM in E minor. A deep, funky bass that hops octaves and slides between the kicks, the Voice
   instrument chattering in short syllables (soft notes say "lo", hard ones "la"), off-beat organ stabs and a simple lead tune in the drops.
   The second break is the bass on its own with claps.
   Shows off: slides, the Voice instrument, pump, a sub layer, EQ and automation.
   Run: node tools/make-chiacchiere.js && node tools/pack-examples.js */
'use strict';
const fs = require('fs');
const path = require('path');

const BAR = 4, ROOT = 4, SCALE = 'minor'; // E minor
let id = 1;
const nid = () => id++;
// [pitch, start, len, vel, slide]
const notes = (list, vel = 100) => list.map(([pitch, start, len, v, slide]) => ({ id: nid(), start, len, pitch, vel: v || vel, ...(slide ? { slide: true } : {}) }));
const steps = (bars, s) => Array.from({ length: bars * 16 }, (_, i) => ({ '.': 0, g: 40, o: 62, x: 100, X: 124 }[s[i % s.length]] || 0));

/* ---------- tracks ---------- */
const kit = (over) => ['kick', 'hkick', 'snare', 'clap', 'chat', 'ohat', 'tom', 'rim', 'crash'].map((k) => ({ id: k, vol: 0.8, mute: false, solo: false, ...(over[k] || {}) }));
const LFO_OFF = { target: 'off', rate: '1/8', depth: 0.6 };
const synth = (name, color, instrument, o) => ({ id: nid(), type: 'synth', name, color, instrument, volume: 0.6, pan: 0, drive: 0, filter: 0.5, reverb: 0, pump: 0, echoSend: 0,
  shape: { attack: 0, release: 0, tone: 0.5, glide: 0.3 }, lfo: LFO_OFF, ...o });
const T = {
  drums: { id: nid(), type: 'drums', name: 'Drums', color: '#58d6c5', kitStyle: 'classic', volume: 0.8, pan: 0, drive: 0.1, filter: 0.5, reverb: 0.04, pump: 0, echoSend: 0,
    eq: { low: 2, high: 1.5 }, kit: kit({ kick: { vol: 1 }, snare: { vol: 0.6 }, clap: { vol: 0.7 }, chat: { vol: 0.45 }, ohat: { vol: 0.5 }, rim: { vol: 0.4 }, crash: { vol: 0.45 } }) },
  bass: synth('Funky bass', '#a58bff', 'bass', { volume: 0.58, pump: 0.3, drive: 0.22, eq: { low: 2, mid: 3 }, shape: { attack: 0, release: 0.06, tone: 0.55, glide: 0.35 } }),
  sub: synth('Sub', '#7a6cff', 'sub', { volume: 0.5, pump: 0.6, shape: { attack: 0, release: 0.1, tone: 0.4, glide: 0.3 } }),
  talk: synth('Chatter', '#ffe066', 'voice', { volume: 0.54, pan: 0.05, drive: 0.1, reverb: 0.12, echoSend: 0.18, eq: { low: -4, mid: 2 },
    shape: { attack: 0, release: 0.05, tone: 0.5, glide: 0.4 } }),
  organ: synth('Organ', '#ff7a59', 'organ', { volume: 0.46, pan: -0.15, reverb: 0.2, pump: 0.3, eq: { low: -8, high: -1 }, shape: { attack: 0, release: 0.08, tone: 0.5, glide: 0.3 } }),
  lead: synth('Lead', '#ffb04f', 'pluck', { volume: 0.62, pan: 0.12, reverb: 0.3, echoSend: 0.32, eq: { low: -5, high: 1.5 } }),
  pad: synth('Strings', '#5fb4ff', 'strings', { volume: 0.46, reverb: 0.5, pump: 0.4, eq: { low: -8 }, shape: { attack: 0.3, release: 0.5, tone: 0.45, glide: 0.3 } }),
};

/* ---------- patterns ---------- */
const P = {};
const pat = (key, track, name, body) => { P[key] = { id: nid(), trackId: track.id, name, ...body }; return P[key]; };

// the bass never lands on the kick: it answers on the off-beat 16ths, pops up an octave and slides back.
// Two bars on E, one on C, one on D that walks back up to E.
const riff = (r, at) => [
  [r, at + 0.5, 0.25, 118], [r, at + 0.75, 0.25, 96], [r + 12, at + 1.5, 0.2, 108], [r, at + 1.75, 0.25, 100, true],
  [r + 3, at + 2.5, 0.25, 104], [r + 5, at + 2.75, 0.25, 98], [r + 7, at + 3.25, 0.25, 104], [r, at + 3.5, 0.45, 112, true],
];
const E2 = 40;
pat('bass', T.bass, 'Bassline', {
  bars: 4,
  notes: notes([
    ...riff(E2, 0),
    [E2, 4.5, 0.25, 118], [E2 + 12, 4.75, 0.2, 104], [E2, 5.5, 0.45, 110, true], [E2 - 2, 6.5, 0.25, 100], [E2, 6.75, 0.25, 104, true],
    [E2 + 3, 7.25, 0.25, 100], [E2 + 5, 7.5, 0.25, 104, true], [E2 + 7, 7.75, 0.25, 108],
    [36, 8.5, 0.25, 118], [36, 8.75, 0.25, 96], [48, 9.5, 0.2, 108], [36, 9.75, 0.25, 100, true],
    [40, 10.5, 0.25, 104], [43, 10.75, 0.25, 98], [45, 11.25, 0.25, 104], [36, 11.5, 0.45, 112, true],
    [38, 12.5, 0.25, 118], [50, 12.75, 0.2, 104], [38, 13.5, 0.45, 110, true], [42, 14.5, 0.25, 102], [45, 14.75, 0.25, 104],
    [47, 15.25, 0.25, 104], [50, 15.5, 0.25, 108, true], [51, 15.75, 0.25, 112, true],
  ]),
});
// the intro and the outro stay on E
pat('bassE', T.bass, 'Bassline (on E)', { bars: 2, notes: notes([...riff(E2, 0),
  [E2, 4.5, 0.25, 118], [E2 + 12, 4.75, 0.2, 104], [E2, 5.5, 0.45, 110, true], [E2 - 2, 6.5, 0.25, 100], [E2, 6.75, 0.25, 104, true],
  [E2 + 3, 7.25, 0.25, 100], [E2 + 5, 7.5, 0.25, 104, true], [E2 + 7, 7.75, 0.25, 108]]) });
// sub: the root, an octave under, in the gap after each kick
pat('sub', T.sub, 'Sub', { bars: 4, notes: notes([28, 28, 24, 26].flatMap((r, b) => [0.5, 1.5, 2.5, 3.5].map((s) => [r, b * BAR + s, 0.4, 104]))) });

// the chatter: short syllables on two or three pitches, like someone talking over the beat; velocity opens and
// closes its mouth. Four bars: a phrase, its answer, the phrase again, and a longer reply.
const B3 = 59, D4 = 62, E4 = 64, G4 = 67, A4 = 69;
const TALK = [
  [E4, 0, 0.3, 112], [E4, 0.5, 0.3, 100], [G4, 1, 0.45, 110], [E4, 2, 0.2, 104], [E4, 2.25, 0.2, 74], [D4, 2.75, 0.3, 100], [E4, 3.5, 0.4, 108, true],
  [B3, 4, 0.3, 108], [B3, 4.5, 0.3, 74], [D4, 5, 0.45, 106], [E4, 5.75, 0.2, 100], [G4, 6.5, 0.3, 110], [E4, 7, 0.2, 100], [D4, 7.25, 0.5, 104, true],
  [E4, 8, 0.3, 112], [E4, 8.5, 0.3, 100], [G4, 9, 0.45, 110], [E4, 10, 0.2, 104], [E4, 10.25, 0.2, 74], [G4, 10.75, 0.3, 104], [A4, 11.5, 0.4, 110, true],
  [G4, 12, 0.2, 108], [G4, 12.25, 0.2, 74], [A4, 12.75, 0.3, 106], [G4, 13.5, 0.3, 104], [E4, 14, 0.2, 104], [D4, 14.25, 0.2, 74], [E4, 14.75, 0.2, 100], [D4, 15.25, 0.2, 74], [B3, 15.5, 0.45, 108, true],
];
pat('talk', T.talk, 'Chatter', { bars: 4, notes: notes(TALK) });
// just the first three syllables of every other bar, for the intro and the breaks
pat('talkSparse', T.talk, 'Chatter (a word)', { bars: 4, notes: notes(TALK.filter(([, s]) => s % 8 < 1.5)) });

// organ: the chord on every off-beat (Em, Em, C, D)
const CH = [[71, 76, 79], [71, 76, 79], [72, 76, 79], [69, 74, 78]];
pat('organ', T.organ, 'Off-beat stabs', { bars: 4, notes: notes(CH.flatMap((c, b) => [0.5, 1.5, 2.5, 3.5].flatMap((s, k) => c.map((p) => [p, b * BAR + s, 0.25, k === 3 ? 104 : 92])))) });

// lead: a tune that mostly steps, with the same skip in bars 1 and 3
pat('lead', T.lead, 'Tune', { bars: 8, notes: notes([
  [71, 0, 0.5, 108], [71, 0.75, 0.25, 92], [74, 1, 0.5, 104], [71, 1.5, 0.5, 98], [69, 2.5, 0.5, 96], [67, 3, 0.5, 98], [69, 3.5, 0.5, 100],
  [71, 4, 1, 108], [67, 5.5, 0.5, 96], [64, 6, 1.5, 102],
  [72, 8, 0.5, 108], [72, 8.75, 0.25, 92], [76, 9, 0.5, 106], [72, 9.5, 0.5, 98], [71, 10.5, 0.5, 96], [69, 11, 0.5, 98], [71, 11.5, 0.5, 100],
  [74, 12, 1, 108], [78, 13.5, 0.5, 104], [74, 14, 1, 100], [71, 15, 0.5, 96], [69, 15.5, 0.5, 96],
  [71, 16, 0.5, 108], [71, 16.75, 0.25, 92], [74, 17, 0.5, 104], [76, 17.5, 0.5, 104], [79, 18.5, 0.5, 108], [76, 19, 0.5, 100], [74, 19.5, 0.5, 100],
  [76, 20, 1, 110], [74, 21.5, 0.5, 98], [71, 22, 1.5, 102],
  [72, 24, 0.5, 108], [72, 24.75, 0.25, 92], [76, 25, 0.5, 106], [79, 25.5, 0.5, 106], [76, 26.5, 0.5, 100], [74, 27, 0.5, 98], [72, 27.5, 0.5, 98],
  [74, 28, 1, 108], [78, 29.5, 0.5, 106], [76, 30, 0.75, 104], [74, 30.75, 0.25, 96], [76, 31, 1, 108],
]) });

// strings: whole bars, for the breaks and under the drops
const PADCH = [[52, 59, 64, 67], [52, 59, 64, 67], [48, 55, 64, 67], [50, 57, 62, 66]];
pat('pad', T.pad, 'Strings', { bars: 4, notes: notes(PADCH.flatMap((c, b) => c.map((p) => [p, b * BAR, BAR, 84]))) });

// drums
const D = (key, name, bars, rows) => pat(key, T.drums, name, { bars, steps: Object.fromEntries(Object.entries(rows).map(([k, s]) => [k, steps(bars, s)])) });
const HAT = 'o.gxo.gxo.gxo.gx', OH = '..x...x...x...x.';
D('kick', 'Kick', 1, { kick: 'X...X...X...X...' });
D('kickHat', 'Kick and hats', 1, { kick: 'X...X...X...X...', ohat: OH, chat: 'o...o...o...o...' });
D('groove', 'Groove', 2, {
  kick: 'X...X...X...X...', clap: '....x.......x...', chat: HAT, ohat: OH,
  rim: '.......g..g.....' + '...g......g..g..',
});
D('grooveCrash', 'Groove + crash', 2, {
  kick: 'X...X...X...X...', clap: '....x.......x...', chat: HAT, ohat: OH,
  rim: '.......g..g.....' + '...g......g..g..', crash: 'x...............' + '................',
});
D('fill', 'Fill', 1, { kick: 'X...X...X.......', clap: '....x.......x...', snare: '........o.o.xxxx', chat: HAT.slice(0, 8), tom: '..........x..x..' });
D('build', 'Roll', 2, { snare: 'g...g...g...g...' + 'o.o.o.o.xxxxXXXX', clap: '................' + '............x.x.' });
D('claps', 'Claps and hats', 2, { clap: '....x.......x...', chat: HAT, rim: '.......g..g.....' + '...g......g..g..' });

/* ---------- arrangement (in bars, from 0) ---------- */
const clips = [];
const clip = (p, bar, bars, off) => clips.push({ id: nid(), trackId: p.trackId, patternId: p.id, start: bar * BAR, len: bars * BAR, ...(off ? { off: off * BAR } : {}) });
// intro 1-8: kick and a muffled bass that opens up; hats and a word of chatter from 5
clip(P.kick, 0, 4); clip(P.kickHat, 4, 3); clip(P.fill, 7, 1);
clip(P.bassE, 0, 8);
clip(P.talkSparse, 4, 4);
// groove 9-24: the beat, the bass and the chatter; the organ joins halfway
clip(P.grooveCrash, 8, 2); clip(P.groove, 10, 13); clip(P.fill, 23, 1);
clip(P.bass, 8, 16); clip(P.sub, 8, 16);
clip(P.talk, 8, 16);
clip(P.organ, 16, 8);
// break 25-32: strings and a word of chatter in the echo; the bass and a roll bring it back
clip(P.pad, 24, 8);
clip(P.talkSparse, 24, 8);
clip(P.organ, 28, 4);
clip(P.bassE, 28, 4);
clip(P.build, 30, 2);
// drop 33-48: everything, with the tune
clip(P.grooveCrash, 32, 2); clip(P.groove, 34, 13); clip(P.fill, 47, 1);
clip(P.bass, 32, 16); clip(P.sub, 32, 16);
clip(P.talk, 32, 16);
clip(P.organ, 32, 16);
clip(P.lead, 32, 16);
clip(P.pad, 32, 16);
// bass break 49-56: the bass on its own with claps, the chatter comes back to answer it
clip(P.claps, 48, 6); clip(P.build, 54, 2);
clip(P.bass, 48, 8);
clip(P.talk, 52, 4);
// drop 57-72
clip(P.grooveCrash, 56, 2); clip(P.groove, 58, 13); clip(P.fill, 71, 1);
clip(P.bass, 56, 16); clip(P.sub, 56, 16);
clip(P.talk, 56, 16);
clip(P.organ, 56, 16);
clip(P.lead, 56, 16);
clip(P.pad, 56, 16);
// outro 73-80: the beat, the bass on E and the last words
clip(P.grooveCrash, 72, 2); clip(P.groove, 74, 2); clip(P.kickHat, 76, 4);
clip(P.bassE, 72, 8); clip(P.sub, 72, 4);
clip(P.talk, 72, 4); clip(P.talkSparse, 76, 4);

/* ---------- automation (song beats), markers ---------- */
const b = (bar) => bar * BAR;
T.bass.auto = {
  // muffled in the intro, opening into the groove; closes and opens again through the bass break
  filter: [{ b: 0, v: 0.2 }, { b: b(7), v: 0.42 }, { b: b(8), v: 0.5 }, { b: b(28), v: 0.26 }, { b: b(32), v: 0.5 },
    { b: b(48), v: 0.5 }, { b: b(50), v: 0.3 }, { b: b(55.5), v: 0.5 }, { b: b(76), v: 0.5 }, { b: b(80), v: 0.22 }],
  volume: [{ b: 0, v: 0.46 }, { b: b(7.9), v: 0.5 }, { b: b(8), v: 0.58 }, { b: b(47.9), v: 0.58 }, { b: b(48), v: 0.7 }, { b: b(55.9), v: 0.7 }, { b: b(56), v: 0.58 }, { b: b(76), v: 0.58 }, { b: b(80), v: 0.25 }],
};
T.talk.auto = {
  echo: [{ b: b(24), v: 0.18 }, { b: b(25), v: 0.5 }, { b: b(31), v: 0.5 }, { b: b(32), v: 0.18 }, { b: b(76), v: 0.18 }, { b: b(77), v: 0.5 }],
  volume: [{ b: b(76), v: 0.54 }, { b: b(80), v: 0.2 }],
};
T.pad.auto = { filter: [{ b: b(24), v: 0.3 }, { b: b(31.5), v: 0.6 }, { b: b(32), v: 0.5 }], volume: [{ b: b(24), v: 0.75 }, { b: b(31.9), v: 0.75 }, { b: b(32), v: 0.42 }] };
T.organ.auto = { filter: [{ b: b(28), v: 0.3 }, { b: b(32), v: 0.5 }] };
T.drums.auto = { filter: [{ b: b(76), v: 0.5 }, { b: b(80), v: 0.3 }] };

const project = {
  version: 2, name: 'Chiacchiere', bpm: 160, root: ROOT, scale: SCALE, snap: 16, loop: true, click: false, mode: 'song',
  capture: { detail: 0.5, fixTuning: true, playBeat: false, mode: 'melody' },
  master: 0.85, loud: 0.15, region: null, tempo: [], tempoOpen: false,
  markers: [
    { id: nid(), beat: 0, name: 'Intro' }, { id: nid(), beat: b(8), name: 'Groove' }, { id: nid(), beat: b(24), name: 'Break' },
    { id: nid(), beat: b(32), name: 'Drop' }, { id: nid(), beat: b(48), name: 'Bass break' }, { id: nid(), beat: b(56), name: 'Drop 2' },
    { id: nid(), beat: b(72), name: 'Outro' },
  ],
  tracks: [T.drums, T.bass, T.sub, T.talk, T.organ, T.lead, T.pad],
  patterns: Object.values(P),
  clips,
  sel: { trackId: T.bass.id, patternId: P.bass.id },
  nextId: id,
};

const out = path.join(__dirname, '..', 'examples', 'chiacchiere.browserdj.json');
fs.writeFileSync(out, JSON.stringify(project, null, 1));
console.log('wrote', path.relative(process.cwd(), out), '-', clips.length, 'clips,', Object.keys(P).length, 'patterns');
