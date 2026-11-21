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
    { id: 'supersaw', name: 'Supersaw', program: 82 },
    { id: 'acid', name: 'Acid', program: 39 },
    { id: 'organ', name: 'Organ', program: 17 },
    { id: 'sampler', name: 'Sampler (your sound)', program: 52 },
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
  /* Track drive 0..1 -> {pre gain, curve, makeup gain}. The curve has slope SLOPE0 at zero, so the pre gain
     divides it out: quiet signals pass at the same level for any drive, and more drive only adds clipping.
     0 is a clean bypass (unless `keep`, used while drive is automated so the curve never switches mid-sweep). */
  const DRIVE_H = 2.5, SLOPE0 = DRIVE_H / Math.tanh(DRIVE_H);
  function driveSettings(drive, keep) {
    drive = Math.max(0, Math.min(1, drive || 0));
    if (drive < 0.005 && !keep) return { pre: 1, curve: null, post: 1 };
    // makeup: clipping turns waves square-ish, which carries more energy at the same peak, so pull back harder
    return { pre: (1 + 14 * drive) / SLOPE0, curve: clipCurve(DRIVE_H), post: 1 / (1 + 4 * drive) };
  }

  /* DJ filter: 0..0.5 closes a low-pass, 0.5 is open, 0.5..1 raises a high-pass. */
  function filterFreqs(v) {
    v = Math.max(0, Math.min(1, v == null ? 0.5 : v));
    return {
      lp: v < 0.5 ? 60 * Math.pow(20000 / 60, v / 0.5) : 20000,
      hp: v > 0.5 ? 20 * Math.pow(8000 / 20, (v - 0.5) / 0.5) : 20,
    };
  }

  /* Automatable channel parameters, all stored as 0..1. */
  const PARAMS = [
    { id: 'volume', name: 'Volume', def: 0.8 },
    { id: 'filter', name: 'Filter', def: 0.5 },
    { id: 'pan', name: 'Pan', def: 0.5 },
    { id: 'drive', name: 'Drive', def: 0 },
    { id: 'echo', name: 'Echo', def: 0 },
    { id: 'reverb', name: 'Reverb', def: 0 },
  ];
  /* the 0..1 value a track's own settings give a parameter */
  function trackParam(t, id) {
    if (id === 'volume') return t.volume;
    if (id === 'filter') return t.filter == null ? 0.5 : t.filter;
    if (id === 'pan') return ((t.pan || 0) + 1) / 2;
    if (id === 'drive') return t.drive || 0;
    if (id === 'echo') return t.echoSend || 0;
    if (id === 'reverb') return t.reverb || 0;
    return 0;
  }

  /* Keeps track of scheduled sources so playback can be stopped cleanly. */
  function track(live, node, stopAt) {
    node.stop(stopAt);
    if (!live) return;
    live.add(node);
    node.onended = () => live.delete(node);
  }

  /* ---------- reverb ----------
     A generated room: stereo noise under an exponential decay that also darkens over time (high frequencies
     die first, like a real room). Made once per sample rate and shared; AudioBuffers work in any context. */
  const irCache = new Map();
  function impulse(ac) {
    const sr = ac.sampleRate;
    let b = irCache.get(sr);
    if (b) return b;
    const secs = 2.6, n = Math.round(sr * secs), pre = Math.round(sr * 0.018);
    b = ac.createBuffer(2, n, sr);
    let seed = 22222;
    const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x3fffffff - 1; };
    for (let c = 0; c < 2; c++) {
      const d = b.getChannelData(c);
      let y = 0, energy = 0;
      for (let i = pre; i < n; i++) {
        const t = (i - pre) / sr;
        const a = 0.85 * Math.exp(-t / 0.45) + 0.08;   // one-pole low-pass that closes as the tail goes on
        y += a * (rnd() - y);
        const v = y * Math.exp(-t / 0.62) * Math.min(1, t / 0.006);
        d[i] = v;
        energy += v * v;
      }
      // unit energy: a convolution then keeps the level of what goes in (the wet gain sets how loud the room is)
      const norm = 1 / Math.sqrt(energy);
      for (let i = 0; i < n; i++) d[i] *= norm;
    }
    irCache.set(sr, b);
    return b;
  }

  /* Master ceiling: straight up to 0.78, then a soft knee that levels off near 0.92 (safely under full scale). */
  let ceilCurve = null;
  function ceiling() {
    if (!ceilCurve) {
      ceilCurve = new Float32Array(4096);
      for (let i = 0; i < ceilCurve.length; i++) {
        const x = (i / (ceilCurve.length - 1)) * 2 - 1, a = Math.abs(x);
        // tops out near 0.92 so oversampling overshoot still stays well under full scale
        ceilCurve[i] = a <= 0.78 ? x : Math.sign(x) * (0.78 + 0.16 * Math.tanh((a - 0.78) / 0.16));
      }
    }
    return ceilCurve;
  }
  /* Loud 0..1 -> up to +12 dB pushed into the compressor and limiter */
  const pushGain = (loud) => Math.pow(10, (12 * Math.max(0, Math.min(1, loud || 0))) / 20);

  /* ---------- mixer ---------- */
  /* One channel per track (volume + echo send), a shared echo, and a gentle compressor on the master. */
  function createMixer(ac, opts = {}) {
    const dest = opts.destination || ac.destination;
    const master = ac.createGain();
    master.gain.value = opts.master == null ? 0.85 : opts.master;
    // master: fader -> push (Loud) -> glue compressor -> limiter -> soft-clip ceiling -> out
    const push = ac.createGain();
    push.gain.value = pushGain(opts.loud);
    const comp = ac.createDynamicsCompressor();
    comp.threshold.value = -10; comp.knee.value = 8; comp.ratio.value = 4; comp.attack.value = 0.004; comp.release.value = 0.15;
    const limiter = ac.createDynamicsCompressor();
    limiter.threshold.value = -2; limiter.knee.value = 0; limiter.ratio.value = 20; limiter.attack.value = 0.001; limiter.release.value = 0.08;
    const clip = ac.createWaveShaper();
    clip.curve = ceiling(); clip.oversample = '2x';
    master.connect(push); push.connect(comp); comp.connect(limiter); limiter.connect(clip); clip.connect(dest);
    // stems: with opts.only set, every other track plays into a silent sink (its kicks still drive the pump)
    const sink = ac.createGain();
    sink.gain.value = 0;
    const heard = (track) => opts.only == null || opts.only === track.id;

    const echoIn = ac.createGain();
    const dl = ac.createDelay(2), fb = ac.createGain(), lp = ac.createBiquadFilter(), wet = ac.createGain();
    dl.delayTime.value = Math.min(1.9, (60 / (opts.bpm || 120)) * 0.75);
    fb.gain.value = 0.35; lp.type = 'lowpass'; lp.frequency.value = 2600; wet.gain.value = 0.28;
    echoIn.connect(dl); dl.connect(lp); lp.connect(fb); fb.connect(dl); lp.connect(wet); wet.connect(master);

    // shared reverb: sends -> high-pass (keeps the low end clean) -> convolver -> master
    const revIn = ac.createGain(), revHp = ac.createBiquadFilter(), conv = ac.createConvolver(), revWet = ac.createGain();
    revHp.type = 'highpass'; revHp.frequency.value = 200;
    conv.normalize = false;
    conv.buffer = impulse(ac);
    revWet.gain.value = 0.6;
    revIn.connect(revHp); revHp.connect(conv); conv.connect(revWet); revWet.connect(master);
    let bpm = opts.bpm || 120;

    // master meter, at the very end
    const masterTap = ac.createAnalyser();
    masterTap.fftSize = 512;
    clip.connect(masterTap);

    const channels = new Map();
    /* track: {id, volume, pan, echoSend, drive, filter} -> the node to play into.
       input -> drive (pre gain, waveshaper, makeup) -> DJ filter (low-pass, high-pass) -> pump (duck) -> fader -> panner
       -> master, with post-fader echo and reverb sends and a meter tap.
       `auto` (a Set of parameter ids) marks parameters an automation lane drives; static updates leave those alone. */
    function channel(track) {
      let ch = channels.get(track.id);
      if (!ch) {
        const pre = ac.createGain(), shaper = ac.createWaveShaper(), post = ac.createGain();
        const lp = ac.createBiquadFilter(), hp = ac.createBiquadFilter();
        const gain = ac.createGain(), send = ac.createGain(), rsend = ac.createGain(), duck = ac.createGain(), tap = ac.createAnalyser();
        const pan = ac.createStereoPanner ? ac.createStereoPanner() : null;
        shaper.oversample = '2x';
        lp.type = 'lowpass'; hp.type = 'highpass';
        lp.Q.value = 1.4; hp.Q.value = 1.4; // a little resonance makes sweeps sing
        pre.connect(shaper); shaper.connect(post); post.connect(lp); lp.connect(hp); hp.connect(duck); duck.connect(gain);
        tap.fftSize = 512;
        const out = heard(track) ? master : sink;
        if (pan) { gain.connect(pan); pan.connect(out); pan.connect(tap); }
        else { gain.connect(out); gain.connect(tap); }
        gain.connect(send);
        gain.connect(rsend);
        if (heard(track)) { send.connect(echoIn); rsend.connect(revIn); }
        ch = { pre, shaper, post, lp, hp, duck, gain, send, rsend, pan, tap, buf: new Float32Array(512), auto: new Set(), pump: track.pump || 0 };
        channels.set(track.id, ch);
        for (const prm of PARAMS) setParam(ch, prm.id, trackParam(track, prm.id), null);
      }
      return ch.pre;
    }

    /* Moves one parameter to a 0..1 value: instantly (at == null), smoothly from `at`, or as a ramp ending at `at`. */
    function setParam(ch, id, v, at, ramp) {
      const go = (param, value, expo) => {
        if (at == null) { param.value = value; return; }
        if (ramp) { if (expo) param.exponentialRampToValueAtTime(value, at); else param.linearRampToValueAtTime(value, at); }
        else param.setTargetAtTime(value, at, 0.02);
      };
      if (id === 'volume') go(ch.gain.gain, v);
      else if (id === 'pan') { if (ch.pan) go(ch.pan.pan, v * 2 - 1); }
      else if (id === 'echo') go(ch.send.gain, v);
      else if (id === 'reverb') go(ch.rsend.gain, v);
      else if (id === 'filter') { const f = filterFreqs(v); go(ch.lp.frequency, f.lp, true); go(ch.hp.frequency, f.hp, true); }
      else if (id === 'drive') {
        const d = driveSettings(v, ch.auto.has('drive'));
        ch.shaper.curve = d.curve;
        go(ch.pre.gain, d.pre); go(ch.post.gain, d.post);
      }
    }
    /* automation: hold `v` from `at`, or ramp to `v` arriving at `at` */
    function autoAt(trackId, id, v, at) { const ch = channels.get(trackId); if (ch) setParam(ch, id, v, at, true); }
    function autoStart(trackId, id, v, at) {
      const ch = channels.get(trackId);
      if (!ch) return;
      ch.auto.add(id);
      const p = id === 'volume' ? ch.gain.gain : id === 'pan' ? ch.pan && ch.pan.pan : id === 'echo' ? ch.send.gain : id === 'reverb' ? ch.rsend.gain : null;
      if (id === 'filter') { const f = filterFreqs(v); ch.lp.frequency.setValueAtTime(f.lp, at); ch.hp.frequency.setValueAtTime(f.hp, at); }
      else if (id === 'drive') {
        const d = driveSettings(v, true);
        ch.shaper.curve = d.curve;
        ch.pre.gain.setValueAtTime(d.pre, at); ch.post.gain.setValueAtTime(d.post, at);
      } else if (p) p.setValueAtTime(id === 'pan' ? v * 2 - 1 : v, at);
    }
    /* Sidechain pump: a kick at `when` ducks every channel that has pump, except the kick's own track,
       then lets it swell back over about half a beat. */
    function pumpAt(when, sourceId) {
      for (const [id, ch] of channels) {
        if (id === sourceId || !(ch.pump > 0)) continue;
        const g = ch.duck.gain;
        g.setTargetAtTime(1 - 0.92 * ch.pump, when, 0.003);
        g.setTargetAtTime(1, when + 0.025, (60 / bpm) * 0.13);
      }
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
      ac, master, live, channel, autoStart, autoAt, pumpAt,
      /* static settings changed (a knob moved): follow them, except where automation is in charge */
      update(track) {
        const ch = channels.get(track.id);
        if (!ch) return;
        for (const prm of PARAMS) if (!ch.auto.has(prm.id)) setParam(ch, prm.id, trackParam(track, prm.id), ac.currentTime);
        ch.pump = track.pump || 0;
        if (!ch.pump) { ch.duck.gain.cancelScheduledValues(ac.currentTime); ch.duck.gain.setTargetAtTime(1, ac.currentTime, 0.02); }
      },
      setMaster(v) { master.gain.setTargetAtTime(v, ac.currentTime, 0.02); },
      setLoud(v) { push.gain.setTargetAtTime(pushGain(v), ac.currentTime, 0.02); },
      /* current peak level (0..1+) of a track's channel, or of the master when id is null */
      level(id) {
        if (id == null) return peak(masterTap, masterBuf);
        const ch = channels.get(id);
        return ch ? peak(ch.tap, ch.buf) : 0;
      },
      setBpm(b) { bpm = b; dl.delayTime.setTargetAtTime(Math.min(1.9, (60 / b) * 0.75), ac.currentTime, 0.05); },
      stop() {
        const now = ac.currentTime;
        master.gain.cancelScheduledValues(now);
        master.gain.setTargetAtTime(0, now, 0.015);
        for (const n of live) { try { n.stop(now + 0.1); } catch (err) { /* already stopped */ } }
        live.clear();
        setTimeout(() => { try { master.disconnect(); clip.disconnect(); conv.disconnect(); } catch (err) { /* gone */ } }, 500);
      },
    };
  }

  /* ---------- melody voices ---------- */
  /* A note of known length: {pitch, vel}, when/dur in seconds. */
  function melodyNote(ac, out, note, when, dur, preset, live, shape, sampler) {
    voiceStart(ac, out, note, when, preset, live, Math.max(0.03, dur), shape, sampler).release(when + Math.max(0.03, dur), true);
  }

  /* A track's sound shape, on top of the instrument's own character:
     attack 0..1 (0 = the instrument's own, up to 2 s), release 0..1 (up to 3 s), tone 0..1 (0.5 = as is, ±2 octaves of filter). */
  const SHAPE = { attack: 0, release: 0, tone: 0.5 };
  const attackTime = (v) => (v > 0 ? 0.002 * Math.pow(1000, v) : 0);
  const releaseTime = (v) => (v > 0 ? 0.01 * Math.pow(300, v) : 0);

  /* Starts a voice and returns {release(at, planned)}. A live key calls release when it is let go;
     planned releases (known length) are scheduled straight away. maxDur keeps short notes' attack short. */
  /* sampler: {buffer, root (MIDI pitch of the recording, may be fractional), gain} for the Sampler instrument */
  function voiceStart(ac, out, note, when, preset, live, maxDur, shape, sampler) {
    // a Sampler without a sound yet plays soft keys, so the track is never silent
    if (preset === 'sampler' && !(sampler && sampler.buffer)) preset = 'soft';
    const f = midiToHz(note.pitch), a = when;
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
    } else if (preset === 'supersaw') {
      // seven detuned saws: the wide trance and hardstyle lead
      for (const [d, l] of [[-28, 0.16], [-17, 0.2], [-8, 0.24], [0, 0.26], [8, 0.24], [17, 0.2], [28, 0.16]]) osc('sawtooth', d, l);
      osc('sine', 0, 0.25, -1);
      filt.Q.value = 0.8; filt.frequency.value = Math.min(12000, f * 10); att = 0.01; rel = 0.25; peak = v * 0.9;
    } else if (preset === 'acid') {
      // one saw into a very resonant filter that snaps shut; harder notes open it further
      osc('sawtooth', 0, 0.7);
      filt.Q.value = 14;
      const open = Math.min(9000, f * (6 + 14 * (note.vel / 127)));
      filt.frequency.setValueAtTime(open, a);
      filt.frequency.exponentialRampToValueAtTime(Math.max(180, f * 1.3), a + 0.16 + 0.1 * (note.vel / 127));
      att = 0.003; rel = 0.05; peak = v * 0.8;
    } else if (preset === 'sampler') {
      // your own sound, sped up or slowed down to the note's pitch
      const src = ac.createBufferSource();
      src.buffer = sampler.buffer;
      src.playbackRate.value = Math.pow(2, (note.pitch - sampler.root) / 12);
      const g = ac.createGain();
      g.gain.value = sampler.gain || 1;
      src.connect(g); g.connect(filt);
      mine.push(src);
      filt.frequency.value = 18000; att = 0.004; rel = 0.12; peak = v * 2.4;
    } else if (preset === 'organ') {
      // drawbar-style stack of sine harmonics
      for (const [h, l] of [[1, 0.5], [2, 0.32], [3, 0.22], [4, 0.14], [6, 0.08], [8, 0.06]]) {
        const o = osc('sine', 0, l);
        o.frequency.value = f * h;
      }
      osc('sine', 0, 0.3, -1);
      filt.frequency.value = 9000; att = 0.006; rel = 0.05; peak = v * 1.1;
    } else {
      osc('sawtooth'); osc('sine', 0, 0.5, -1);
      filt.Q.value = 5;
      filt.frequency.setValueAtTime(Math.min(10000, f * 9), a);
      filt.frequency.exponentialRampToValueAtTime(Math.max(350, f * 1.6), a + 0.24);
      att = 0.004; rel = 0.12; decayTo = 0.3;
    }
    // the track's own shaping on top
    const sh = shape || SHAPE;
    if (sh.tone != null && Math.abs(sh.tone - 0.5) > 0.004) filt.detune.value = (sh.tone - 0.5) * 2 * 2400; // cents: moves every filter setting, envelopes too
    if (sh.attack > 0) att = Math.max(att, attackTime(sh.attack));
    if (sh.release > 0) rel = Math.max(rel, releaseTime(sh.release));
    if (maxDur) att = Math.min(att, maxDur * (sh.attack > 0 ? 0.9 : 0.4));
    amp.gain.setValueAtTime(0, a);
    amp.gain.linearRampToValueAtTime(peak, a + att);
    if (decayTo != null) amp.gain.setTargetAtTime(peak * decayTo, a + att, decayT);
    for (const o of mine) o.start(a);
    let done = false;
    return {
      release(at, planned) {
        if (done) return;
        done = true;
        at = Math.max(at, a + 0.03);
        if (!planned) {
          // let go early: freeze the envelope where it is, then fade from there
          const g = amp.gain;
          if (g.cancelAndHoldAtTime) g.cancelAndHoldAtTime(at);
          else { g.cancelScheduledValues(at); g.setValueAtTime(Math.min(peak, g.value || peak), at); }
        }
        amp.gain.setTargetAtTime(0, at, rel / 3);
        for (const o of mine) track(live, o, at + rel * 2 + 0.1);
      },
    };
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

  return { INSTRUMENTS, DRUMS, PARAMS, SHAPE, attackTime, releaseTime, trackParam, filterFreqs, createMixer, melodyNote, voiceStart, drumHit, encodeWav, midiToHz };
})();
