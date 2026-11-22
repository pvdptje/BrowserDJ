/* Writes examples/kitchen-window.browserdj.json: "Kitchen Window".
   Acoustic folk-pop at 98 BPM in G major. A fingerpicked nylon guitar (alternating bass, Travis style) carries the
   intro and verses; a second guitar strums the choruses (down, down-up, up-down-up), with brushes-and-shaker
   acoustic drums, a round bass, strings and a flute melody.
   Shows off: the Nylon guitar, Strum (the strummed chords are spread the way the Strum button spreads them),
   the Acoustic kit, Chance on the shaker 16ths, and automation.
   Run: node tools/make-kitchen-window.js && node tools/pack-examples.js */
'use strict';
const fs = require('fs');
const path = require('path');

const BAR = 4, ROOT = 7, SCALE = 'major'; // G major
let id = 1;
const nid = () => id++;
// [pitch, start, len, vel, chance]
// a string stops when it is plucked again: a note ends where the next one of the same pitch starts
const untangle = (list) => list.map((n) => { const nx = list.filter((m) => m[0] === n[0] && m[1] > n[1] + 1e-6).reduce((x, m) => Math.min(x, m[1]), Infinity); return [n[0], n[1], Math.min(n[2], nx - n[1]), ...n.slice(3)]; });
const notes = (list) => untangle(list).map(([pitch, start, len, vel, chance]) => ({ id: nid(), start, len, pitch, vel, ...(chance && chance < 100 ? { chance } : {}) }));
const steps = (bars, s) => Array.from({ length: bars * 16 }, (_, i) => ({ '.': 0, g: 40, o: 62, x: 100, X: 124 }[s[i % s.length]] || 0));
const chances = (bars, s) => Array.from({ length: bars * 16 }, (_, i) => ({ 7: 75, 5: 50, 2: 25, 1: 10 }[s[i % s.length]] || 0));

/* ---------- open-position chords, lowest string first ---------- */
const V = {
  G: [43, 47, 50, 55, 59, 67],
  Em: [40, 47, 52, 55, 59, 64],
  C: [48, 52, 55, 60, 64],
  D: [50, 57, 62, 66],
  Am: [45, 52, 57, 60, 64],
};
const ROOTS = { G: 43, Em: 40, C: 36, D: 38, Am: 45 };
const VERSE = ['G', 'Em', 'C', 'D'];
const CHORUS = ['C', 'G', 'D', 'Em', 'C', 'G', 'Am', 'D'];
const ENDING = ['G', 'Em', 'C', 'G'];

/* ---------- tracks ---------- */
const kit = (over) => ['kick', 'hkick', 'snare', 'clap', 'chat', 'ohat', 'tom', 'rim', 'crash'].map((k) => ({ id: k, vol: 0.8, mute: false, solo: false, ...(over[k] || {}) }));
const LFO_OFF = { target: 'off', rate: '1/8', depth: 0.6 };
const synth = (name, color, instrument, o) => ({ id: nid(), type: 'synth', name, color, instrument, volume: 0.6, pan: 0, drive: 0, filter: 0.5, reverb: 0, pump: 0, echoSend: 0,
  shape: { attack: 0, release: 0, tone: 0.5, glide: 0.3 }, lfo: LFO_OFF, ...o });
const T = {
  drums: { id: nid(), type: 'drums', name: 'Brushes', color: '#58d6c5', kitStyle: 'acoustic', volume: 0.62, pan: 0, drive: 0, filter: 0.5, reverb: 0.16, pump: 0, echoSend: 0, swing: 0,
    eq: { high: -1.5 }, kit: kit({ kick: { vol: 0.85 }, snare: { vol: 0.55 }, rim: { vol: 0.6 }, chat: { vol: 0.42 }, ohat: { vol: 0.35 }, tom: { vol: 0.6 }, crash: { vol: 0.4 } }) },
  pick: synth('Fingerpicked', '#ffb04f', 'guitar', { volume: 0.66, pan: -0.22, reverb: 0.22, eq: { low: -1.5, high: 1 } }),
  strum: synth('Strummed', '#ffe066', 'guitar', { volume: 0.5, pan: 0.24, reverb: 0.2, eq: { low: -4, mid: -1, high: 1.5 } }),
  bass: synth('Bass', '#a58bff', 'bass', { volume: 0.5, eq: { high: -6 }, shape: { attack: 0, release: 0.1, tone: 0.3, glide: 0.3 } }),
  strings: synth('Strings', '#5fb4ff', 'strings', { volume: 0.3, reverb: 0.4, pan: 0.05, eq: { low: -8 }, shape: { attack: 0.45, release: 0.45, tone: 0.42, glide: 0.3 } }),
  flute: synth('Flute', '#ff7a59', 'flute', { volume: 0.42, pan: 0.08, reverb: 0.34, echoSend: 0.12 }),
};

/* ---------- patterns ---------- */
const P = {};
const pat = (key, track, name, body) => {
  // notes stay inside their pattern (the MIDI file cuts a note off where its pattern ends)
  if (body.notes) for (const n of body.notes) n.len = Math.min(n.len, body.bars * BAR - n.start);
  P[key] = { id: nid(), trackId: track.id, name, ...body };
  return P[key];
};

// fingerpicking: the thumb alternates two bass strings on the beats, the fingers pick the top strings in between
function picking(chords, ringLast) {
  const out = [];
  chords.forEach((c, b) => {
    const v = V[c], at = b * BAR, [h0, h1, h2] = v.slice(-3), b1 = v[0], b2 = v[v.length > 4 ? 2 : 1];
    if (ringLast && b === chords.length - 1) { // the last chord: one slow roll that rings out
      v.forEach((p, k) => out.push([p, at + k * 0.125, BAR - k * 0.125, 88 - k * 3]));
      return;
    }
    const seq = [[b1, 0, 0.9, 96], [h2, 0.5, 1.5, 80], [b2, 1, 0.9, 84], [h1, 1.5, 1.5, 76], [b1, 2, 0.9, 90], [h2, 2.5, 1.5, 80], [b2, 3, 0.9, 84], [h0, 3.5, 0.5, 72]]; // the last one stops at the chord change
    if (b % 2 === 0) seq.push([h1, 0, 1.4, 84]); // a pinch: thumb and finger together at the start of a phrase
    out.push(...seq.map(([p, s, l, vel]) => [p, at + s, l, vel]));
  });
  return out;
}
// strumming, spread the way the Strum button does it: 1/32 beat per string, down = lowest first, up = highest first
function strum(chords, hits, lastRing) {
  const out = [], gap = 1 / 32;
  chords.forEach((c, b) => {
    const v = V[c], at = b * BAR;
    const list = lastRing && b === chords.length - 1 ? [[0, BAR, 100, 'D']] : hits;
    for (const [s, len, vel, dir] of list) {
      const strings = dir === 'U' ? v.slice(-4).reverse() : v; // an upstroke catches the top strings
      strings.forEach((p, k) => out.push([p, at + s + k * gap, len - k * gap, vel - (dir === 'U' ? k * 2 : 0)]));
    }
  });
  return out;
}
const FOLK = [[0, 1, 102, 'D'], [1, 0.5, 86, 'D'], [1.5, 1, 64, 'U'], [2.5, 0.5, 68, 'U'], [3, 0.5, 88, 'D'], [3.5, 0.5, 62, 'U']];
const LIGHT = [[0, 2, 80, 'D'], [2, 1.5, 76, 'D'], [3.5, 0.5, 56, 'U']];

pat('pickVerse', T.pick, 'Picking (verse)', { bars: 4, notes: notes(picking(VERSE)) });
pat('pickChorus', T.pick, 'Picking (chorus)', { bars: 8, notes: notes(picking(CHORUS)) });
pat('pickEnd', T.pick, 'Picking (ending)', { bars: 4, notes: notes(picking(ENDING, true)) });
pat('strumChorus', T.strum, 'Strum (chorus)', { bars: 8, notes: notes(strum(CHORUS, FOLK, true)) });
pat('strumLight', T.strum, 'Strum (light)', { bars: 4, notes: notes(strum(VERSE, LIGHT)) });

// bass: root, fifth, octave, fifth; the last bar of the chorus walks back home to G
const bassLine = (chords) => notes(chords.flatMap((c, b) => {
  const r = ROOTS[c], at = b * BAR;
  return [[r, at, 1.4, 104], [r + 7, at + 1.5, 0.5, 80], [r + 12, at + 2, 0.9, 90], [r + 7, at + 3, 0.9, 84]];
}));
pat('bassVerse', T.bass, 'Bass (verse)', { bars: 4, notes: bassLine(VERSE) });
const bc = bassLine(CHORUS);
pat('bassChorus', T.bass, 'Bass (chorus)', { bars: 8, notes: bc.filter((n) => n.start < 28).concat(notes([[38, 28, 1, 100], [40, 29, 1, 88], [42, 30, 1, 92], [43, 31, 1, 96]])) });

// strings: the triad an octave up, a whole bar each, in the choruses
const triad = (c) => V[c].slice(-3);
pat('strings', T.strings, 'Strings', { bars: 8, notes: notes(CHORUS.flatMap((c, b) => triad(c).map((p) => [p + 12, b * BAR, BAR, 76]))) });

// the flute: the chorus tune (two four-bar phrases, the second reaching higher)
const TUNE = [
  [72, 0, 1], [76, 1, 1], [79, 2, 1.5], [76, 3.5, 0.5],
  [74, 4, 1.5], [71, 5.5, 0.5], [74, 6, 2],
  [74, 8, 1], [78, 9, 1], [81, 10, 1.5], [78, 11.5, 0.5],
  [79, 12, 1.5], [76, 13.5, 0.5], [71, 14, 2],
  [72, 16, 1], [76, 17, 1], [79, 18, 1], [81, 19, 1],
  [83, 20, 1.5], [81, 21.5, 0.5], [79, 22, 2],
  [76, 24, 1], [72, 25, 1], [76, 26, 1], [81, 27, 1],
  [78, 28, 1.5], [76, 29.5, 0.5], [74, 30, 2],
];
pat('flute', T.flute, 'Chorus tune', { bars: 8, notes: notes(TUNE.map(([p, s, l], i) => [p, s, l, s % 4 === 0 ? 100 : 88])) });
// verse two: the flute answers the guitar, a few notes per phrase
pat('fluteAnswer', T.flute, 'Answer', { bars: 4, notes: notes([[71, 2.5, 0.5, 80], [74, 3, 1, 86], [71, 6, 2, 80], [72, 10.5, 0.5, 80], [76, 11, 1, 86], [74, 14, 1, 84], [78, 15, 1, 80, 50]]) });

// drums: a soft kick, rim clicks and a shaker (closed hat) whose in-between 16ths are left to chance
const D = (key, name, bars, rows, ch) => pat(key, T.drums, name, {
  bars, steps: Object.fromEntries(Object.entries(rows).map(([k, s]) => [k, steps(bars, s)])),
  ...(ch ? { chance: Object.fromEntries(Object.entries(ch).map(([k, s]) => [k, chances(bars, s)])) } : {}),
});
D('verse', 'Rim and shaker', 1, { kick: 'x.........o.....', rim: '....o.......o...', chat: 'o.g.o.g.o.g.o.gg' }, { chat: '..5...5...5...52' });
D('chorus', 'Brushes', 1, { kick: 'x......o..x.....', snare: '....x.......x...', chat: 'o.gxo.gxo.gxo.gx', ohat: '..............g.' }, { chat: '..5...5...5...5.' });
D('chorusIn', 'Brushes + crash', 1, { kick: 'x......o..x.....', snare: '....x.......x...', chat: '..gxo.gxo.gxo.gx', crash: 'o...............' }, { chat: '..5...5...5...5.' });
D('fill', 'Fill', 1, { kick: 'x.........x.....', snare: '....x.....g.g.x.', tom: '........o.o.....', chat: 'o.g.o.g.' });

/* ---------- arrangement (in bars) ---------- */
const clips = [];
const clip = (p, bar, bars) => clips.push({ id: nid(), trackId: p.trackId, patternId: p.id, start: bar * BAR, len: bars * BAR });
// intro 1-4: the picking alone
clip(P.pickVerse, 0, 4);
// verse 5-20: picking; the bass and rim-and-shaker join at 9; the flute's answer from 13
clip(P.pickVerse, 4, 16);
clip(P.bassVerse, 8, 12);
clip(P.verse, 8, 11); clip(P.fill, 19, 1);
// chorus 21-28: the strum, brushes, bass, strings and the tune; the picking rests
clip(P.strumChorus, 20, 8);
clip(P.chorusIn, 20, 1); clip(P.chorus, 21, 7);
clip(P.bassChorus, 20, 8);
clip(P.strings, 20, 8);
clip(P.flute, 20, 8);
// verse 29-36: picking and a light strum, the flute answers
clip(P.pickVerse, 28, 8);
clip(P.strumLight, 28, 8);
clip(P.bassVerse, 28, 8);
clip(P.verse, 28, 7); clip(P.fill, 35, 1);
clip(P.fluteAnswer, 28, 8);
// chorus 37-44: both guitars now
clip(P.strumChorus, 36, 8);
clip(P.pickChorus, 36, 8);
clip(P.chorusIn, 36, 1); clip(P.chorus, 37, 7);
clip(P.bassChorus, 36, 8);
clip(P.strings, 36, 8);
clip(P.flute, 36, 8);
// outro 45-48: the picking alone, ending on a rolled G
clip(P.pickEnd, 44, 4);

/* ---------- automation (song beats), markers ---------- */
// the strings swell into each chorus; the picking steps back while the strum carries the last chorus
T.strings.auto = { volume: [{ b: 80, v: 0.2 }, { b: 88, v: 0.3 }, { b: 144, v: 0.22 }, { b: 152, v: 0.32 }] };
T.pick.auto = { volume: [{ b: 140, v: 0.66 }, { b: 144, v: 0.46 }, { b: 175.9, v: 0.46 }, { b: 176, v: 0.66 }] };
T.strum.auto = { volume: [{ b: 0, v: 0.58 }, { b: 111.9, v: 0.58 }, { b: 112, v: 0.28 }, { b: 143.9, v: 0.28 }, { b: 144, v: 0.58 }] }; // the light strum stays under the picking in verse two
T.flute.auto = { volume: [{ b: 0, v: 0.42 }, { b: 111.9, v: 0.42 }, { b: 112, v: 0.28 }, { b: 143.9, v: 0.28 }, { b: 144, v: 0.42 }] };

const project = {
  version: 2, name: 'Kitchen Window', bpm: 98, root: ROOT, scale: SCALE, snap: 16, loop: true, click: false, mode: 'song',
  capture: { detail: 0.5, fixTuning: true, playBeat: false, mode: 'melody' },
  master: 0.85, loud: 0.15, region: null, tempo: [], tempoOpen: false,
  markers: [
    { id: nid(), beat: 0, name: 'Intro' }, { id: nid(), beat: 16, name: 'Verse' }, { id: nid(), beat: 80, name: 'Chorus' },
    { id: nid(), beat: 112, name: 'Verse 2' }, { id: nid(), beat: 144, name: 'Chorus' }, { id: nid(), beat: 176, name: 'Outro' },
  ],
  tracks: [T.drums, T.pick, T.strum, T.bass, T.strings, T.flute],
  patterns: Object.values(P),
  clips,
  sel: { trackId: T.strum.id, patternId: P.strumChorus.id },
  nextId: id,
};

const out = path.join(__dirname, '..', 'examples', 'kitchen-window.browserdj.json');
fs.writeFileSync(out, JSON.stringify(project, null, 1));
console.log('wrote', path.relative(process.cwd(), out), '-', clips.length, 'clips,', Object.keys(P).length, 'patterns, strummed notes', P.strumChorus.notes.length);
