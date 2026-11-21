# BrowserDJ

A small music studio that runs in the browser: hum a melody, edit it in a piano roll, build beats, arrange everything in a playlist, and export MIDI or WAV. No build step and no server needed. Open `index.html`.

`hum-to-midi.html` is the original single-file Hum to MIDI tool this grew out of, kept as is.

## Layout

| File | What it does |
| --- | --- |
| `js/engine.js` | Pitch tracking (YIN), note segmentation, key/tempo guessing, MIDI writing. Also loads in Node. |
| `js/sound.js` | Melody voices, synthesized drum kit, mixer, WAV encoding. Works with live and offline audio contexts. |
| `js/project.js` | The project model (plain JSON, times in beats): tracks, patterns and clips; what plays when; drum presets; take → notes; undo history; MIDI track building. Migrates version 1 projects. |
| `js/pianoroll.js` | Canvas piano roll editor. |
| `js/drums.js` | Step sequencer UI. |
| `js/playlist.js` | Song timeline: track headers, clips, loop region and markers. |
| `js/mixer.js` | Mixer strips: volume, DJ filter, pan, drive, echo send, mute/solo, level meters, master. |
| `js/beatbox.js` | Beatbox to drums: onsets, spectral centroid, grouping into kick / snare / hi-hat. Also loads in Node. |
| `js/share.js` | Share links: the song compressed into the link after `#s=`. Also loads in Node. |
| `js/library.js` | My songs: every song you work on, kept in IndexedDB. |
| `js/midiimport.js` | MIDI import: format 0/1 files into tracks, 4-bar patterns (shared when they repeat) and clips. Also loads in Node. |
| `js/live.js` | Playing live: computer keyboard (by key position) and Web MIDI input. |
| `js/samples.js` | Your own sounds: stored in IndexedDB by content hash; packed into saved project files as base64. |
| `js/app.js` | Transport (look-ahead scheduler), recording, export, controls. |

`window.BrowserDJ.project` is the live project, the natural hook for an AI helper later.

## Examples

The **Examples** button opens the songs in `examples/`. First-time visitors start in one of them, with a short welcome.

- A link like `?example=gabber` opens that song directly (ids are in `examples/catalog.json`; `starter` is the small built-in song).
- The page loads the songs from `examples/examples.js`, a bundle of the `.browserdj.json` files that also works when `index.html` is opened from disk. After adding or changing a song, list it in `examples/catalog.json` and run `node tools/pack-examples.js`; a unit test fails if the bundle is out of date.

## Model

- **Tracks** are instruments: a synth (piano roll) or a drum kit (step sequencer).
- **Patterns** belong to a track. Clips in the playlist are links to a pattern, so editing it changes every clip.
- **Pattern / Song** in the transport picks what Play (and export) plays. In Song mode with Loop on, a loop region (drag on the playlist ruler) limits the loop.
- **Automation** lanes (the A button on a track) draw volume, filter, pan, drive, echo and reverb over the song; they play in Song mode and export to MIDI as controllers 7, 74, 10, 94 and 91.
- **Export**: Download MIDI (one track per instrument, with markers and controllers), Export WAV (a limiter keeps it under full scale; the master Loud knob pushes into it), or Stems (one WAV per track, all the same length).
- **Markers** name song sections and are written into the MIDI file. Track volume and pan go in as controller 7 and 10.

## Tests

```
node test/engine.test.js
```

## Microphone

Chrome and Edge allow the microphone on `file://`. If no permission prompt appears, serve the folder (`npx serve`) and open it through `http://localhost`.
