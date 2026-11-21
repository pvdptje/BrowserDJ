/* BrowserDJ live input: play notes from the computer keyboard or a MIDI keyboard.
   Keys go by physical position (works on QWERTY, AZERTY and friends), like FL Studio:
   bottom row Z S X D C V G B H N J M , = one octave, top row Q 2 W 3 E R 5 T 6 Y 7 U I = the octave above. */
window.BDJ = window.BDJ || {};
BDJ.Live = (() => {
  'use strict';

  const LOWER = ['KeyZ', 'KeyS', 'KeyX', 'KeyD', 'KeyC', 'KeyV', 'KeyG', 'KeyB', 'KeyH', 'KeyN', 'KeyJ', 'KeyM', 'Comma', 'KeyL', 'Period', 'Semicolon', 'Slash'];
  const UPPER = ['KeyQ', 'Digit2', 'KeyW', 'Digit3', 'KeyE', 'KeyR', 'Digit5', 'KeyT', 'Digit6', 'KeyY', 'Digit7', 'KeyU', 'KeyI', 'Digit9', 'KeyO', 'Digit0', 'KeyP'];
  const KEYMAP = new Map();
  LOWER.forEach((code, i) => KEYMAP.set(code, i));
  UPPER.forEach((code, i) => KEYMAP.set(code, 12 + i));

  class Live {
    /* host: { noteOn(pitch, vel, source), noteOff(pitch, source), enabled(), status(text, kind) } */
    constructor(host) {
      this.host = host;
      this.octave = 3;          // bottom row starts at C3 (MIDI 48)
      this.keysDown = new Map(); // key code -> pitch
      this.midi = null;
      this.midiNotes = new Set();
      document.addEventListener('keydown', (e) => this.keydown(e), true);
      document.addEventListener('keyup', (e) => this.keyup(e), true);
      window.addEventListener('blur', () => this.releaseAll());
      document.addEventListener('visibilitychange', () => { if (document.hidden) this.releaseAll(); });
    }

    /* the key code -> MIDI pitch, or null */
    pitchFor(code) {
      const k = KEYMAP.get(code);
      return k == null ? null : (this.octave + 1) * 12 + k;
    }
    static typing(t) {
      const tag = (t && t.tagName || '').toLowerCase();
      return tag === 'textarea' || tag === 'select' || (tag === 'input' && !['checkbox', 'range', 'button', 'radio'].includes(t.type)) || (t && t.isContentEditable);
    }

    keydown(e) {
      if (!this.host.enabled() || e.ctrlKey || e.metaKey || e.altKey || Live.typing(e.target)) return;
      const p = this.pitchFor(e.code);
      if (p == null) return;
      // the key belongs to the keyboard now: stop shortcuts (like Q = quantize) and page scrolling
      e.preventDefault();
      e.stopPropagation();
      if (e.repeat || this.keysDown.has(e.code)) return;
      this.keysDown.set(e.code, p);
      this.host.noteOn(p, e.shiftKey ? 127 : 100, 'keys');
    }
    keyup(e) {
      const p = this.keysDown.get(e.code);
      if (p == null) return;
      this.keysDown.delete(e.code);
      e.preventDefault();
      this.host.noteOff(p, 'keys');
    }
    releaseAll() {
      for (const p of this.keysDown.values()) this.host.noteOff(p, 'keys');
      this.keysDown.clear();
      for (const p of this.midiNotes) this.host.noteOff(p, 'midi');
      this.midiNotes.clear();
    }
    shiftOctave(d) {
      this.releaseAll();
      this.octave = Math.max(0, Math.min(7, this.octave + d));
      return this.octave;
    }

    /* ---------- MIDI keyboards ---------- */
    async connectMidi() {
      if (!navigator.requestMIDIAccess) {
        this.host.status('This browser has no Web MIDI. Chrome and Edge do; Firefox needs a site permission add-on.', 'warn');
        return false;
      }
      try {
        this.midi = await navigator.requestMIDIAccess({ sysex: false });
      } catch (err) {
        this.host.status('MIDI access was blocked (' + (err && err.name || 'error') + '). Allow it in the address bar and try again.', 'warn');
        return false;
      }
      const attach = () => {
        const names = [];
        for (const input of this.midi.inputs.values()) {
          input.onmidimessage = (m) => this.onMidi(m.data);
          names.push(input.name || 'MIDI input');
        }
        this.inputs = names;
        this.host.status(names.length
          ? 'MIDI connected: ' + names.join(', ') + '. Play away.'
          : 'MIDI is on, but no keyboard is plugged in. Plug one in and it connects by itself.', names.length ? '' : 'warn');
      };
      this.midi.onstatechange = attach;
      attach();
      return true;
    }
    onMidi(d) {
      const type = d[0] & 0xf0;
      if (type === 0x90 && d[2] > 0) {
        this.midiNotes.add(d[1]);
        this.host.noteOn(d[1], d[2], 'midi');
      } else if (type === 0x80 || (type === 0x90 && d[2] === 0)) {
        this.midiNotes.delete(d[1]);
        this.host.noteOff(d[1], 'midi');
      }
    }
  }

  Live.KEYMAP = KEYMAP;
  return Live;
})();
