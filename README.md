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
| `js/mixer.js` | Mixer strips: volume, DJ filter, 3-band EQ, pan, drive, echo send, mute/solo, level meters, master. |
| `js/beatbox.js` | Beatbox to drums: onsets, spectral centroid, grouping into kick / snare / hi-hat. Also loads in Node. |
| `js/share.js` | Share links: the song compressed into the link after `#s=`. Also loads in Node. |
| `js/library.js` | My songs: every song you work on, kept in IndexedDB. |
| `js/midiimport.js` | MIDI import: format 0/1 files into tracks, 4-bar patterns (shared when they repeat) and clips. Also loads in Node. |
| `js/live.js` | Playing live: computer keyboard (by key position) and Web MIDI input. |
| `js/samples.js` | Your own sounds: stored in IndexedDB by content hash; packed into saved project files as base64. |
| `js/agent.js` | `BrowserDJ.agent`: a stable interface for AI agents (or anyone at the console) to compose in the open page, with note/chord names, drum step strings, and `listen()`, which renders and measures the song. `llms.txt` points agents at it. |
| `js/tour.js` | The guided tour: a ring around one real control at a time and a bubble; a step moves on by itself when its `done()` turns true. The steps live in `app.js`. |
| `js/app.js` | Transport (look-ahead scheduler), recording, export, controls. |
| `sw.js`, `manifest.webmanifest`, `icons/` | Offline and install: served from a web address, the service worker keeps every file (network first, so updates land on the next visit). Its file list must match what `index.html` loads; the unit tests check that. |

`window.BrowserDJ.project` is the live project, the natural hook for an AI helper later.

## Examples

The **Examples** button opens the songs in `examples/`. First-time visitors start in one of them, with a short welcome.

- The Examples button opens a gallery of every example song: search, a style filter, sorting, and a small map of each arrangement. A link like `?example=gabber` opens that song directly (ids are in `examples/catalog.json`; `starter` is the small built-in song), and `?gallery` opens the gallery.
- The songs live in `examples/*.browserdj.json`. `node tools/pack-examples.js` turns them into `examples/index.js` (the gallery list, no notes, so it stays small as songs are added) and `examples/songs/<id>.js` (one per song, loaded only when it is opened). Scripts, unlike fetch, also work when `index.html` is opened from disk. After adding or changing a song, list it in `examples/catalog.json` with `id`, `file`, `title`, `style`, `blurb`, `added` (a date like `2026-11-26`) and `tags` (a few lowercase genre or mood words; reuse existing ones where they fit), then run the pack script; a unit test fails if the packed files are out of date.

## Model

- **Tracks** are instruments: a synth (piano roll) or a drum kit (step sequencer).
- **Patterns** belong to a track. Clips in the playlist are links to a pattern, so editing it changes every clip.
- **Chord progressions**: Chords… in the piano roll fills the pattern with a progression in the song's key (`HumEngine.progressionsFor` / `progressionChords`: triads voiced near middle C, each in the inversion closest to the one before). On a Bass or Acid track it writes the roots instead.
- **Ghost notes**: the piano roll faintly shows what the other synth tracks play at the same point in the song (the pass of the pattern under the playhead or song marker). The Ghosts button turns them off; the choice is kept in this browser.
- **Splitting**: a clip can start part-way into its pattern (`off`, in beats). Double-click a clip, or Split / K at the song marker, cuts it in two; dragging a clip's left edge trims its start while the music stays where it is. For an audio take the offset is how far into the recording the clip begins.
- **Inserting and deleting bars**: `insertTime(p, at, len)` / `deleteTime(p, at, len)` move everything after `at` (clips are cut at the edges, markers, tempo changes, automation points, the loop region). + Bars / − Bars use the loop region, or one bar at the song marker.
- **Pattern / Song** in the transport picks what Play (and export) plays. In Song mode with Loop on, a loop region (drag on the playlist ruler) limits the loop.
- **EQ**: every mixer strip has a low shelf (180 Hz), a broad mid bell (1.1 kHz) and a high shelf (3.5 kHz), each ±12 dB in half-dB steps, after the DJ filter. A track's `eq` is `{low, mid, high}` in dB and is only saved when not flat.
- **Automation** lanes (the A button on a track) draw volume, filter, pan, drive, echo and reverb over the song; they play in Song mode and export to MIDI as controllers 7, 74, 10, 94 and 91.
- **Tempo changes**: the Tempo lane at the top of the playlist changes the tempo from any bar on. Playback, loops, WAV export, the echo and LFOs all follow it; MIDI export writes the changes and MIDI import reads them. Audio takes keep their own speed (they are not stretched).
- **Export**: Download MIDI (one track per instrument, with markers and controllers), Export WAV (a limiter keeps it under full scale; the master Loud knob pushes into it), or Stems (one WAV per track, all the same length).
- **Expression**: a note with `slide: true` glides (detune ramp, Shape → Glide) from the note before it, wrapping at the pattern start; velocity sets level and brightness; Shift+drag in the velocity lane draws a line.
- **Drum kits and rolls**: a drum track's `kitStyle` (Classic, 808, Acoustic, Lo-fi) changes how the nine sounds are synthesized; a pattern's optional `rolls[drum][step]` (2, 3 or 4) splits a step into even, slightly softer hits.
- **Audio tracks**: record over the song (count-in, latency-compensated) or load an audio file. A take is a pattern with `audio: {hash, name, secs, start, end, gain}` pointing into the sample store; its clip plays it once (no time-stretch, so its length in beats follows the tempo). Trimming keeps the sound in place by moving its clips. Playback that starts or loops into the middle of a clip picks the recording up mid-way.
- **Movement**: every synth track has a tempo-locked LFO: Wobble (filter), Tremolo (volume) or Auto-pan, from 1/1 to 1/16 including triplets, with a depth control. It stays on the beat through tempo changes and in exports.
- **Sampler**: a synth track can play your own sound (a file, or recorded with the mic); its pitch is found with the hum tracker so it plays in tune across the keyboard.
- **Chance**: a note's `chance` (1–99, percent) or a drum pattern's `chance[drum][step]` (0 = always) makes it play only some of the time. The dice (`chanceRoll`) hash the track, the sound and the beat it lands on, so a song plays and exports the same way every time, while each pass of a loop rolls again.
- **Nylon guitar** is a physical model (Karplus-Strong): seeded noise round a one-period delay line, rendered once per pitch and touch (`Sound.ksString`). **Strum** in the piano roll spreads a chord 1/32 beat per note, upwards when the chord starts between beats.
- **Agents**: `BrowserDJ.agent.help()` in the page lists the calls. Edits go through the normal undo history (no normalize, so the ids it returns stay valid); `newSong` and `load` replace the song like opening a file. Errors throw before anything changes.
- **Swing**: a track's `swing` (0–0.6 of a 16th) delays the off-beat 16ths, on drum tracks (the step's position) and on synth tracks (notes that start exactly on the second or fourth 16th of a beat).
- **Markers** name song sections and are written into the MIDI file. Track volume and pan go in as controller 7 and 10.

## Tests

```
node test/engine.test.js
```

## Microphone

Chrome and Edge allow the microphone on `file://`. If no permission prompt appears, serve the folder (`npx serve`) and open it through `http://localhost`.
