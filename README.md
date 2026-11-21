# BrowserDJ

A small music studio that runs in the browser: hum a melody, edit it in a piano roll, add a beat, and export MIDI or WAV. No build step and no server needed. Open `index.html`.

`hum-to-midi.html` is the original single-file Hum to MIDI tool this grew out of, kept as is.

## Layout

| File | What it does |
| --- | --- |
| `js/engine.js` | Pitch tracking (YIN), note segmentation, key/tempo guessing, MIDI writing. Also loads in Node. |
| `js/sound.js` | Melody voices, synthesized drum kit, mixer, WAV encoding. Works with live and offline audio contexts. |
| `js/project.js` | The project model (plain JSON, times in beats), drum presets, take → notes, undo history, MIDI track building. |
| `js/pianoroll.js` | Canvas piano roll editor. |
| `js/drums.js` | Step sequencer UI. |
| `js/app.js` | Transport (look-ahead scheduler), recording, export, controls. |

`window.BrowserDJ.project` is the live project, the natural hook for an AI helper later.

## Tests

```
node test/engine.test.js
```

## Microphone

Chrome and Edge allow the microphone on `file://`. If no permission prompt appears, serve the folder (`npx serve`) and open it through `http://localhost`.
