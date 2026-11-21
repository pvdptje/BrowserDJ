/* BrowserDJ sound: melody voices, synthesized drum kit, mixer and WAV export.
   Every function takes an AudioContext (live or offline) so the same code plays and renders. */
window.BDJ = window.BDJ || {};
BDJ.Sound = (() => {
  'use strict';

  const midiToHz = (m) => 440 * Math.pow(2, (m - 69) / 12);

  const INSTRUMENTS = [
    { id: 'pluck', name: 'Pluck', program: 45 },
    { id: 'lead', name: 'Saw lead', program: 81 },
    { id: 'soft', name: 'Soft keys', program: 4 },
    { id: 'chip', name: 'Chiptune', program: 80 },
    { id: 'bass', name: 'Bass', program: 38 },
    { id: 'bell', name: 'Bell', program: 14 },
    { id: 'pad', name: 'Pad', program: 89 },
  ];

  const DRUMS = [
    { id: 'kick', name: 'Kick', gm: 36 },
    { id: 'hkick', name: 'Hard kick', gm: 35 },
    { id: 'snare', name: 'Snare', gm: 38 },
    { id: 'clap', name: 'Clap', gm: 39 },
    { id: 'chat', name: 'Closed hat', gm: 42 },
    { id: 'ohat', name: 'Open hat', gm: 46 },
    { id: 'tom', name: 'Tom', gm: 45 },
    { id: 'rim', name: 'Rim', gm: 37 },
    { id: 'crash', name: 'Crash', gm: 49 },
  ];

  /* ---------- shared bits ---------- */
  const noiseCache = new WeakMap();
  function noise(ac) {
    let b = noiseCache.get(ac);
    if (!b) {
      b = ac.createBuffer(1, Math.round(ac.sampleRate * 2), ac.sampleRate);
      const d = b.getChannelData(0);
      let seed = 1234567;
      for (let i = 0; i < d.length; i++) { seed = (seed * 1103515245 + 12345) & 0x7fffffff; d[i] = (seed / 0x3fffffff) - 1; }
      noiseCache.set(ac, b);
    }
    return b;
  }

  /* Soft-clip curves for distortion, shared by every context. */
  const curves = new Map();
  function clipCurve(hardness) {
    let c = curves.get(hardness);
    if (!c) {
      c = new Float32Array(2048);
      const n = Math.tanh(hardness);
      for (let i = 0; i < c.length; i++) { const x = (i / (c.length - 1)) * 2 - 1; c[i] = Math.tanh(hardness * x) / n; }
      curves.set(hardness, c);
    }
    return c;
  }
  /* Track drive 0..1 -> {pre gain, curve, makeup gain}; 0 is a clean bypass. */
  function driveSettings(drive) {
    drive = Math.max(0, Math.min(1, drive || 0));
    if (drive < 0.005) return { pre: 1, curve: null, post: 1 };
    return { pre: 1 + 14 * drive, curve: clipCurve(2.5), post: 1 / (1 + 2 * drive) };
  }

  /* Keeps track of scheduled sources so playback can be stopped cleanly. */
  function track(live, node, stopAt) {
    node.stop(stopAt);
    if (!live) return;
    live.add(node);
    node.onended = () => live.delete(node);
  }

  /* ---------- mixer ---------- */
  /* One channel per track (volume + echo send), a shared echo, and a gentle compressor on the master. */
  function createMixer(ac, opts = {}) {
    const dest = opts.destination || ac.destination;
    const master = ac.createGain();
    master.gain.value = opts.master == null ? 0.85 : opts.master;
    // the master fader sits before the compressor; the compressor keeps the mix from clipping
    const comp = ac.createDynamicsCompressor();
    comp.threshold.value = -10; comp.knee.value = 8; comp.ratio.value = 4; comp.attack.value = 0.004; comp.release.value = 0.15;
    master.connect(comp);
    comp.connect(dest);

    const echoIn = ac.createGain();
    const dl = ac.createDelay(2), fb = ac.createGain(), lp = ac.createBiquadFilter(), wet = ac.createGain();
    dl.delayTime.value = Math.min(1.9, (60 / (opts.bpm || 120)) * 0.75);
    fb.gain.value = 0.35; lp.type = 'lowpass'; lp.frequency.value = 2600; wet.gain.value = 0.28;
    echoIn.connect(dl); dl.connect(lp); lp.connect(fb); fb.connect(dl); lp.connect(wet); wet.connect(master);

    // master meter, after the compressor
    const masterTap = ac.createAnalyser();
    masterTap.fftSize = 512;
    comp.connect(masterTap);

    const channels = new Map();
    /* track: {id, volume, pan, echoSend, drive} -> the node to play into.
       input -> drive (pre gain, waveshaper, makeup) -> fader -> panner -> master,
       with a post-fader echo send and a meter tap */
    function applyDrive(ch, drive, at) {
      const d = driveSettings(drive);
      ch.shaper.curve = d.curve;
      if (at == null) { ch.pre.gain.value = d.pre; ch.post.gain.value = d.post; }
      else { ch.pre.gain.setTargetAtTime(d.pre, at, 0.02); ch.post.gain.setTargetAtTime(d.post, at, 0.02); }
    }
    function channel(track) {
      let ch = channels.get(track.id);
      if (!ch) {
        const pre = ac.createGain(), shaper = ac.createWaveShaper(), post = ac.createGain();
        const gain = ac.createGain(), send = ac.createGain(), tap = ac.createAnalyser();
        const pan = ac.createStereoPanner ? ac.createStereoPanner() : null;
        shaper.oversample = '2x';
        pre.connect(shaper); shaper.connect(post); post.connect(gain);
        tap.fftSize = 512;
        gain.gain.value = track.volume;
        send.gain.value = track.echoSend || 0;
        if (pan) { pan.pan.value = track.pan || 0; gain.connect(pan); pan.connect(master); pan.connect(tap); }
        else { gain.connect(master); gain.connect(tap); }
        gain.connect(send);
        send.connect(echoIn);
        ch = { pre, shaper, post, gain, send, pan, tap, buf: new Float32Array(512) };
        applyDrive(ch, track.drive);
        channels.set(track.id, ch);
      }
      return ch.pre;
    }
    const peak = (tap, buf) => {
      tap.getFloatTimeDomainData(buf);
      let m = 0;
      for (let i = 0; i < buf.length; i++) { const v = Math.abs(buf[i]); if (v > m) m = v; }
      return m;
    };
    const masterBuf = new Float32Array(512);

    const live = new Set();
    return {
      ac, master, live, channel,
      update(track) {
        const ch = channels.get(track.id);
        if (!ch) return;
        const now = ac.currentTime;
        ch.gain.gain.setTargetAtTime(track.volume, now, 0.02);
        ch.send.gain.setTargetAtTime(track.echoSend || 0, now, 0.02);
        if (ch.pan) ch.pan.pan.setTargetAtTime(track.pan || 0, now, 0.02);
        applyDrive(ch, track.drive, now);
      },
      setMaster(v) { master.gain.setTargetAtTime(v, ac.currentTime, 0.02); },
      /* current peak level (0..1+) of a track's channel, or of the master when id is null */
      level(id) {
        if (id == null) return peak(masterTap, masterBuf);
        const ch = channels.get(id);
        return ch ? peak(ch.tap, ch.buf) : 0;
      },
      setBpm(bpm) { dl.delayTime.setTargetAtTime(Math.min(1.9, (60 / bpm) * 0.75), ac.currentTime, 0.05); },
      stop() {
        const now = ac.currentTime;
        master.gain.cancelScheduledValues(now);
        master.gain.setTargetAtTime(0, now, 0.015);
        for (const n of live) { try { n.stop(now + 0.1); } catch (err) { /* already stopped */ } }
        live.clear();
        setTimeout(() => { try { master.disconnect(); comp.disconnect(); } catch (err) { /* gone */ } }, 500);
      },
    };
  }

  /* ---------- melody voices ---------- */
  /* note: {pitch, vel}; when/dur in seconds */
  function melodyNote(ac, out, note, when, dur, preset, live) {
    const f = midiToHz(note.pitch), a = when, b = Math.max(a + 0.03, when + dur);
    const v = Math.pow(note.vel / 127, 1.3) * 0.3;
    const filt = ac.createBiquadFilter();
    filt.type = 'lowpass';
    const amp = ac.createGain();
    amp.gain.value = 0;
    filt.connect(amp);
    amp.connect(out);
    const mine = [];
    const osc = (type, detune, level, octave) => {
      const o = ac.createOscillator(), og = ac.createGain();
      o.type = type; o.frequency.value = f * Math.pow(2, octave || 0); o.detune.value = detune || 0;
      og.gain.value = level == null ? 1 : level;
      o.connect(og); og.connect(filt);
      mine.push(o);
      return o;
    };
    let att = 0.01, rel = 0.09, peak = v, decayTo = null, decayT = 0.16;
    if (preset === 'lead') {
      osc('sawtooth', -9, 0.6); osc('sawtooth', 9, 0.6);
      filt.Q.value = 1.5; filt.frequency.value = Math.min(9000, f * 5); att = 0.012; peak = v * 0.75;
    } else if (preset === 'soft') {
      osc('sine'); osc('triangle', 0, 0.25, 1);
      filt.frequency.value = 6000; att = 0.025; rel = 0.2; peak = v * 1.3;
    } else if (preset === 'chip') {
      osc('square', 0, 0.45);
      filt.frequency.value = 7000; att = 0.002; rel = 0.02;
    } else if (preset === 'bass') {
      osc('sawtooth', 0, 0.7); osc('sine', 0, 0.9, -1);
      filt.Q.value = 3;
      filt.frequency.setValueAtTime(Math.min(4000, f * 6), a);
      filt.frequency.exponentialRampToValueAtTime(Math.max(120, f * 1.5), a + 0.3);
      att = 0.005; rel = 0.08; peak = v * 1.1;
    } else if (preset === 'pad') {
      osc('sawtooth', -12, 0.45); osc('sawtooth', 12, 0.45); osc('triangle', 0, 0.4, -1);
      filt.Q.value = 0.7; filt.frequency.value = Math.min(5000, f * 3.5);
      att = 0.28; rel = 0.6; peak = v * 0.8;
    } else if (preset === 'bell') {
      const car = osc('sine', 0, 1);
      const mod = ac.createOscillator(), mg = ac.createGain();
      mod.frequency.value = f * 3.5;
      mg.gain.setValueAtTime(f * 2.2, a);
      mg.gain.exponentialRampToValueAtTime(f * 0.05, a + 1.2);
      mod.connect(mg); mg.connect(car.frequency);
      mine.push(mod);
      filt.frequency.value = 12000; att = 0.003; rel = 0.5; decayTo = 0.25; decayT = 0.5; peak = v * 1.1;
    } else {
      osc('sawtooth'); osc('sine', 0, 0.5, -1);
      filt.Q.value = 5;
      filt.frequency.setValueAtTime(Math.min(10000, f * 9), a);
      filt.frequency.exponentialRampToValueAtTime(Math.max(350, f * 1.6), a + 0.24);
      att = 0.004; rel = 0.12; decayTo = 0.3;
    }
    att = Math.min(att, (b - a) * 0.4);
    amp.gain.setValueAtTime(0, a);
    amp.gain.linearRampToValueAtTime(peak, a + att);
    if (decayTo != null) amp.gain.setTargetAtTime(peak * decayTo, a + att, decayT);
    amp.gain.setTargetAtTime(0, b, rel / 3);
    for (const o of mine) { o.start(a); track(live, o, b + rel * 2 + 0.1); }
  }

  /* ---------- drum kit ---------- */
  function env(ac, out, when, peak, decay, attack = 0.001) {
    const g = ac.createGain();
    g.gain.setValueAtTime(0, when);
    g.gain.linearRampToValueAtTime(peak, when + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, when + attack + decay);
    g.connect(out);
    return g;
  }
  function noiseSrc(ac, when, dur, live) {
    const s = ac.createBufferSource();
    s.buffer = noise(ac);
    s.start(when, Math.random() * 1.5);
    track(live, s, when + dur);
    return s;
  }
  function metal(ac, dest, when, dur, live) {
    const ratios = [2, 3, 4.16, 5.43, 6.79, 8.21];
    for (const r of ratios) {
      const o = ac.createOscillator();
      o.type = 'square';
      o.frequency.value = 40 * r;
      const g = ac.createGain(); g.gain.value = 0.18;
      o.connect(g); g.connect(dest);
      o.start(when);
      track(live, o, when + dur);
    }
  }

  function drumHit(ac, out, id, when, vel, sample, live, gain = 1) {
    const amt = Math.pow(Math.max(1, vel) / 127, 1.4) * gain;
    if (sample) {
      const s = ac.createBufferSource();
      s.buffer = sample;
      const g = ac.createGain(); g.gain.value = amt;
      s.connect(g); g.connect(out);
      s.start(when);
      track(live, s, when + sample.duration + 0.05);
      return;
    }
    if (id === 'kick') {
      const o = ac.createOscillator();
      o.frequency.setValueAtTime(165, when);
      o.frequency.exponentialRampToValueAtTime(48, when + 0.13);
      o.connect(env(ac, out, when, 1.0 * amt, 0.42));
      o.start(when); track(live, o, when + 0.5);
      const hp = ac.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 2500;
      hp.connect(env(ac, out, when, 0.35 * amt, 0.012));
      noiseSrc(ac, when, 0.03, live).connect(hp);
    } else if (id === 'hkick') {
      // hardcore kick: a long pitch drop driven hard into a clipper, so the tail buzzes
      const o = ac.createOscillator();
      o.frequency.setValueAtTime(320, when);
      o.frequency.exponentialRampToValueAtTime(62, when + 0.07);
      o.frequency.exponentialRampToValueAtTime(46, when + 0.5);
      const body = ac.createGain();
      body.gain.setValueAtTime(1, when);
      body.gain.exponentialRampToValueAtTime(0.25, when + 0.55);
      const drive = ac.createGain(); drive.gain.value = 9;
      const sh = ac.createWaveShaper(); sh.curve = clipCurve(3); sh.oversample = '2x';
      const lp = ac.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 5200;
      const out2 = ac.createGain();
      out2.gain.setValueAtTime(0.5 * amt, when);
      out2.gain.setValueAtTime(0.5 * amt, when + 0.42);
      out2.gain.linearRampToValueAtTime(0, when + 0.62);
      o.connect(body); body.connect(drive); drive.connect(sh); sh.connect(lp); lp.connect(out2); out2.connect(out);
      o.start(when); track(live, o, when + 0.65);
      const hp = ac.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 3000;
      hp.connect(env(ac, out, when, 0.3 * amt, 0.01));
      noiseSrc(ac, when, 0.03, live).connect(hp);
    } else if (id === 'snare') {
      const o = ac.createOscillator(); o.type = 'triangle';
      o.frequency.setValueAtTime(200, when);
      o.frequency.exponentialRampToValueAtTime(160, when + 0.08);
      o.connect(env(ac, out, when, 0.45 * amt, 0.11));
      o.start(when); track(live, o, when + 0.15);
      const bp = ac.createBiquadFilter(); bp.type = 'highpass'; bp.frequency.value = 1400;
      bp.connect(env(ac, out, when, 0.55 * amt, 0.19));
      noiseSrc(ac, when, 0.25, live).connect(bp);
    } else if (id === 'clap') {
      const bp = ac.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 1150; bp.Q.value = 1.1;
      const g = ac.createGain();
      g.gain.setValueAtTime(0, when);
      for (const k of [0, 0.011, 0.022]) {
        g.gain.setValueAtTime(0.9 * amt, when + k);
        g.gain.exponentialRampToValueAtTime(0.08 * amt, when + k + 0.009);
      }
      g.gain.setValueAtTime(0.75 * amt, when + 0.032);
      g.gain.exponentialRampToValueAtTime(0.0001, when + 0.22);
      bp.connect(g); g.connect(out);
      noiseSrc(ac, when, 0.25, live).connect(bp);
    } else if (id === 'chat' || id === 'ohat') {
      const open = id === 'ohat', dur = open ? 0.34 : 0.055;
      const bp = ac.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 10000; bp.Q.value = 0.8;
      const hp = ac.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 7000;
      bp.connect(hp); hp.connect(env(ac, out, when, (open ? 0.5 : 0.55) * amt, dur));
      metal(ac, bp, when, dur + 0.05, live);
    } else if (id === 'tom') {
      const o = ac.createOscillator();
      o.frequency.setValueAtTime(150, when);
      o.frequency.exponentialRampToValueAtTime(92, when + 0.2);
      o.connect(env(ac, out, when, 0.8 * amt, 0.32));
      o.start(when); track(live, o, when + 0.4);
    } else if (id === 'rim') {
      const o = ac.createOscillator(); o.type = 'square'; o.frequency.value = 820;
      const bp = ac.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 1700; bp.Q.value = 3;
      o.connect(bp); bp.connect(env(ac, out, when, 0.6 * amt, 0.035));
      o.start(when); track(live, o, when + 0.06);
    } else if (id === 'crash') {
      const hp = ac.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 5000;
      hp.connect(env(ac, out, when, 0.4 * amt, 1.4, 0.003));
      noiseSrc(ac, when, 1.5, live).connect(hp);
      const bp = ac.createBiquadFilter(); bp.type = 'highpass'; bp.frequency.value = 6000;
      bp.connect(env(ac, out, when, 0.25 * amt, 1.0, 0.003));
      metal(ac, bp, when, 1.1, live);
    }
  }

  /* ---------- WAV ---------- */
  function encodeWav(buf) {
    const ch = buf.numberOfChannels, n = buf.length, sr = buf.sampleRate;
    const data = new DataView(new ArrayBuffer(44 + n * ch * 2));
    const str = (o, s) => { for (let i = 0; i < s.length; i++) data.setUint8(o + i, s.charCodeAt(i)); };
    str(0, 'RIFF'); data.setUint32(4, 36 + n * ch * 2, true); str(8, 'WAVE');
    str(12, 'fmt '); data.setUint32(16, 16, true); data.setUint16(20, 1, true); data.setUint16(22, ch, true);
    data.setUint32(24, sr, true); data.setUint32(28, sr * ch * 2, true); data.setUint16(32, ch * 2, true); data.setUint16(34, 16, true);
    str(36, 'data'); data.setUint32(40, n * ch * 2, true);
    const chans = [];
    for (let c = 0; c < ch; c++) chans.push(buf.getChannelData(c));
    let o = 44;
    for (let i = 0; i < n; i++) {
      for (let c = 0; c < ch; c++) {
        const s = Math.max(-1, Math.min(1, chans[c][i]));
        data.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true);
        o += 2;
      }
    }
    return new Blob([data], { type: 'audio/wav' });
  }

  return { INSTRUMENTS, DRUMS, createMixer, melodyNote, drumHit, encodeWav, midiToHz };
})();
