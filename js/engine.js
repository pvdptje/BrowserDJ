/* Hum to MIDI engine: pitch tracking, note segmentation, snapping, MIDI writing.
   Pure JS, no dependencies. Runs in the browser and in Node (for tests). */
const HumEngine = (() => {
  'use strict';

  const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  const SCALES = {
    chromatic: { name: 'Chromatic (no snapping)', steps: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11] },
    major: { name: 'Major', steps: [0, 2, 4, 5, 7, 9, 11] },
    minor: { name: 'Minor', steps: [0, 2, 3, 5, 7, 8, 10] },
    minorPent: { name: 'Minor pentatonic', steps: [0, 3, 5, 7, 10] },
    majorPent: { name: 'Major pentatonic', steps: [0, 2, 4, 7, 9] },
    dorian: { name: 'Dorian', steps: [0, 2, 3, 5, 7, 9, 10] },
    phrygian: { name: 'Phrygian', steps: [0, 1, 3, 5, 7, 8, 10] },
    harmonicMinor: { name: 'Harmonic minor', steps: [0, 2, 3, 5, 7, 8, 11] },
  };

  const noteName = (m) => NOTE_NAMES[((m % 12) + 12) % 12] + (Math.floor(m / 12) - 1);
  const hzToMidi = (hz) => 69 + 12 * Math.log2(hz / 440);
  const midiToHz = (m) => 440 * Math.pow(2, (m - 69) / 12);

  /* ---------- Streaming pitch analyzer (YIN) ---------- */
  class Analyzer {
    constructor(inputRate) {
      this.factor = Math.max(1, Math.round(inputRate / 22050));
      this.sr = inputRate / this.factor;
      this.hop = Math.round(this.sr * 0.01);
      this.dt = this.hop / this.sr;
      this.W = Math.round(this.sr * 0.03);
      this.tauMin = Math.max(2, Math.floor(this.sr / 2500));
      this.tauMax = Math.ceil(this.sr / 60);
      this.t0 = this.W / 2 / this.sr; // time of frame 0 (window centre)
      this.buf = new Float32Array(1 << 17);
      this.len = 0;
      this.accSum = 0;
      this.accCnt = 0;
      this.midi = [];
      this.conf = [];
      this.rms = [];
      this._d = new Float32Array(this.tauMax + 2);
    }

    /* Append mono input samples at the input rate. */
    push(input) {
      const f = this.factor;
      const need = this.len + Math.ceil((input.length + this.accCnt) / f) + 1;
      if (need > this.buf.length) {
        const nb = new Float32Array(Math.max(need, this.buf.length * 2));
        nb.set(this.buf.subarray(0, this.len));
        this.buf = nb;
      }
      if (f === 1) {
        this.buf.set(input, this.len);
        this.len += input.length;
        return;
      }
      let acc = this.accSum, cnt = this.accCnt;
      for (let i = 0; i < input.length; i++) {
        acc += input[i];
        cnt++;
        if (cnt === f) {
          this.buf[this.len++] = acc / f;
          acc = 0;
          cnt = 0;
        }
      }
      this.accSum = acc;
      this.accCnt = cnt;
    }

    get pendingFrames() {
      const avail = Math.floor((this.len - this.W - this.tauMax - 1) / this.hop) + 1;
      return Math.max(0, avail - this.midi.length);
    }

    /* Analyse up to maxFrames new frames. Returns how many were done. */
    process(maxFrames = Infinity) {
      let done = 0;
      const { W, tauMin, tauMax, hop, buf } = this;
      const d = this._d;
      while (done < maxFrames) {
        const off = this.midi.length * hop;
        if (off + W + tauMax + 1 > this.len) break;
        let e = 0;
        for (let j = 0; j < W; j++) { const v = buf[off + j]; e += v * v; }
        const rms = Math.sqrt(e / W);
        if (rms < 2e-4) {
          this.midi.push(NaN); this.conf.push(1); this.rms.push(rms);
          done++;
          continue;
        }
        // cumulative mean normalised difference
        d[0] = 1;
        let run = 0;
        for (let tau = 1; tau <= tauMax; tau++) {
          let s = 0;
          for (let j = 0; j < W; j++) {
            const df = buf[off + j] - buf[off + j + tau];
            s += df * df;
          }
          run += s;
          d[tau] = run > 0 ? (s * tau) / run : 1;
        }
        let tau = -1;
        for (let t = tauMin; t < tauMax; t++) {
          if (d[t] < 0.15) {
            while (t + 1 < tauMax && d[t + 1] < d[t]) t++;
            tau = t;
            break;
          }
        }
        if (tau < 0) {
          let best = Infinity;
          for (let t = tauMin; t < tauMax; t++) if (d[t] < best) { best = d[t]; tau = t; }
        }
        const conf = d[tau];
        let tauF = tau;
        if (tau > 1 && tau < tauMax) {
          const a = d[tau - 1], b = d[tau], c = d[tau + 1];
          const den = a - 2 * b + c;
          if (den > 1e-9) tauF = tau + (0.5 * (a - c)) / den;
        }
        this.midi.push(hzToMidi(this.sr / tauF));
        this.conf.push(conf);
        this.rms.push(rms);
        done++;
      }
      return done;
    }

    frames() {
      return { midi: this.midi, conf: this.conf, rms: this.rms, dt: this.dt, t0: this.t0 };
    }
  }

  /* ---------- Helpers ---------- */
  const median = (arr) => {
    if (!arr.length) return NaN;
    const s = Array.from(arr).sort((a, b) => a - b);
    const h = s.length >> 1;
    return s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2;
  };
  const percentile = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(p * sorted.length)))];

  function insertSorted(arr, v) {
    let lo = 0, hi = arr.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (arr[mid] < v) lo = mid + 1; else hi = mid; }
    arr.splice(lo, 0, v);
  }

  /* ---------- Frames -> raw notes ---------- */
  /* detail: 0 (smooth, few notes) .. 1 (detailed, many notes) */
  function segment(F, detail = 0.5) {
    const n = F.midi.length;
    const out = { notes: [], tuning: 0, tuningStrength: 0, gate: 0, track: new Float32Array(n).fill(NaN) };
    if (n < 5) return out;

    const minDur = 0.14 - 0.1 * detail;           // seconds
    const splitThr = 0.9 - 0.35 * detail;         // semitones
    const changeFrames = Math.round(6 - 3 * detail);

    // loudness gate from the recording's own range
    const sortedRms = Array.from(F.rms).sort((a, b) => a - b);
    const p10 = percentile(sortedRms, 0.1), p95 = percentile(sortedRms, 0.95);
    const gate = Math.min(Math.max(p10 * 3, p95 * 0.05, 0.002), p95 * 0.25);
    out.gate = gate;

    const voiced = new Uint8Array(n);
    for (let i = 0; i < n; i++) voiced[i] = isFinite(F.midi[i]) && F.conf[i] < 0.3 && F.rms[i] > gate ? 1 : 0;

    // median-filter the pitch over voiced neighbours (kills octave blips)
    const m = new Float32Array(n).fill(NaN);
    const win = [];
    for (let i = 0; i < n; i++) {
      if (!voiced[i]) continue;
      win.length = 0;
      for (let k = Math.max(0, i - 2); k <= Math.min(n - 1, i + 2); k++) if (voiced[k]) win.push(F.midi[k]);
      m[i] = median(win);
    }

    // drop voiced islands of <= 2 frames, bridge gaps of <= 2 frames
    for (let i = 0; i < n;) {
      if (!voiced[i]) { i++; continue; }
      let j = i; while (j < n && voiced[j]) j++;
      if (j - i <= 2) for (let k = i; k < j; k++) { voiced[k] = 0; m[k] = NaN; }
      i = j;
    }
    for (let i = 1; i < n;) {
      if (voiced[i] || !voiced[i - 1]) { i++; continue; }
      let j = i; while (j < n && !voiced[j]) j++;
      if (j < n && j - i <= 2 && Math.abs(m[j] - m[i - 1]) < 1.5) {
        for (let k = i; k < j; k++) { voiced[k] = 1; m[k] = m[i - 1] + ((m[j] - m[i - 1]) * (k - i + 1)) / (j - i + 1); }
      }
      i = j;
    }
    out.track = m;

    // how far off concert pitch the singer is (circular mean of the cents offsets)
    let sx = 0, sy = 0, cnt = 0;
    for (let i = 1; i < n; i++) {
      if (!voiced[i] || !voiced[i - 1] || Math.abs(m[i] - m[i - 1]) > 0.25) continue;
      const a = 2 * Math.PI * m[i];
      sx += Math.cos(a); sy += Math.sin(a); cnt++;
    }
    if (cnt > 10) {
      out.tuningStrength = Math.hypot(sx, sy) / cnt;
      if (out.tuningStrength > 0.25) out.tuning = Math.atan2(sy, sx) / (2 * Math.PI);
    }

    // smoothed loudness for re-articulation dips
    const s = new Float32Array(n);
    for (let i = 0; i < n; i++) s[i] = (F.rms[Math.max(0, i - 1)] + F.rms[i] + F.rms[Math.min(n - 1, i + 1)]) / 3;

    const segs = []; // {a, b, artic}
    for (let i = 0; i < n;) {
      if (!voiced[i]) { i++; continue; }
      let j = i; while (j < n && voiced[j]) j++;
      // split the voiced run at loudness dips ("na na na" on one pitch)
      const cuts = [i];
      for (let k = i + 3; k < j - 3; k++) {
        if (s[k] > s[k - 1] || s[k] > s[k + 1]) continue;
        let lp = 0, rp = 0;
        for (let q = Math.max(i, k - 12); q < k; q++) lp = Math.max(lp, s[q]);
        for (let q = k + 1; q < Math.min(j, k + 13); q++) rp = Math.max(rp, s[q]);
        if (s[k] < 0.5 * Math.min(lp, rp) && k - cuts[cuts.length - 1] >= 4) cuts.push(k);
      }
      cuts.push(j);
      for (let c = 0; c < cuts.length - 1; c++) {
        // split each piece where the pitch settles somewhere new
        const a = cuts[c], b = cuts[c + 1];
        let start = a, sorted = [], dev = 0, first = true;
        for (let k = a; k < b; k++) {
          if (sorted.length >= 3) {
            const med = sorted[sorted.length >> 1];
            if (Math.abs(m[k] - med) > splitThr) {
              dev++;
              if (dev >= changeFrames) {
                const end = k - dev + 1;
                segs.push({ a: start, b: end, artic: first });
                first = false;
                start = end;
                sorted = [];
                for (let q = end; q <= k; q++) insertSorted(sorted, m[q]);
                dev = 0;
              }
              continue;
            }
            dev = 0;
          }
          insertSorted(sorted, m[k]);
        }
        segs.push({ a: start, b, artic: first });
      }
      i = j;
    }

    // segments -> notes
    let notes = segs.filter((g) => g.b > g.a).map((g) => {
      const len = g.b - g.a;
      const lo = g.a + Math.min(Math.floor(len * 0.2), 8);
      const hi = g.b - Math.min(Math.floor(len * 0.1), 4);
      const vals = [];
      let e = 0;
      for (let k = g.a; k < g.b; k++) { e += F.rms[k]; if (k >= lo && k < hi) vals.push(m[k]); }
      return {
        start: F.t0 + g.a * F.dt - F.dt / 2,
        end: F.t0 + g.b * F.dt - F.dt / 2,
        midi: median(vals.length ? vals : Array.from(m.subarray(g.a, g.b))),
        rms: e / len,
        artic: g.artic,
      };
    });

    // absorb notes that are too short into a touching neighbour, or drop them
    const touch = (x, y) => Math.abs(x.end - y.start) < 0.03;
    for (let guard = 0; guard < 4; guard++) {
      let changed = false;
      for (let k = 0; k < notes.length; k++) {
        const nt = notes[k];
        if (nt.end - nt.start >= minDur) continue;
        const prev = notes[k - 1], next = notes[k + 1];
        const pOk = prev && touch(prev, nt) && !nt.artic;
        const nOk = next && touch(nt, next) && !next.artic;
        if (pOk && (!nOk || Math.abs(prev.midi - nt.midi) <= Math.abs(next.midi - nt.midi))) {
          prev.end = nt.end;
        } else if (nOk) {
          next.start = nt.start; next.artic = nt.artic;
        } else if (nt.end - nt.start >= minDur * 0.6 && nt.artic) {
          continue; // a short but clearly separate note: keep it
        }
        notes.splice(k, 1); k--; changed = true;
      }
      if (!changed) break;
    }
    notes.forEach((nt, id) => { nt.id = id; });
    out.notes = notes;
    return out;
  }

  /* ---------- Key and tempo guesses ---------- */
  const KS_MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
  const KS_MINOR = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

  function detectKey(notes, tuning = 0) {
    const h = new Array(12).fill(0);
    for (const nt of notes) h[((Math.round(nt.midi - tuning) % 12) + 12) % 12] += nt.end - nt.start;
    if (!notes.length) return { root: 0, scale: 'major', score: 0 };
    const corr = (prof, root) => {
      let mh = 0, mp = 0;
      for (let i = 0; i < 12; i++) { mh += h[i]; mp += prof[i]; }
      mh /= 12; mp /= 12;
      let num = 0, dh = 0, dp = 0;
      for (let i = 0; i < 12; i++) {
        const x = h[(i + root) % 12] - mh, y = prof[i] - mp;
        num += x * y; dh += x * x; dp += y * y;
      }
      return dh && dp ? num / Math.sqrt(dh * dp) : 0;
    };
    let best = { root: 0, scale: 'major', score: -2 };
    for (let r = 0; r < 12; r++) {
      const a = corr(KS_MAJOR, r), b = corr(KS_MINOR, r);
      if (a > best.score) best = { root: r, scale: 'major', score: a };
      if (b > best.score) best = { root: r, scale: 'minor', score: b };
    }
    return best;
  }

  /* Best grid phase for a step g: returns {phase, err} with err normalised 0..~0.083 */
  function fitGrid(onsets, g) {
    let best = { phase: 0, err: Infinity };
    const steps = 32;
    for (let p = 0; p < steps; p++) {
      const phase = (p / steps) * g;
      let e = 0;
      for (const t of onsets) {
        const u = (t - phase) / g;
        const dlt = u - Math.round(u);
        e += dlt * dlt;
      }
      e /= onsets.length || 1;
      if (e < best.err) best = { phase, err: e };
    }
    return best;
  }

  function guessTempo(notes) {
    const onsets = notes.map((nt) => nt.start);
    if (onsets.length < 4) return { bpm: 120, confident: false };
    let best = { bpm: 120, err: Infinity };
    for (let bpm = 80; bpm < 160; bpm += 0.5) {
      const e16 = fitGrid(onsets, 15 / bpm).err;
      const e8 = fitGrid(onsets, 30 / bpm).err;
      const err = e16 + 0.25 * e8;
      if (err < best.err) best = { bpm, err };
    }
    return { bpm: Math.round(best.bpm), confident: best.err < 0.03 };
  }

  /* ---------- Raw notes + settings -> final notes ---------- */
  function snapPitch(m, root, scaleKey) {
    const steps = (SCALES[scaleKey] || SCALES.chromatic).steps;
    let best = Math.round(m), bd = Infinity;
    for (let c = Math.floor(m) - 6; c <= Math.ceil(m) + 6; c++) {
      if (!steps.includes((((c - root) % 12) + 12) % 12)) continue;
      const dd = Math.abs(c - m);
      if (dd < bd - 1e-9) { bd = dd; best = c; }
    }
    return best;
  }

  /* settings: {root, scale, fixTuning, tuning, bpm, grid (0 = off, else 4/8/16/32), octave}
     edits: Map id -> {pitch?, deleted?}
     returns {notes:[{start,end,pitch,vel,ids}], shift} ; shift maps raw time -> final time (t - shift) */
  function finalize(raw, settings, edits = new Map()) {
    const tun = settings.fixTuning ? settings.tuning || 0 : 0;
    const maxRms = raw.reduce((a, nt) => Math.max(a, nt.rms || 0), 0) || 1;
    const notes = [];
    for (const nt of raw) {
      const ed = edits.get(nt.id) || {};
      if (ed.deleted) continue;
      const pitch = ed.pitch != null ? ed.pitch : snapPitch(nt.midi - tun, settings.root, settings.scale);
      const prev = notes[notes.length - 1];
      if (prev && !nt.artic && prev.pitch === pitch && nt.start - prev.end < 0.03) {
        prev.end = nt.end; prev.ids.push(nt.id);
        continue;
      }
      const vel = Math.max(1, Math.min(127, Math.round(48 + 72 * Math.sqrt((nt.rms || maxRms) / maxRms))));
      notes.push({ start: nt.start, end: nt.end, pitch, vel, ids: [nt.id] });
    }
    if (!notes.length) return { notes, shift: 0 };

    // settings.anchor (seconds into the recording where beat 0 fell) pins the timing to a known beat,
    // e.g. when the take was sung over the drums. Without it the first note starts the song.
    const anchored = settings.anchor != null && isFinite(settings.anchor);
    let shift = anchored ? settings.anchor : notes[0].start;
    if (settings.grid) {
      const g = 240 / settings.bpm / settings.grid;
      const phase = anchored ? settings.anchor : fitGrid(notes.map((nt) => nt.start), g).phase;
      const q = (t) => Math.round((t - phase) / g) * g;
      const first = anchored ? 0 : q(notes[0].start);
      shift = phase + first;
      let prev = null;
      for (const nt of notes) {
        let a = q(nt.start) - first, b = q(nt.end) - first;
        if (prev && a < prev.start + g - 1e-6) a = prev.start + g;
        if (b < a + g - 1e-6) b = a + g;
        if (prev && prev.end > a) prev.end = a;
        nt.start = a; nt.end = b;
        prev = nt;
      }
    } else {
      for (const nt of notes) { nt.start -= shift; nt.end -= shift; }
      for (let i = 0; i < notes.length - 1; i++) if (notes[i].end > notes[i + 1].start) notes[i].end = notes[i + 1].start;
    }
    const oct = 12 * (settings.octave || 0);
    for (const nt of notes) nt.pitch = Math.max(0, Math.min(127, nt.pitch + oct));
    if (anchored) {
      // anything sung during the count-in lands before beat 0: trim or drop it
      const kept = notes.filter((nt) => nt.end > 1e-6);
      for (const nt of kept) nt.start = Math.max(0, nt.start);
      return { notes: kept, shift };
    }
    return { notes, shift };
  }

  /* ---------- Standard MIDI file (format 0, 480 ticks per quarter) ---------- */
  function writeMidi(notes, bpm, trackName = 'Hummed melody') {
    const PPQ = 480;
    const vlq = (v) => {
      const b = [v & 0x7f];
      while ((v >>= 7) > 0) b.unshift((v & 0x7f) | 0x80);
      return b;
    };
    const tick = (sec) => Math.max(0, Math.round((sec * bpm * PPQ) / 60));
    const ev = [];
    for (const nt of notes) {
      const on = tick(nt.start), off = Math.max(on + 1, tick(nt.end));
      ev.push({ t: on, order: 1, data: [0x90, nt.pitch, nt.vel] });
      ev.push({ t: off, order: 0, data: [0x80, nt.pitch, 0] });
    }
    ev.sort((x, y) => x.t - y.t || x.order - y.order);
    const name = Array.from(new TextEncoder().encode(trackName));
    const usPerQ = Math.round(60000000 / bpm);
    const body = [
      0x00, 0xff, 0x03, ...vlq(name.length), ...name,
      0x00, 0xff, 0x51, 0x03, (usPerQ >> 16) & 0xff, (usPerQ >> 8) & 0xff, usPerQ & 0xff,
      0x00, 0xff, 0x58, 0x04, 0x04, 0x02, 0x18, 0x08,
    ];
    let last = 0;
    for (const e of ev) { body.push(...vlq(e.t - last), ...e.data); last = e.t; }
    body.push(0x00, 0xff, 0x2f, 0x00);
    const len = body.length;
    const head = [
      0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 0, 0, 1, (PPQ >> 8) & 0xff, PPQ & 0xff,
      0x4d, 0x54, 0x72, 0x6b, (len >>> 24) & 0xff, (len >>> 16) & 0xff, (len >>> 8) & 0xff, len & 0xff,
    ];
    return new Uint8Array([...head, ...body]);
  }

  /* ---------- Multi-track standard MIDI file (format 1), timed in beats ----------
     tracks: [{name, channel (0-15), notes:[{start, len, pitch, vel}]}] with start/len in quarter notes. */
  function writeMidiTracks(tracks, bpm, markers = []) {
    const PPQ = 480;
    const vlq = (v) => {
      const b = [v & 0x7f];
      while ((v >>= 7) > 0) b.unshift((v & 0x7f) | 0x80);
      return b;
    };
    const text = (type, s) => { const t = Array.from(new TextEncoder().encode(s)); return [0x00, 0xff, type, ...vlq(t.length), ...t]; };
    const chunk = (body) => {
      const len = body.length;
      return [0x4d, 0x54, 0x72, 0x6b, (len >>> 24) & 0xff, (len >>> 16) & 0xff, (len >>> 8) & 0xff, len & 0xff, ...body];
    };
    const usPerQ = Math.round(60000000 / bpm);
    const conductor = [
      ...text(0x03, 'BrowserDJ'),
      0x00, 0xff, 0x51, 0x03, (usPerQ >> 16) & 0xff, (usPerQ >> 8) & 0xff, usPerQ & 0xff,
      0x00, 0xff, 0x58, 0x04, 0x04, 0x02, 0x18, 0x08,
    ];
    // markers (meta 0x06) so music programs show the song sections
    let lastM = 0;
    for (const m of markers.slice().sort((a, b) => a.beat - b.beat)) {
      const t = Math.max(0, Math.round(m.beat * PPQ));
      const s = Array.from(new TextEncoder().encode(String(m.name || 'Marker')));
      conductor.push(...vlq(t - lastM), 0xff, 0x06, ...vlq(s.length), ...s);
      lastM = t;
    }
    conductor.push(0x00, 0xff, 0x2f, 0x00);
    const out = [0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 1, 0, tracks.length + 1, (PPQ >> 8) & 0xff, PPQ & 0xff, ...chunk(conductor)];
    for (const tr of tracks) {
      const ch = tr.channel & 0x0f;
      const ev = [];
      for (const nt of tr.notes) {
        const on = Math.max(0, Math.round(nt.start * PPQ));
        const off = Math.max(on + 1, Math.round((nt.start + nt.len) * PPQ));
        const pitch = Math.max(0, Math.min(127, Math.round(nt.pitch)));
        const vel = Math.max(1, Math.min(127, Math.round(nt.vel)));
        ev.push({ t: on, order: 1, data: [0x90 | ch, pitch, vel] });
        ev.push({ t: off, order: 0, data: [0x80 | ch, pitch, 0] });
      }
      ev.sort((x, y) => x.t - y.t || x.order - y.order);
      const body = [...text(0x03, tr.name || 'Track')];
      if (tr.program != null && ch !== 9) body.push(0x00, 0xc0 | ch, tr.program & 0x7f);
      // controllers at the start, e.g. {cc: 7, value} volume and {cc: 10, value} pan
      for (const c of tr.controllers || []) body.push(0x00, 0xb0 | ch, c.cc & 0x7f, Math.max(0, Math.min(127, Math.round(c.value))));
      let last = 0;
      for (const e of ev) { body.push(...vlq(e.t - last), ...e.data); last = e.t; }
      body.push(0x00, 0xff, 0x2f, 0x00);
      out.push(...chunk(body));
    }
    return new Uint8Array(out);
  }

  return { Analyzer, segment, detectKey, guessTempo, finalize, writeMidi, writeMidiTracks, snapPitch, noteName, midiToHz, hzToMidi, SCALES, NOTE_NAMES };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = HumEngine;

