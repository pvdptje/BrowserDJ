/* BrowserDJ app: state, undo, transport (look-ahead scheduler), hum capture, export, and UI wiring. */
(() => {
  'use strict';
  const E = HumEngine, PJ = BDJ.Project, SND = BDJ.Sound;
  const $ = (id) => document.getElementById(id);
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const fmtTime = (s) => Math.floor(s / 60) + ':' + String(Math.floor(s % 60)).padStart(2, '0');
  const STORE = 'browserdj.project.v1';

  /* ---------- state ---------- */
  let P = null;                 // the project (plain JSON)
  let take = null;              // the last hum: {frames, raw, track, tuning, audio, anchor, aligned, shift, bpm}
  const samples = new Map();    // drum row id -> {buffer, name}
  const H = new PJ.History();
  let cursor = 0;               // where playback starts, in beats
  let restored = false;

  try {
    const saved = localStorage.getItem(STORE);
    if (saved) { P = PJ.normalize(JSON.parse(saved)); restored = true; }
  } catch (err) { /* storage unavailable or corrupt */ }
  if (!P) P = PJ.example();
  for (const r of P.drums.rows) delete r.sampleName; // sample audio is not stored, so start from the built-in kit

  const takeLive = () => !!take && P.melody.fromTake;

  /* ---------- status ---------- */
  function say(text, kind) {
    const el = $('status');
    el.textContent = text;
    el.className = kind === 'warn' ? 'warn' : '';
  }

  /* ---------- undo / change tracking ---------- */
  const snap = () => PJ.serialize(P);
  const begin = () => snap();
  function end(before) {
    if (before !== snap()) { H.push(before); updateUndo(); }
  }
  function commit(fn) { const b = begin(); fn(); end(b); changed('all'); }
  function updateUndo() {
    $('undoBtn').disabled = !H.undo.length;
    $('redoBtn').disabled = !H.redo.length;
  }
  function restore(s) {
    P = JSON.parse(s);
    roll.pruneSel();
    updateUndo();
    changed('all');
  }
  function undo() { const s = H.back(snap()); if (s) { restore(s); say('Undone.'); } }
  function redo() { const s = H.forward(snap()); if (s) { restore(s); say('Redone.'); } }

  let saveTimer = 0;
  function autosave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => { try { localStorage.setItem(STORE, snap()); } catch (err) { /* full or blocked */ } }, 400);
  }

  /* kind: 'live' (mid-drag), 'notes' (a finished melody edit), 'drums', 'all' */
  function changed(kind) {
    if (kind === 'live') { return; }
    if (kind === 'notes') {
      P.melody.fromTake = false;
      const fit = Math.ceil(PJ.melodyEnd(P) / 4 - 1e-6);
      if (fit > P.bars) P.bars = fit;
    }
    if (kind === 'all') { syncControls(); rack.render(); }
    if (kind === 'drums') rack.render();
    refreshInfo();
    roll.draw();
    autosave();
  }

  /* ---------- take -> notes ---------- */
  function rederive() {
    if (!take) return;
    const d = PJ.deriveFromTake(P, take);
    P.melody.notes = d.notes;
    P.nextId = d.notes.length + 1;
    P.melody.fromTake = true;
    take.shift = d.shift;
    take.bpm = P.bpm;
    P.bars = Math.max(1, Math.ceil(PJ.melodyEnd(P) / 4 - 1e-6));
    roll.sel.clear();
  }

  function ingest(F, buf, anchor) {
    const seg = E.segment(F, P.capture.detail);
    if (!seg.notes.length) {
      say('No notes found. Hum louder or closer to the microphone, then record again.', 'warn');
      return false;
    }
    const aligned = anchor != null;
    commit(() => {
      take = { frames: F, raw: seg.notes, track: seg.track, tuning: seg.tuning, audio: buf, anchor: aligned ? anchor : null, aligned, shift: 0, bpm: P.bpm };
      const key = E.detectKey(seg.notes, P.capture.fixTuning ? seg.tuning : 0);
      P.root = key.root; P.scale = key.scale;
      if (!aligned) P.bpm = E.guessTempo(seg.notes).bpm;
      P.melody.takeOctave = 0;
      rederive();
    });
    cursor = 0;
    roll.fit();
    const n = P.melody.notes.length;
    say('Found ' + n + (n === 1 ? ' note' : ' notes') + '. ' + (aligned
      ? 'They sit where you sang them against the beat. The key is my best guess.'
      : 'Key and tempo are my best guess, change them above if they sound off.') + ' Edit anything in the piano roll.');
    return true;
  }

  /* ---------- audio context ---------- */
  let actx = null;
  function audio() {
    if (!actx) actx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'interactive' });
    if (actx.state === 'suspended') actx.resume().catch(() => {});
    return actx;
  }

  let previewBus = null;
  function previewOut(ac) {
    if (!previewBus) { previewBus = ac.createGain(); previewBus.gain.value = 0.9; previewBus.connect(ac.destination); }
    return previewBus;
  }
  function preview(pitch) {
    if (T.on) return;
    try {
      const ac = audio();
      SND.melodyNote(ac, previewOut(ac), { pitch: clamp(pitch, 0, 127), vel: 100 }, ac.currentTime + 0.01, 0.18, P.melody.instrument, null);
    } catch (err) { /* sound is optional */ }
  }
  function previewDrum(id, vel) {
    try {
      const ac = audio();
      const row = P.drums.rows.find((r) => r.id === id);
      const s = samples.get(id);
      SND.drumHit(ac, previewOut(ac), id, ac.currentTime + 0.01, vel || 110, s && s.buffer, null, row ? row.vol : 0.8);
    } catch (err) { /* sound is optional */ }
  }

  /* ---------- scheduling (shared by live playback and WAV rendering) ---------- */
  const EPS = 1e-7;
  function clickAt(ac, out, when, accent, live) {
    const o = ac.createOscillator(), g = ac.createGain();
    o.frequency.value = accent ? 1760 : 1175;
    g.gain.setValueAtTime(0.0001, when);
    g.gain.exponentialRampToValueAtTime(accent ? 0.45 : 0.28, when + 0.002);
    g.gain.exponentialRampToValueAtTime(0.0001, when + 0.05);
    o.connect(g); g.connect(out);
    o.start(when); o.stop(when + 0.06);
    if (live) { live.add(o); o.onended = () => live.delete(o); }
  }

  /* Schedules everything whose start is in [lo, hi) of the song (local beats), offset by `off` beats. */
  function scheduleWindow(ac, M, lo, hi, off, timeOf, opt = {}) {
    const bps = 60 / opt.bpm;
    if (!opt.noMelody && !P.melody.mute) {
      for (const n of P.melody.notes) {
        if (n.start >= lo - EPS && n.start < hi - EPS) SND.melodyNote(ac, M.melody, n, timeOf(n.start + off), n.len * bps, P.melody.instrument, M.live);
      }
    }
    const D = P.drums, N = D.bars * PJ.STEPS_PER_BAR;
    const drumsOn = !D.mute && D.rows.some((r) => r.steps.some((v) => v));
    if (drumsOn) {
      const anySolo = D.rows.some((r) => r.solo);
      for (let s = Math.ceil(lo * 4 - EPS); s < hi * 4 - EPS; s++) {
        const local = ((s % N) + N) % N;
        const when = timeOf(s / 4 + off + (s % 2 ? D.swing * 0.125 : 0));
        for (const row of D.rows) {
          const v = row.steps[local];
          if (!v || row.mute || (anySolo && !row.solo)) continue;
          const smp = samples.get(row.id);
          SND.drumHit(ac, M.drums, row.id, when, v, smp && smp.buffer, M.live, row.vol);
        }
      }
    }
    for (let b = Math.ceil(lo - EPS); b < hi - EPS; b++) {
      const countIn = b + off < 0;
      if (P.click || countIn || (opt.rec && !drumsOn)) clickAt(ac, M.master, timeOf(b + off), b % 4 === 0, M.live);
    }
  }

  /* ---------- transport ---------- */
  const T = { on: false };
  let TK = null; // playing back the raw recording

  const spb = () => 60 / T.bpm;
  const beatAbs = () => T.beat0 + (actx.currentTime - T.t0) / spb();
  const timeOf = (b) => T.t0 + (b - T.beat0) * spb();

  function play(from = cursor, opts = {}) {
    stopAll();
    let ac;
    try { ac = audio(); } catch (err) { say('This browser cannot play sound here.', 'warn'); return false; }
    Object.assign(T, {
      on: true, rec: !!opts.rec, bpm: P.bpm, L: PJ.songBeats(P),
      t0: ac.currentTime + 0.08, beat0: from, sched: from,
      M: SND.createMixer(ac, { bpm: P.bpm, echo: P.melody.echo, melodyVol: P.melody.volume, drumVol: P.drums.volume }),
    });
    T.timer = setInterval(pump, 25);
    pump();
    frame();
    $('playBtn').classList.add('on');
    $('playLabel').textContent = 'Stop';
    return true;
  }

  function pump() {
    if (!T.on) return;
    const now = actx.currentTime, L = PJ.songBeats(P);
    if (P.bpm !== T.bpm || L !== T.L) {
      // tempo or song length changed while playing: re-anchor at the current position
      let b = beatAbs();
      const ahead = T.sched - b;
      if (b >= 0 && (P.loop || T.rec)) b = ((b % T.L) + T.L) % T.L;
      T.beat0 = b; T.t0 = now; T.sched = b + ahead * (T.bpm / P.bpm);
      T.bpm = P.bpm; T.L = L;
      T.M.setBpm(P.bpm);
    }
    const endB = T.beat0 + (now + 0.15 - T.t0) / spb();
    if (endB > T.sched) {
      const a = T.sched, b = endB;
      if (P.loop || T.rec) {
        for (let k = Math.floor(a / L); k * L < b; k++) {
          const lo = Math.max(a, k * L), hi = Math.min(b, (k + 1) * L);
          if (hi > lo) scheduleWindow(actx, T.M, lo - k * L, hi - k * L, k * L, timeOf, { bpm: T.bpm, noMelody: T.rec, rec: T.rec });
        }
      } else if (a < L) {
        scheduleWindow(actx, T.M, a, Math.min(b, L), 0, timeOf, { bpm: T.bpm });
      }
      T.sched = endB;
    }
    if (!P.loop && !T.rec && beatAbs() > L + 0.5) stopAll();
  }

  /* Song position for display: wrapped into the loop, negative during a count-in. */
  function songPos() {
    if (!T.on) return null;
    const b = beatAbs();
    if (b < 0) return b;
    return P.loop || T.rec ? b % T.L : b;
  }

  function frame() {
    cancelAnimationFrame(T.raf);
    const tickUI = () => {
      if (!T.on && !TK && !R) return;
      const b = hostPlayhead();
      if (b != null) {
        if (b >= 0) roll.follow(b);
        showPos(b);
        if (T.on && b >= 0) {
          const N = P.drums.bars * PJ.STEPS_PER_BAR;
          rack.setPlayhead(Math.floor(b * 4 + 1e-6) % N);
        }
      }
      roll.draw();
      T.raf = requestAnimationFrame(tickUI);
    };
    T.raf = requestAnimationFrame(tickUI);
  }

  function showPos(b) {
    if (b == null) b = cursor;
    if (b < 0) { $('pos').textContent = 'count ' + Math.ceil(-b); return; }
    const bar = Math.floor(b / 4) + 1, beat = Math.floor(b % 4) + 1, six = Math.floor((b % 1) * 4 + 1e-6) + 1;
    $('pos').textContent = bar + '.' + beat + '.' + six;
  }

  function stopAll() {
    if (T.on) {
      T.on = false;
      clearInterval(T.timer);
      T.M.stop();
    }
    if (TK) {
      try { TK.src.onended = null; TK.src.stop(); } catch (err) { /* already stopped */ }
      TK = null;
      $('playTakeBtn').textContent = 'Play my recording';
    }
    if (!R) cancelAnimationFrame(T.raf);
    $('playBtn').classList.remove('on');
    $('playLabel').textContent = 'Play';
    rack.setPlayhead(-1);
    showPos(null);
    roll.draw();
  }

  function togglePlay() {
    if (R) { stopRec(); return; }
    if (T.on) stopAll(); else play(cursor);
  }

  function playTake() {
    if (!take || !take.audio) return;
    if (TK) { stopAll(); return; }
    stopAll();
    const ac = audio();
    const src = ac.createBufferSource();
    src.buffer = take.audio;
    src.connect(ac.destination);
    const t0 = ac.currentTime + 0.05;
    src.start(t0);
    TK = { src, t0 };
    src.onended = () => { TK = null; $('playTakeBtn').textContent = 'Play my recording'; roll.draw(); };
    $('playTakeBtn').textContent = 'Stop';
    frame();
  }

  function hostPlayhead() {
    if (R) return R.liveBeat == null ? null : R.liveBeat;
    if (T.on) return songPos();
    if (TK && take) return (actx.currentTime - TK.t0 - take.shift) * take.bpm / 60;
    return null;
  }

  /* ---------- trace (what the microphone heard) ---------- */
  let traceCache = null;
  function hostTrace() {
    if (R) return liveTrace();
    if (!take || !take.track) return null;
    const tun = P.capture.fixTuning ? take.tuning : 0, oct = 12 * P.melody.takeOctave;
    const key = take.shift + '|' + take.bpm + '|' + tun + '|' + oct + '|' + take.track.length;
    if (traceCache && traceCache.key === key && traceCache.take === take) return traceCache;
    const F = take.frames, n = take.track.length, k = take.bpm / 60;
    const beats = new Float32Array(n), pitch = new Float32Array(n);
    for (let i = 0; i < n; i++) { beats[i] = (F.t0 + i * F.dt - take.shift) * k; pitch[i] = take.track[i] - tun + oct; }
    traceCache = { key, take, beats, pitch };
    return traceCache;
  }
  function liveTrace() {
    const an = R.an, n = an.midi.length, k = P.bpm / 60;
    const beats = new Float32Array(n), pitch = new Float32Array(n);
    const base = R.anchor != null ? R.anchor : 0;
    for (let i = 0; i < n; i++) {
      beats[i] = (an.t0 + i * an.dt - base) * k;
      pitch[i] = an.conf[i] < 0.25 && an.rms[i] > 0.006 ? an.midi[i] : NaN;
    }
    return { beats, pitch };
  }

  /* ---------- recording ---------- */
  let R = null;
  let workletReady = null;
  function ensureWorklet(ac) {
    if (!ac.audioWorklet) return Promise.reject(new Error('no worklet'));
    if (!workletReady) {
      const code = 'class HumCap extends AudioWorkletProcessor{constructor(){super();this.b=new Float32Array(2048);this.n=0;}' +
        'process(i){const c=i[0]&&i[0][0];if(c){for(let k=0;k<c.length;k++){this.b[this.n++]=c[k];if(this.n===2048){this.port.postMessage(this.b.slice(0));this.n=0;}}}return true;}}' +
        'registerProcessor("hum-cap",HumCap);';
      const url = URL.createObjectURL(new Blob([code], { type: 'application/javascript' }));
      workletReady = ac.audioWorklet.addModule(url);
      workletReady.catch(() => { workletReady = null; });
    }
    return workletReady;
  }

  function micHelp(err) {
    const name = err && err.name;
    if (name === 'NotAllowedError' || name === 'SecurityError') {
      return 'The microphone is blocked. Allow it in the address bar and press Record again. If no prompt appears, serve this folder from a local web server (for example "npx serve") and open it through http://localhost, or load a recording instead.';
    }
    if (name === 'NotFoundError') return 'No microphone found. Plug one in, or load a recording instead.';
    return 'Could not start the microphone (' + (name || 'unknown error') + '). Load a recording instead.';
  }

  let starting = false;
  async function startRec() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      say('This page cannot reach a microphone here. Open it in Chrome, Edge or Firefox on your computer, or load a recording instead.', 'warn');
      return;
    }
    if (starting) return;
    starting = true;
    stopAll();
    const ac = audio();
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 } });
    } catch (err) { say(micHelp(err), 'warn'); return; } finally { starting = false; }
    const an = new E.Analyzer(ac.sampleRate), chunks = [];
    const onChunk = (c) => { chunks.push(c); an.push(c); };
    const src = ac.createMediaStreamSource(stream);
    const mute = ac.createGain();
    mute.gain.value = 0;
    mute.connect(ac.destination);
    let node;
    try {
      await ensureWorklet(ac);
      node = new AudioWorkletNode(ac, 'hum-cap', { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1, channelCountMode: 'explicit' });
      node.port.onmessage = (e) => onChunk(e.data);
    } catch (err) {
      node = ac.createScriptProcessor(2048, 1, 1);
      node.onaudioprocess = (e) => onChunk(new Float32Array(e.inputBuffer.getChannelData(0)));
    }
    src.connect(node);
    node.connect(mute);
    const ctxStart = ac.currentTime;
    R = { stream, src, node, mute, an, chunks, started: performance.now(), timer: setInterval(recTick, 50), anchor: null, liveBeat: null };
    if (P.capture.playBeat) {
      // one bar of count-in, then the song; beat 0 lands this many seconds into the recording
      play(-4, { rec: true });
      let inLat = 0.01;
      try { const st = stream.getAudioTracks()[0].getSettings(); if (st && isFinite(st.latency)) inLat = st.latency; } catch (err) { /* unknown */ }
      R.anchor = T.t0 + 4 * spb() - ctxStart + (ac.outputLatency || 0) + (ac.baseLatency || 0) + inLat;
      say('Count-in: one bar of clicks, then hum along with the beat. Press Stop (or Space) when you are done.');
    } else {
      say('Listening. Hum your tune, then press Stop.');
      frame();
    }
    $('recBtn').classList.add('on');
    $('recLabel').textContent = 'Stop';
    for (const id of ['midiBtn', 'wavBtn', 'fileBtn', 'playTakeBtn']) $(id).disabled = true;
  }

  function recTick() {
    if (!R) return;
    R.an.process(80);
    const n = R.an.midi.length, el = (performance.now() - R.started) / 1000;
    $('recTime').textContent = fmtTime(el);
    if (n) {
      const rms = R.an.rms[n - 1], heard = R.an.conf[n - 1] < 0.25 && rms > 0.006;
      $('level').style.width = clamp(Math.sqrt(rms) * 160, 0, 100) + '%';
      $('liveNote').textContent = heard ? E.noteName(Math.round(R.an.midi[n - 1])) : '--';
      $('liveNote').classList.toggle('idle', !heard);
    }
    R.liveBeat = T.on && T.rec ? beatAbs() : (n * R.an.dt) * P.bpm / 60;
    if (el > 180) stopRec();
  }

  function stopRec() {
    const r = R;
    if (!r) return;
    clearInterval(r.timer);
    r.stream.getTracks().forEach((t) => t.stop());
    try { r.src.disconnect(); r.node.disconnect(); r.mute.disconnect(); } catch (err) { /* gone */ }
    if (r.node.port) r.node.port.onmessage = null; else r.node.onaudioprocess = null;
    R = null;
    stopAll();
    $('recBtn').classList.remove('on');
    $('recLabel').textContent = 'Record';
    $('level').style.width = '0';
    $('liveNote').textContent = '--';
    $('liveNote').classList.add('idle');
    for (const id of ['midiBtn', 'wavBtn', 'fileBtn']) $(id).disabled = false;
    $('roll').focus({ preventScroll: true }); // so Space plays instead of pressing Record again
    r.an.process();
    let len = 0;
    for (const c of r.chunks) len += c.length;
    if (len < actx.sampleRate * 0.4) {
      say('That was too short to find a tune. Press Record and hum for a few seconds.', 'warn');
      refreshInfo(); roll.draw();
      return;
    }
    const buf = actx.createBuffer(1, len, actx.sampleRate), ch = buf.getChannelData(0);
    let o = 0;
    for (const c of r.chunks) { ch.set(c, o); o += c.length; }
    ingest(r.an.frames(), buf, r.anchor);
    refreshInfo(); roll.draw();
  }

  /* ---------- loading a recording ---------- */
  async function loadFile(file) {
    if (!file || R) return;
    if (/\.(json|bdj)$/i.test(file.name) || file.type === 'application/json') { openProject(file); return; }
    stopAll();
    say('Reading ' + file.name + '…');
    let buf;
    try {
      buf = await audio().decodeAudioData(await file.arrayBuffer());
    } catch (err) {
      say('Could not read "' + file.name + '" as audio. Try a WAV, MP3, M4A or OGG file.', 'warn');
      return;
    }
    const n = Math.min(buf.length, Math.round(buf.sampleRate * 300));
    const mono = new Float32Array(n);
    for (let c = 0; c < buf.numberOfChannels; c++) {
      const d = buf.getChannelData(c);
      for (let i = 0; i < n; i++) mono[i] += d[i] / buf.numberOfChannels;
    }
    const an = new E.Analyzer(buf.sampleRate), CH = 16384;
    for (let i = 0, k = 0; i < n; i += CH, k++) {
      an.push(mono.subarray(i, i + CH));
      an.process();
      if (k % 6 === 5) {
        say('Listening to ' + file.name + '… ' + Math.round((i / n) * 100) + '%');
        await new Promise((r) => setTimeout(r));
      }
    }
    ingest(an.frames(), buf, null);
  }

  /* ---------- drum samples ---------- */
  let sampleTarget = null;
  async function loadSample(id, file) {
    if (!file) return;
    if (!/^audio\//.test(file.type) && !/\.(wav|mp3|ogg|flac|m4a|aif|aiff)$/i.test(file.name)) {
      say('"' + file.name + '" does not look like an audio file.', 'warn');
      return;
    }
    try {
      const buffer = await audio().decodeAudioData(await file.arrayBuffer());
      samples.set(id, { buffer, name: file.name });
      commit(() => { P.drums.rows.find((r) => r.id === id).sampleName = file.name; });
      previewDrum(id, 110);
      say('The ' + SND.DRUMS.find((d) => d.id === id).name.toLowerCase() + ' row now plays ' + file.name + '. Your own sounds are not saved with the project yet, so load them again next time.');
    } catch (err) {
      say('Could not read "' + file.name + '" as audio.', 'warn');
    }
  }
  function clearSample(id) {
    samples.delete(id);
    commit(() => { delete P.drums.rows.find((r) => r.id === id).sampleName; });
  }

  /* ---------- project files and export ---------- */
  const slug = () => (P.name || 'song').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'song';
  function downloadBlob(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }

  function exportMidi() {
    const tracks = PJ.midiTracks(P);
    if (!tracks[0].notes.length && tracks.length < 2) { say('There is nothing to export yet. Add some notes or drums first.', 'warn'); return; }
    downloadBlob(new Blob([E.writeMidiTracks(tracks, P.bpm)], { type: 'audio/midi' }), slug() + '.mid');
    say('Saved ' + slug() + '.mid with the melody on channel 1' + (tracks.length > 1 ? ' and the drums on channel 10' : '') + '. Set your music program to ' + P.bpm + ' BPM.');
  }

  async function exportWav() {
    stopAll();
    const sr = 44100, L = PJ.songBeats(P), secs = L * 60 / P.bpm;
    const Ctx = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    if (!Ctx) { say('This browser cannot render audio files.', 'warn'); return; }
    say('Rendering…');
    $('wavBtn').disabled = true;
    try {
      const oac = new Ctx(2, Math.ceil((secs + 2.5) * sr), sr);
      const M = SND.createMixer(oac, { bpm: P.bpm, echo: P.melody.echo, melodyVol: P.melody.volume, drumVol: P.drums.volume });
      M.live = null;
      const savedClick = P.click;
      P.click = false;
      scheduleWindow(oac, M, 0, L, 0, (b) => 0.02 + b * 60 / P.bpm, { bpm: P.bpm });
      P.click = savedClick;
      const buf = await oac.startRendering();
      downloadBlob(SND.encodeWav(buf), slug() + '.wav');
      say('Saved ' + slug() + '.wav (' + secs.toFixed(1) + ' s at ' + P.bpm + ' BPM).');
    } catch (err) {
      say('Rendering failed: ' + (err && err.message ? err.message : err), 'warn');
    } finally {
      $('wavBtn').disabled = false;
    }
  }

  function saveProject() {
    const name = prompt('Name this project', P.name === 'Untitled' || P.name === 'Example' ? '' : P.name);
    if (name === null) return;
    if (name.trim()) commit(() => { P.name = name.trim().slice(0, 80); });
    downloadBlob(new Blob([JSON.stringify(P, null, 1)], { type: 'application/json' }), slug() + '.browserdj.json');
    say('Saved ' + slug() + '.browserdj.json. Open it here any time to keep working.');
  }

  async function openProject(file) {
    try {
      const obj = JSON.parse(await file.text());
      stopAll();
      commit(() => { P = PJ.normalize(obj); take = null; });
      for (const r of P.drums.rows) if (r.sampleName && !samples.has(r.id)) delete r.sampleName;
      cursor = 0;
      roll.sel.clear();
      roll.fit();
      say('Opened ' + file.name + '.');
    } catch (err) {
      say('Could not open "' + file.name + '" as a BrowserDJ project.', 'warn');
    }
  }

  /* ---------- UI sync ---------- */
  const keyLabel = () => (P.scale === 'chromatic' ? 'no key' : E.NOTE_NAMES[P.root] + ' ' + E.SCALES[P.scale].name.toLowerCase());

  function refreshInfo() {
    const n = P.melody.notes.length, bars = PJ.songBeats(P) / 4;
    $('summary').textContent = n + (n === 1 ? ' note' : ' notes') + ' · ' + bars + (bars === 1 ? ' bar' : ' bars') + ' · ' + keyLabel() + ' · ' + P.bpm + ' BPM';
    const chip = $('takeChip');
    chip.hidden = !take;
    chip.textContent = takeLive() ? 'From your take' : 'Edited';
    chip.classList.toggle('edited', !takeLive());
    chip.title = takeLive() ? 'Key, snap, tempo and note detail rebuild these notes from your recording.' : 'You edited the notes, so the settings above no longer rebuild them. "Rebuild notes" starts over from the recording.';
    $('takeRow').classList.toggle('off', !take);
    $('guessTempo').disabled = !take || take.aligned;
    $('playTakeBtn').disabled = !take || !take.audio || !!R;
    const cents = take ? Math.round(take.tuning * 100) : 0;
    $('tuningInfo').textContent = take && Math.abs(cents) >= 5 ? '(you were ' + Math.abs(cents) + ' cents ' + (cents > 0 ? 'sharp' : 'flat') + ')' : '';
    $('bars').value = P.bars;
    $('bars').min = Math.max(1, Math.ceil(PJ.melodyEnd(P) / 4 - 1e-6));
  }

  function syncControls() {
    $('bpm').value = P.bpm;
    $('root').value = P.root;
    $('scale').value = P.scale;
    $('snap').value = P.snap;
    $('loop').checked = P.loop;
    $('click').checked = P.click;
    $('instrument').value = P.melody.instrument;
    $('echo').checked = P.melody.echo;
    $('melVol').value = Math.round(P.melody.volume * 100);
    setTog($('melMute'), P.melody.mute);
    $('drumBars').value = P.drums.bars;
    $('swing').value = Math.round(P.drums.swing * 100);
    $('drumVol').value = Math.round(P.drums.volume * 100);
    setTog($('drumMute'), P.drums.mute);
    $('detail').value = Math.round(P.capture.detail * 100);
    $('fixTuning').checked = P.capture.fixTuning;
    $('playBeat').checked = P.capture.playBeat;
    if (T.on && T.M) {
      T.M.melody.gain.setTargetAtTime(P.melody.volume, actx.currentTime, 0.02);
      T.M.drums.gain.setTargetAtTime(P.drums.volume, actx.currentTime, 0.02);
      T.M.setEcho(P.melody.echo);
    }
  }
  function setTog(el, on) { el.classList.toggle('on', on); el.setAttribute('aria-pressed', String(on)); }

  /* ---------- components ---------- */
  const roll = new BDJ.PianoRoll($('roll'), {
    project: () => P,
    begin, end, changed, preview,
    playhead: hostPlayhead,
    cursor: () => cursor,
    setCursor: (b) => { cursor = Math.max(0, b); showPos(null); roll.draw(); if (T.on && !T.rec) play(cursor); },
    trace: hostTrace,
  });

  const rack = new BDJ.DrumRack($('rack'), {
    project: () => P,
    begin, end, changed, previewDrum,
    loadSample, clearSample,
    pickSample: (id) => { sampleTarget = id; $('sampleInput').click(); },
    sampleName: (id) => (samples.get(id) || {}).name,
  });

  // handle for debugging and tests (and, later, for an AI helper to read and write the project)
  window.BrowserDJ = { get project() { return P; }, get take() { return take; }, roll, rack, transport: T };

  /* ---------- wiring ---------- */
  E.NOTE_NAMES.forEach((nm, i) => $('root').add(new Option(nm, i)));
  for (const k of ['major', 'minor', 'minorPent', 'majorPent', 'dorian', 'phrygian', 'harmonicMinor', 'chromatic']) $('scale').add(new Option(E.SCALES[k].name, k));
  for (const i of SND.INSTRUMENTS) $('instrument').add(new Option(i.name, i.id));
  for (const [k, pre] of Object.entries(PJ.PRESETS)) if (k !== 'empty') $('preset').add(new Option(pre.name, k));

  const on = (id, ev, fn) => $(id).addEventListener(ev, fn);

  // transport
  on('playBtn', 'click', togglePlay);
  on('stopBtn', 'click', () => { if (R) stopRec(); else { stopAll(); cursor = 0; showPos(null); roll.draw(); } });
  on('loop', 'change', () => { P.loop = $('loop').checked; autosave(); });
  on('click', 'change', () => { P.click = $('click').checked; autosave(); });
  on('bpm', 'change', () => {
    const v = clamp(Math.round(+$('bpm').value) || 120, 40, 240);
    commit(() => { P.bpm = v; if (takeLive() && !take.aligned) rederive(); });
  });
  let taps = [];
  on('tapBtn', 'click', () => {
    const t = performance.now();
    if (taps.length && t - taps[taps.length - 1] > 2000) taps = [];
    taps.push(t);
    if (taps.length > 5) taps.shift();
    if (taps.length >= 3) {
      const d = (taps[taps.length - 1] - taps[0]) / (taps.length - 1);
      const v = clamp(Math.round(60000 / d), 40, 240);
      commit(() => { P.bpm = v; });
      say('Tempo set to ' + v + ' BPM from your taps.');
    } else say('Keep tapping along to the beat…');
  });
  on('root', 'change', () => commit(() => { P.root = +$('root').value; if (takeLive()) rederive(); }));
  on('scale', 'change', () => commit(() => { P.scale = $('scale').value; if (takeLive()) rederive(); }));
  on('detectKey', 'click', () => {
    if (!P.melody.notes.length && !take) { say('Add some notes first, then I can guess the key.', 'warn'); return; }
    commit(() => { const k = PJ.detectKey(P, take); P.root = k.root; P.scale = k.scale; if (takeLive()) rederive(); });
    say('This sounds like ' + keyLabel() + '.');
  });
  on('undoBtn', 'click', undo);
  on('redoBtn', 'click', redo);
  on('newBtn', 'click', () => {
    stopAll();
    commit(() => { P = PJ.blank(); take = null; });
    samples.clear(); cursor = 0; roll.sel.clear(); roll.fit(); rack.render();
    say('A fresh project. Hum something, draw notes, or load a drum pattern. Undo brings the old one back.');
  });
  on('openBtn', 'click', () => $('projectInput').click());
  on('projectInput', 'change', (e) => { if (e.target.files[0]) openProject(e.target.files[0]); e.target.value = ''; });
  on('saveBtn', 'click', saveProject);
  on('midiBtn', 'click', exportMidi);
  on('wavBtn', 'click', exportWav);

  // capture
  on('recBtn', 'click', () => (R ? stopRec() : startRec()));
  on('fileBtn', 'click', () => $('fileInput').click());
  on('fileInput', 'change', (e) => { loadFile(e.target.files[0]); e.target.value = ''; });
  on('playBeat', 'change', () => { P.capture.playBeat = $('playBeat').checked; autosave(); });
  let detailBefore = null;
  on('detail', 'input', () => {
    if (!take) return;
    if (detailBefore == null) detailBefore = begin();
    P.capture.detail = +$('detail').value / 100;
    const seg = E.segment(take.frames, P.capture.detail);
    take.raw = seg.notes; take.track = seg.track; take.tuning = seg.tuning;
    rederive();
    refreshInfo(); roll.draw();
  });
  on('detail', 'change', () => {
    if (detailBefore == null) return;
    end(detailBefore); detailBefore = null; changed('all');
  });
  on('fixTuning', 'change', () => commit(() => { P.capture.fixTuning = $('fixTuning').checked; if (take) rederive(); }));
  on('guessTempo', 'click', () => {
    if (!take) return;
    commit(() => { P.bpm = E.guessTempo(take.raw).bpm; if (takeLive()) rederive(); });
    say('Tempo guessed at ' + P.bpm + ' BPM.');
  });
  on('rereadBtn', 'click', () => { commit(rederive); roll.fit(); say('Notes rebuilt from your recording. Undo brings your edits back.'); });
  on('playTakeBtn', 'click', playTake);

  // melody
  on('instrument', 'change', () => { commit(() => { P.melody.instrument = $('instrument').value; }); preview(60); });
  on('echo', 'change', () => commit(() => { P.melody.echo = $('echo').checked; }));
  let volBefore = null;
  const liveVol = (id, set) => {
    on(id, 'input', () => { if (volBefore == null) volBefore = begin(); set(+$(id).value / 100); syncControls(); });
    on(id, 'change', () => { if (volBefore != null) { end(volBefore); volBefore = null; autosave(); } });
  };
  liveVol('melVol', (v) => { P.melody.volume = v; });
  liveVol('drumVol', (v) => { P.drums.volume = v; });
  liveVol('swing', (v) => { P.drums.swing = v; });
  on('melMute', 'click', () => commit(() => { P.melody.mute = !P.melody.mute; }));
  on('snap', 'change', () => commit(() => { P.snap = +$('snap').value; if (takeLive()) rederive(); }));
  on('bars', 'change', () => {
    const min = Math.max(1, Math.ceil(PJ.melodyEnd(P) / 4 - 1e-6));
    const v = clamp(Math.round(+$('bars').value) || min, 1, 128);
    if (v < min) say('Your notes reach bar ' + min + '. Delete the later notes to make the song shorter.', 'warn');
    commit(() => { P.bars = Math.max(v, min); });
  });
  const octave = (d) => {
    if (takeLive() && !roll.sel.size) commit(() => { P.melody.takeOctave = clamp(P.melody.takeOctave + d, -4, 4); rederive(); });
    else roll.transpose(12 * d);
  };
  on('octUp', 'click', () => octave(1));
  on('octDown', 'click', () => octave(-1));
  on('quantBtn', 'click', () => { if (!roll.quantize()) say('Pick a Snap value first, then Quantize lines the notes up to it.', 'warn'); });
  on('keyBtn', 'click', () => { if (P.scale === 'chromatic') say('Pick a key first. Chromatic has no wrong notes to fix.', 'warn'); else roll.fitToKey(); });
  on('legatoBtn', 'click', () => roll.legato());
  on('clearMelBtn', 'click', () => {
    if (!P.melody.notes.length) return;
    commit(() => { P.melody.notes = []; P.melody.fromTake = false; });
    roll.sel.clear();
    say('Melody cleared. Undo brings it back.');
  });
  on('fitBtn', 'click', () => roll.fit());

  // drums
  on('preset', 'change', () => {
    const k = $('preset').value;
    if (!k) return;
    commit(() => PJ.applyPreset(P, k));
    $('preset').value = '';
    const pre = PJ.PRESETS[k];
    say(pre.name + ' loaded.' + (pre.bpm && Math.abs(pre.bpm - P.bpm) > 12 ? ' It usually sits around ' + pre.bpm + ' BPM.' : ''));
  });
  on('drumBars', 'change', () => commit(() => PJ.setDrumBars(P, +$('drumBars').value)));
  on('drumClear', 'click', () => commit(() => PJ.applyPreset(P, 'empty')));
  on('drumMute', 'click', () => commit(() => { P.drums.mute = !P.drums.mute; }));
  on('sampleInput', 'change', (e) => { if (e.target.files[0] && sampleTarget) loadSample(sampleTarget, e.target.files[0]); e.target.value = ''; });

  // keys
  const typing = (t) => {
    const tag = (t.tagName || '').toLowerCase();
    return tag === 'textarea' || tag === 'select' || (tag === 'input' && !['checkbox', 'range', 'button'].includes(t.type));
  };
  document.addEventListener('keydown', (e) => {
    if (typing(e.target)) return;
    const ctrl = e.ctrlKey || e.metaKey;
    if (e.code === 'Space' && !ctrl) { e.preventDefault(); if (!e.repeat) togglePlay(); return; }
    if (ctrl && (e.key === 'z' || e.key === 'Z')) { e.preventDefault(); if (e.shiftKey) redo(); else undo(); return; }
    if (ctrl && (e.key === 'y' || e.key === 'Y')) { e.preventDefault(); redo(); }
  });
  document.addEventListener('keyup', (e) => { if (e.code === 'Space' && !typing(e.target)) e.preventDefault(); });

  // drag and drop: audio -> hum, project file -> open
  let dragDepth = 0;
  window.addEventListener('dragenter', (e) => { e.preventDefault(); dragDepth++; document.body.classList.add('dropping'); });
  window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; document.body.classList.remove('dropping'); } });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    dragDepth = 0;
    document.body.classList.remove('dropping');
    const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) loadFile(f);
  });

  /* ---------- start ---------- */
  syncControls();
  rack.render();
  refreshInfo();
  updateUndo();
  showPos(null);
  roll.fit();
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => roll.draw());
  say(restored
    ? 'Welcome back, your last project is loaded. Press Space to play.'
    : 'This is an example. Press Space to hear it, then press Record and hum, like "da da daa", or click in the piano roll to draw notes.');
})();
