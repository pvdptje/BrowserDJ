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

  /* Drum kit styles: the same nine sounds, made differently. Classic is the original kit; the others replace the
     sounds they have their own take on and play Classic for the rest. */
  const KITS = [
    { id: 'classic', name: 'Classic' },
    { id: '808', name: '808' },
    { id: 'acoustic', name: 'Acoustic' },
    { id: 'lofi', name: 'Lo-fi' },
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

  /* Master ceiling: straight up to 0.78, then a soft knee that levels off near 0.94. */
  let ceilCurve = null;
  function ceiling() {
    if (!ceilCurve) {
      ceilCurve = new Float32Array(4096);
      for (let i = 0; i < ceilCurve.length; i++) {
        const x = (i / (ceilCurve.length - 1)) * 2 - 1, a = Math.abs(x);
        ceilCurve[i] = a <= 0.78 ? x : Math.sign(x) * (0.78 + 0.16 * Math.tanh((a - 0.78) / 0.16));
      }
    }
    return ceilCurve;
  }
  /* The last stage: the ceiling's oversampling filter can ring a few percent past it on sharp, noisy hits. This one
     (no oversampling, so nothing after it can overshoot) leaves everything up to 0.93 alone and stops at 0.96. */
  let guardCurve = null;
  function guard() {
    if (!guardCurve) {
      guardCurve = new Float32Array(4096);
      for (let i = 0; i < guardCurve.length; i++) {
        const x = (i / (guardCurve.length - 1)) * 2 - 1, a = Math.abs(x);
        guardCurve[i] = a <= 0.93 ? x : Math.sign(x) * (0.93 + 0.03 * Math.tanh((a - 0.93) / 0.03));
      }
    }
    return guardCurve;
  }
  /* Loud 0..1 -> up to +12 dB pushed into the compressor and limiter */
  const pushGain = (loud) => Math.pow(10, (12 * Math.max(0, Math.min(1, loud || 0))) / 20);

  /* ---------- movement (LFO) ----------
     track.lfo = {target: 'off'|'filter'|'volume'|'pan', rate, depth 0..1}; rate is a note length, cycles lock to the beat */
  const LFO_RATES = { '1/1': 4, '1/2': 2, '1/4': 1, '1/8': 0.5, '1/16': 0.25, '1/4T': 2 / 3, '1/8T': 1 / 3 };
  const LFO_TARGETS = ['off', 'filter', 'volume', 'pan'];
  const WOB_TOP = 5000; // Hz: where the Wobble filter opens to

  /* ---------- mixer ---------- */
  /* One channel per track (volume + echo send), a shared echo, and a gentle compressor on the master. */
  function createMixer(ac, opts = {}) {
    const dest = opts.destination || ac.destination;
    const master = ac.createGain();
    master.gain.value = opts.master == null ? 0.85 : opts.master;
    // master: fader -> push (Loud) -> glue compressor -> limiter -> soft-clip ceiling -> safety stop -> out
    const push = ac.createGain();
    push.gain.value = pushGain(opts.loud);
    const comp = ac.createDynamicsCompressor();
    comp.threshold.value = -10; comp.knee.value = 8; comp.ratio.value = 4; comp.attack.value = 0.004; comp.release.value = 0.15;
    const limiter = ac.createDynamicsCompressor();
    limiter.threshold.value = -2; limiter.knee.value = 0; limiter.ratio.value = 20; limiter.attack.value = 0.001; limiter.release.value = 0.08;
    const clip = ac.createWaveShaper();
    clip.curve = ceiling(); clip.oversample = '2x';
    const safe = ac.createWaveShaper();
    safe.curve = guard(); safe.oversample = 'none';
    master.connect(push); push.connect(comp); comp.connect(limiter); limiter.connect(clip); clip.connect(safe); safe.connect(dest);
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
    // the audio-clock time of song beat 0: LFO cycles start on beat boundaries counted from here
    let lfoZero = opts.lfoZero || 0;

    // master meter, at the very end
    const masterTap = ac.createAnalyser();
    masterTap.fftSize = 512;
    clip.connect(masterTap);

    const channels = new Map();
    /* track: {id, volume, pan, echoSend, drive, filter} -> the node to play into.
       input -> drive (pre gain, waveshaper, makeup) -> DJ filter (low-pass, high-pass) -> wobble filter -> pump (duck) -> tremolo -> fader -> panner
       -> master, with post-fader echo and reverb sends and a meter tap.
       `auto` (a Set of parameter ids) marks parameters an automation lane drives; static updates leave those alone. */
    function channel(track) {
      let ch = channels.get(track.id);
      if (!ch) {
        const pre = ac.createGain(), shaper = ac.createWaveShaper(), post = ac.createGain();
        const lp = ac.createBiquadFilter(), hp = ac.createBiquadFilter();
        const gain = ac.createGain(), send = ac.createGain(), rsend = ac.createGain(), duck = ac.createGain(), trem = ac.createGain(), tap = ac.createAnalyser();
        const wob = ac.createBiquadFilter(); // the Wobble filter: wide open (and flat) until Movement uses it
        wob.type = 'lowpass'; wob.frequency.value = ac.sampleRate / 2; wob.Q.value = 0;
        const pan = ac.createStereoPanner ? ac.createStereoPanner() : null;
        shaper.oversample = '2x';
        lp.type = 'lowpass'; hp.type = 'highpass';
        lp.Q.value = 1.4; hp.Q.value = 1.4; // a little resonance makes sweeps sing
        pre.connect(shaper); shaper.connect(post); post.connect(lp); lp.connect(hp); hp.connect(wob); wob.connect(duck); duck.connect(trem); trem.connect(gain);
        tap.fftSize = 512;
        const out = heard(track) ? master : sink;
        if (pan) { gain.connect(pan); pan.connect(out); pan.connect(tap); }
        else { gain.connect(out); gain.connect(tap); }
        gain.connect(send);
        gain.connect(rsend);
        if (heard(track)) { send.connect(echoIn); rsend.connect(revIn); }
        ch = { pre, shaper, post, lp, hp, wob, duck, trem, gain, send, rsend, pan, tap, lfo: null, lfoKey: '', buf: new Float32Array(512), auto: new Set(), pump: track.pump || 0 };
        channels.set(track.id, ch);
        for (const prm of PARAMS) setParam(ch, prm.id, trackParam(track, prm.id), null);
        setLfo(ch, track.lfo);
      }
      return ch.pre;
    }

    /* (Re)builds a channel's LFO. Filter: moves the low-pass cutoff down by up to 7 octaves through its detune
       input, so it never fights the DJ filter or its automation. Volume: dips the level by up to the depth.
       Pan: sweeps left and right. The oscillator starts on the next cycle boundary of the song's grid. */
    function setLfo(ch, lfo, force) {
      const target = lfo && LFO_TARGETS.includes(lfo.target) ? lfo.target : 'off';
      const depth = target === 'off' ? 0 : Math.max(0, Math.min(1, lfo.depth == null ? 0.6 : lfo.depth));
      const beats = LFO_RATES[lfo && lfo.rate] || 0.5;
      const key = target + '|' + beats + '|' + depth.toFixed(3) + '|' + bpm + '|' + lfoZero.toFixed(4);
      if (!force && key === ch.lfoKey) return;
      ch.lfoKey = key;
      if (ch.lfo) { try { ch.lfo.osc.stop(); ch.lfo.osc.disconnect(); ch.lfo.amt.disconnect(); } catch (err) { /* gone */ } ch.lfo = null; }
      ch.wob.frequency.value = ac.sampleRate / 2; ch.wob.detune.value = 0; ch.wob.Q.value = 0; ch.trem.gain.value = 1;
      if (target === 'off' || depth <= 0) return;
      const osc = ac.createOscillator(), amt = ac.createGain();
      osc.type = target === 'filter' ? 'triangle' : 'sine';
      const cycle = (beats * 60) / bpm;
      osc.frequency.value = 1 / cycle;
      osc.connect(amt);
      if (target === 'filter') {
        // a resonant low-pass sweeping down from WOB_TOP by up to 6.5 octaves, whatever the DJ filter is doing
        const half = (depth * 6.5 * 1200) / 2;
        ch.wob.frequency.value = WOB_TOP; ch.wob.Q.value = 4; ch.wob.detune.value = -half;
        amt.gain.value = half; amt.connect(ch.wob.detune);
      }
      else if (target === 'volume') { amt.gain.value = depth / 2; ch.trem.gain.value = 1 - depth / 2; amt.connect(ch.trem.gain); }
      else if (target === 'pan' && ch.pan) { amt.gain.value = depth; amt.connect(ch.pan.pan); }
      // start exactly on a cycle boundary of the song grid, so every cycle sits the same way against the beat
      const now = ac.currentTime;
      const k = Math.max(0, Math.ceil((now + 0.005 - lfoZero) / cycle));
      osc.start(lfoZero + k * cycle);
      ch.lfo = { osc, amt };
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
        setLfo(ch, track.lfo);
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
      /* a new tempo, now, or from `when` (a tempo change in the song, scheduled ahead). With `zero` (where beat 0
         would have sounded at the new tempo) running LFOs keep going: they just change speed at `when`. */
      setBpm(b, when, zero) {
        bpm = b;
        const at = when == null ? ac.currentTime : when;
        if (when == null) dl.delayTime.cancelScheduledValues(at);
        dl.delayTime.setTargetAtTime(Math.min(1.9, (60 / b) * 0.75), at, 0.05);
        if (zero == null) return;
        lfoZero = zero;
        for (const ch of channels.values()) {
          if (!ch.lfo) continue;
          const parts = ch.lfoKey.split('|'), beats = +parts[1];
          ch.lfo.osc.frequency.setValueAtTime(b / (beats * 60), at);
          parts[3] = String(b); parts[4] = zero.toFixed(4);
          ch.lfoKey = parts.join('|');
        }
      },
      /* where song beat 0 sits on the audio clock (after a tempo change or a jump); LFOs restart on the new grid */
      setLfoZero(t, tracks) { lfoZero = t; for (const tr of tracks || []) { const ch = channels.get(tr.id); if (ch) setLfo(ch, tr.lfo, true); } },
      stop() {
        const now = ac.currentTime;
        master.gain.cancelScheduledValues(now);
        master.gain.setTargetAtTime(0, now, 0.015);
        for (const n of live) { try { n.stop(now + 0.1); } catch (err) { /* already stopped */ } }
        live.clear();
        for (const ch of channels.values()) if (ch.lfo) { try { ch.lfo.osc.stop(now + 0.1); } catch (err) { /* gone */ } }
        setTimeout(() => { try { master.disconnect(); clip.disconnect(); safe.disconnect(); conv.disconnect(); } catch (err) { /* gone */ } }, 500);
      },
    };
  }

  /* ---------- melody voices ---------- */
  /* A note of known length: {pitch, vel}, when/dur in seconds. */
  function melodyNote(ac, out, note, when, dur, preset, live, shape, sampler) {
    voiceStart(ac, out, note, when, preset, live, Math.max(0.03, dur), shape, sampler).release(when + Math.max(0.03, dur), true);
  }

  /* A track's sound shape, on top of the instrument's own character:
     attack 0..1 (0 = the instrument's own, up to 2 s), release 0..1 (up to 3 s), tone 0..1 (0.5 = as is, ±2 octaves of filter),
     glide 0..1: how long a slide note takes to reach its pitch (20 ms to about half a second). */
  const SHAPE = { attack: 0, release: 0, tone: 0.5, glide: 0.3 };
  const glideTime = (v) => 0.02 + 0.5 * Math.pow(v == null ? 0.3 : v, 2);
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
    // with Wobble on, the track's wobble filter does the filtering: the voice stays open so there is something to sweep
    if (sh.wobble) { filt.frequency.cancelScheduledValues(0); filt.frequency.setValueAtTime(12000, a); }
    if (sh.tone != null && Math.abs(sh.tone - 0.5) > 0.004) filt.detune.value = (sh.tone - 0.5) * 2 * 2400; // cents: moves every filter setting, envelopes too
    // velocity colours the tone as well as the level: harder notes a little brighter, soft ones darker
    filt.detune.value += (note.vel / 127 - 0.8) * 1500;
    // a slide note starts at the pitch of the note before it and glides to its own (cents, so it sounds even)
    if (note.glideFrom != null && note.glideFrom !== note.pitch) {
      const cents = (note.glideFrom - note.pitch) * 100, gt = Math.min(glideTime(sh.glide), maxDur ? maxDur * 0.9 : 1);
      for (const o of mine) { const d0 = o.detune.value; o.detune.setValueAtTime(d0 + cents, a); o.detune.linearRampToValueAtTime(d0, a + gt); }
    }
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

  function drumHit(ac, out, id, when, vel, sample, live, gain = 1, style = 'classic') {
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
    if (style === '808' && KIT808[id]) { KIT808[id](ac, out, when, amt, live); return; }
    if (style === 'acoustic' && KITAC[id]) { KITAC[id](ac, out, when, amt, live); return; }
    if (style === 'lofi') out = lofi(ac, out);
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

  /* helpers for the kits below */
  function tone(ac, dest, type, f0, f1, glide, when, dur, live) {
    const o = ac.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(f0, when);
    if (f1 && f1 !== f0) o.frequency.exponentialRampToValueAtTime(f1, when + glide);
    o.connect(dest);
    o.start(when); track(live, o, when + dur);
    return o;
  }
  function filt(ac, type, freq, q, dest) {
    const b = ac.createBiquadFilter();
    b.type = type; b.frequency.value = freq; if (q != null) b.Q.value = q;
    b.connect(dest);
    return b;
  }
  /* Lo-fi: fewer bits, no sparkle, a little grit; the Classic sounds go through it */
  let crushCurve = null;
  function lofi(ac, out) {
    if (!crushCurve) {
      crushCurve = new Float32Array(4096);
      for (let i = 0; i < crushCurve.length; i++) { const x = (i / (crushCurve.length - 1)) * 2 - 1; crushCurve[i] = Math.round(Math.tanh(1.6 * x) * 12) / 12 * 0.9; }
    }
    const sh = ac.createWaveShaper(); sh.curve = crushCurve;
    const lp = filt(ac, 'lowpass', 3400, 0.9, out);
    const hp = filt(ac, 'highpass', 70, 0.7, lp);
    sh.connect(hp);
    return sh;
  }

  /* 808: long sine kick, two-tone snare, thin metallic hats, sine toms, the classic rimshot ping */
  const KIT808 = {
    kick(ac, out, when, amt, live) {
      const sh = ac.createWaveShaper(); sh.curve = clipCurve(1.4);
      sh.connect(env(ac, out, when, 0.95 * amt, 1.1));
      const o = tone(ac, sh, 'sine', 128, 50, 0.07, when, 1.2, live);
      o.frequency.exponentialRampToValueAtTime(44, when + 1.0);
    },
    snare(ac, out, when, amt, live) {
      const g = env(ac, out, when, 0.3 * amt, 0.13);
      tone(ac, g, 'triangle', 185, 175, 0.1, when, 0.16, live);
      tone(ac, g, 'triangle', 330, 320, 0.1, when, 0.16, live);
      noiseSrc(ac, when, 0.25, live).connect(filt(ac, 'highpass', 1800, 0.7, env(ac, out, when, 0.5 * amt, 0.2)));
    },
    chat(ac, out, when, amt, live) { KIT808.hat(ac, out, when, amt, live, 0.045); },
    ohat(ac, out, when, amt, live) { KIT808.hat(ac, out, when, amt, live, 0.5); },
    hat(ac, out, when, amt, live, dur) {
      const hp = filt(ac, 'highpass', 6500, 0.7, env(ac, out, when, 0.5 * amt, dur));
      const bp = filt(ac, 'bandpass', 8200, 1.2, hp);
      metal(ac, bp, when, dur + 0.05, live);
    },
    tom(ac, out, when, amt, live) { tone(ac, env(ac, out, when, 0.85 * amt, 0.45), 'sine', 220, 135, 0.18, when, 0.5, live); },
    rim(ac, out, when, amt, live) {
      const hp = filt(ac, 'highpass', 300, 0.7, env(ac, out, when, 0.45 * amt, 0.035));
      tone(ac, hp, 'sine', 455, 455, 0, when, 0.05, live);
      tone(ac, hp, 'sine', 1667, 1667, 0, when, 0.05, live);
    },
  };

  /* Acoustic-ish: a kick with a beater, a snare with wires, airy hats, toms with a stick attack, a long crash */
  const KITAC = {
    kick(ac, out, when, amt, live) {
      tone(ac, env(ac, out, when, 0.95 * amt, 0.3), 'sine', 98, 52, 0.045, when, 0.35, live);
      tone(ac, env(ac, out, when, 0.3 * amt, 0.2), 'triangle', 62, 55, 0.1, when, 0.25, live);
      noiseSrc(ac, when, 0.04, live).connect(filt(ac, 'lowpass', 3000, 0.7, env(ac, out, when, 0.4 * amt, 0.018)));
    },
    snare(ac, out, when, amt, live) {
      tone(ac, env(ac, out, when, 0.32 * amt, 0.07), 'triangle', 195, 178, 0.06, when, 0.1, live);
      noiseSrc(ac, when, 0.35, live).connect(filt(ac, 'bandpass', 3000, 0.6, env(ac, out, when, 0.6 * amt, 0.26)));
      noiseSrc(ac, when, 0.4, live).connect(filt(ac, 'highpass', 6000, 0.7, env(ac, out, when, 0.22 * amt, 0.34)));
    },
    chat(ac, out, when, amt, live) { KITAC.hat(ac, out, when, amt, live, 0.09); },
    ohat(ac, out, when, amt, live) { KITAC.hat(ac, out, when, amt, live, 0.7); },
    hat(ac, out, when, amt, live, dur) {
      metal(ac, filt(ac, 'bandpass', 11000, 0.6, filt(ac, 'highpass', 7500, 0.7, env(ac, out, when, 0.35 * amt, dur))), when, dur + 0.05, live);
      noiseSrc(ac, when, dur + 0.05, live).connect(filt(ac, 'highpass', 9000, 0.7, env(ac, out, when, 0.22 * amt, dur)));
    },
    tom(ac, out, when, amt, live) {
      tone(ac, env(ac, out, when, 0.75 * amt, 0.55), 'triangle', 132, 104, 0.3, when, 0.6, live);
      noiseSrc(ac, when, 0.05, live).connect(filt(ac, 'lowpass', 2000, 0.7, env(ac, out, when, 0.2 * amt, 0.04)));
    },
    rim(ac, out, when, amt, live) {
      const bp = filt(ac, 'bandpass', 1500, 2, env(ac, out, when, 0.55 * amt, 0.045));
      tone(ac, bp, 'triangle', 1900, 1900, 0, when, 0.06, live);
      tone(ac, bp, 'sine', 520, 520, 0, when, 0.06, live);
    },
    crash(ac, out, when, amt, live) {
      noiseSrc(ac, when, 2.4, live).connect(filt(ac, 'highpass', 4000, 0.7, env(ac, out, when, 0.34 * amt, 2.2, 0.003)));
      metal(ac, filt(ac, 'highpass', 5000, 0.7, env(ac, out, when, 0.2 * amt, 1.8, 0.003)), when, 1.9, live);
    },
  };

  /* ---------- WAV ---------- */
  /* A recording (audio clip): plays dur seconds of buffer from offset seconds, at when, with tiny fades so a cut
     never clicks. A start in the past (catching up with a clip already under way) begins now, further in. */
  function audioClip(ac, out, buffer, when, offset, dur, gain, live) {
    const now = ac.currentTime;
    if (when < now) { const late = now - when; offset += late; dur -= late; when = now; }
    offset = Math.max(0, offset);
    dur = Math.min(dur, buffer.duration - offset);
    if (dur <= 0.005) return null;
    const src = ac.createBufferSource(), g = ac.createGain();
    src.buffer = buffer;
    const lvl = gain == null ? 1 : gain, f = Math.min(0.004, dur / 4);
    g.gain.setValueAtTime(0, when);
    g.gain.linearRampToValueAtTime(lvl, when + f);
    g.gain.setValueAtTime(lvl, when + dur - f);
    g.gain.linearRampToValueAtTime(0, when + dur);
    src.connect(g); g.connect(out);
    src.start(when, offset, dur);
    if (live) { live.add(src); src.onended = () => live.delete(src); }
    return src;
  }

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

  return { LFO_RATES, LFO_TARGETS, INSTRUMENTS, DRUMS, KITS, PARAMS, SHAPE, attackTime, releaseTime, glideTime, trackParam, filterFreqs, createMixer, melodyNote, voiceStart, drumHit, audioClip, encodeWav, midiToHz };
})();
