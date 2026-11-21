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
  let take = null;              // the last hum: {frames, raw, track, tuning, audio, anchor, aligned, shift, bpm, patternId}
  const decoded = new Map();    // sample hash -> decoded AudioBuffer (the audio itself lives in BDJ.Samples)
  const H = new PJ.History();
  let patCursor = 0;            // where pattern playback starts, in beats
  let songCursor = 0;           // where song playback starts, in beats
  let restored = false;
  let lastSynth = 0;            // the synth track used most recently: where a hum goes when drums are selected

  try {
    const saved = localStorage.getItem(STORE);
    if (saved) { P = PJ.normalize(JSON.parse(saved)); restored = true; }
  } catch (err) { /* storage unavailable or corrupt */ }
  if (!P) P = PJ.example();

  const curTrack = () => PJ.selTrack(P);
  const curPat = () => PJ.selPattern(P);
  const takePattern = () => (take ? PJ.pattern(P, take.patternId) : null);
  const takeFresh = () => { const tp = takePattern(); return !!tp && tp.fromTake; };
  const cursor = () => (P.mode === 'song' ? songCursor : patCursor);
  const otherMusic = (exceptId) => P.patterns.some((x) => x.id !== exceptId && (x.notes ? x.notes.length : Object.values(x.steps).some((s) => s.some((v) => v))));

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
    ensureSamples();
  }
  function undo() { const s = H.back(snap()); if (s) { restore(s); say('Undone.'); } }
  function redo() { const s = H.forward(snap()); if (s) { restore(s); say('Redone.'); } }

  let saveTimer = 0;
  function autosave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => { try { localStorage.setItem(STORE, snap()); } catch (err) { /* full or blocked */ } }, 400);
  }

  /* kind: 'live' (mid-drag), 'notes', 'drums', 'clips', 'tracks', 'quiet', 'all' */
  function changed(kind) {
    if (kind === 'live') { playlist.draw(); return; }
    if (kind === 'notes') {
      const pat = curPat();
      pat.fromTake = false;
      const fit = Math.ceil(PJ.notesEnd(pat) / 4 - 1e-6);
      if (fit > pat.bars) pat.bars = fit;
    }
    if (kind === 'all') { syncControls(); renderEditor(); playlist.renderHeads(); mixer.render(); }
    if (curTrack().type === 'synth') lastSynth = curTrack().id;
    if (kind === 'drums') rack.render();
    if (kind === 'tracks') { playlist.renderHeads(); renderEditorHead(); rack.render(); mixer.render(); updateMixer(); }
    if (kind === 'mix') { playlist.renderHeads(); updateMixer(); }
    if (kind === 'view') { playlist.renderHeads(); playlist.draw(); autosave(); return; }
    if (kind === 'auto') { playlist.renderHeads(); mixer.render(); }
    if (kind !== 'quiet') { refreshInfo(); roll.draw(); playlist.draw(); }
    autosave();
  }

  function select(trackId, patternId) {
    finishRec();
    for (const p of [...held.keys()]) noteOff(p);
    if (trackId === P.sel.trackId && (patternId == null || patternId === P.sel.patternId)) return;
    PJ.select(P, trackId, patternId);
    playlist.remember(P.sel.trackId, P.sel.patternId);
    if (curTrack().type === 'synth') lastSynth = curTrack().id;
    roll.sel.clear();
    renderEditor();
    playlist.markSelected();
    mixer.markSelected();
    playlist.draw();
    refreshInfo();
    autosave();
  }

  /* ---------- take -> notes ---------- */
  function rederive() {
    const pat = takePattern();
    if (!take || !pat) return;
    const d = PJ.deriveFromTake(P, pat, take);
    pat.notes = d.notes;
    pat.fromTake = true;
    take.shift = d.shift;
    take.bpm = P.bpm;
    pat.bars = Math.max(1, Math.ceil(PJ.notesEnd(pat) / 4 - 1e-6));
    roll.sel.clear();
  }

  /* The synth pattern a new take goes into: the selected one, or a fresh pattern on a synth track. */
  function takeTarget() {
    if (curTrack().type === 'synth') return curPat();
    const last = PJ.track(P, lastSynth);
    let t = last && last.type === 'synth' ? last : P.tracks.find((x) => x.type === 'synth');
    if (!t) t = PJ.addTrack(P, 'synth', { name: 'Vocal idea' });
    const pat = PJ.addPattern(P, t.id, PJ.uniqueName(P, t.id, 'Take'));
    PJ.select(P, t.id, pat.id);
    return pat;
  }

  function ingest(F, buf, anchor, targetId) {
    const seg = E.segment(F, P.capture.detail);
    if (!seg.notes.length) {
      say('No notes found. Hum louder or closer to the microphone, then record again.', 'warn');
      return false;
    }
    const aligned = anchor != null;
    let kept = false;
    commit(() => {
      const pat = PJ.pattern(P, targetId) || takeTarget();
      take = { frames: F, raw: seg.notes, track: seg.track, tuning: seg.tuning, audio: buf, anchor: aligned ? anchor : null, aligned, shift: 0, bpm: P.bpm, patternId: pat.id };
      // a first idea sets key and tempo; once there is other music, the hum fits into it instead
      kept = otherMusic(pat.id);
      if (!kept) {
        const key = E.detectKey(seg.notes, P.capture.fixTuning ? seg.tuning : 0);
        P.root = key.root; P.scale = key.scale;
        if (!aligned) P.bpm = E.guessTempo(seg.notes).bpm;
      }
      pat.takeOctave = 0;
      rederive();
      PJ.select(P, pat.trackId, pat.id);
      const at = aligned ? songCursor : (P.clips.some((c) => c.patternId === pat.id) ? null : songCursor);
      if (at != null && !P.clips.some((c) => c.patternId === pat.id && c.start === at)) PJ.addClip(P, pat, at);
    });
    patCursor = 0;
    roll.fit();
    const n = curPat().notes.length;
    say('Found ' + n + (n === 1 ? ' note' : ' notes') + ' in "' + curPat().name + '". ' + (aligned
      ? 'They sit where you sang them against the beat.'
      : kept ? 'I kept your song’s key and tempo so the hum fits in.' : 'Key and tempo are my best guess, change them above if they sound off.') + ' Edit anything in the piano roll.');
    return true;
  }

  /* ---------- audio context ---------- */
  let actx = null;
  function audio() {
    if (!actx) actx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'interactive' });
    if (actx.state === 'suspended') actx.resume().catch(() => {});
    return actx;
  }

  /* A mixer that is always there for sounds you trigger by hand (previews, live keys), so they go through
     the track's own channel: drive, filter, pan and volume sound exactly like playback. */
  let liveM = null;
  function liveMixer() {
    const ac = audio();
    if (!liveM) liveM = SND.createMixer(ac, { bpm: P.bpm, master: P.master });
    return liveM;
  }
  function preview(pitch) {
    if (T.on) return;
    try {
      const ac = audio(), t = curTrack();
      SND.melodyNote(ac, liveMixer().channel(t), { pitch: clamp(pitch, 0, 127), vel: 100 }, ac.currentTime + 0.01, 0.18, t.instrument || 'pluck', null, t.shape);
    } catch (err) { /* sound is optional */ }
  }
  function previewDrum(id, vel) {
    try {
      const ac = audio(), t = curTrack();
      const k = (t.kit || []).find((r) => r.id === id);
      SND.drumHit(ac, liveMixer().channel(t), id, ac.currentTime + 0.01, vel || 110, sampleBuf(t, id), null, k ? k.vol : 0.8);
    } catch (err) { /* sound is optional */ }
  }

  /* ---------- live playing (computer keyboard, MIDI) and recording it ---------- */
  const held = new Map();   // pitch -> {voice, start (pattern beat or null), vel}
  let recArmed = false, recBefore = null, recCount = 0;
  let keysOn = true;
  try { keysOn = localStorage.getItem('browserdj.ui.keys') !== '0'; } catch (err) { /* storage blocked */ }

  /* where a note played right now lands in the edited pattern, or null when not recording */
  function recPos() {
    if (!recArmed || !T.on || T.rec) return null;
    const b = editorPlayhead();
    if (b == null || b < 0) return null;
    // the player hears the beat a little late; take that back off
    const lat = ((actx.outputLatency || 0) + (actx.baseLatency || 0)) * T.bpm / 60;
    const PL = PJ.patternBeats(curPat());
    return (((b - lat) % PL) + PL) % PL;
  }
  function drumFor(pitch, source) {
    const D = SND.DRUMS;
    if (source === 'midi') {
      const gm = D.find((d) => d.gm === pitch);
      if (gm) return gm.id;
    }
    const k = source === 'keys' ? pitch - (live.octave + 1) * 12 : pitch - 36;
    return D[((k % D.length) + D.length) % D.length].id;
  }
  function startRecUndo() { if (recBefore == null) { recBefore = begin(); recCount = 0; } }
  function finishRec() {
    if (recBefore == null) return;
    const b = recBefore, n = recCount;
    recBefore = null;
    end(b);
    changed(curTrack().type === 'drums' ? 'drums' : 'notes');
    if (n) say('Recorded ' + n + (n === 1 ? ' note' : ' notes') + ' into "' + curPat().name + '". Undo removes the whole take.');
  }

  function noteOn(pitch, vel, source) {
    let ac;
    try { ac = audio(); } catch (err) { return; }
    const t = curTrack(), out = liveMixer().channel(t), now = ac.currentTime + 0.003;
    if (t.type === 'drums') {
      const id = drumFor(pitch, source), k = t.kit.find((r) => r.id === id);
      SND.drumHit(ac, out, id, now, vel, sampleBuf(t, id), null, k ? k.vol : 0.8);
      rack.flash(id);
      const pos = recPos();
      if (pos != null) {
        const pat = curPat(), N = pat.bars * PJ.STEPS_PER_BAR;
        startRecUndo();
        pat.steps[id][Math.round(pos * 4) % N] = Math.max(1, Math.min(127, vel));
        recCount++;
        rack.render();
      } else if (recArmed && !T.on) say('Press Play (or Space) to start recording.');
      return;
    }
    noteOff(pitch);
    const voice = SND.voiceStart(ac, out, { pitch, vel }, now, t.instrument || 'pluck', null, undefined, t.shape);
    held.set(pitch, { voice, start: recPos(), vel });
    if (recArmed && !T.on) say('Press Play (or Space) to start recording.');
    roll.draw();
  }

  function noteOff(pitch) {
    const h = held.get(pitch);
    if (!h) return;
    held.delete(pitch);
    h.voice.release(actx.currentTime);
    if (h.start != null && curTrack().type === 'synth') {
      const pat = curPat(), PL = PJ.patternBeats(pat), step = PJ.snapBeats(P);
      const endPos = recPos();
      let start = h.start, len = endPos == null ? 0.25 : endPos - start;
      if (len <= 0) len += PL; // held across the loop point
      if (step) { start = (Math.round(start / step) * step) % PL; len = Math.max(step, Math.round(len / step) * step); }
      else len = Math.max(1 / 32, len);
      len = Math.min(len, PL - start); // stay inside the loop so the pattern does not grow mid-take
      if (len > 1e-6) {
        startRecUndo();
        pat.notes.push({ id: P.nextId++, start, len, pitch, vel: h.vel });
        pat.notes.sort((a, b) => a.start - b.start || a.pitch - b.pitch);
        recCount++;
      }
    }
    roll.draw();
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

  /* Plays every note and hit of `items` that starts in [lo, hi) (local beats), shifted by `off` beats. */
  function scheduleEvents(ac, M, items, lo, hi, off, timeOf, bpm, skipTrack) {
    const bps = 60 / bpm;
    PJ.eventsIn(P, items, lo, hi, (ev) => {
      const out = M.channel(ev.track), when = timeOf(ev.at + off);
      if (ev.kind === 'note') SND.melodyNote(ac, out, ev, when, ev.len * bps, ev.track.instrument, M.live, ev.track.shape);
      else {
        SND.drumHit(ac, out, ev.drum, when, ev.vel, sampleBuf(ev.track, ev.drum), M.live, ev.gain);
      }
    }, { skipTrack });
  }

  /* Song automation for song beats [lo, hi): hold the value at lo, ramp through any points, arrive at hi. */
  function scheduleAuto(M, lo, hi, off, tOf) {
    for (const t of P.tracks) {
      for (const id of PJ.autoParams(t)) {
        const pts = t.auto[id];
        M.autoStart(t.id, id, PJ.autoValue(pts, lo), tOf(lo + off));
        for (const pt of pts) if (pt.b > lo && pt.b < hi) M.autoAt(t.id, id, pt.v, tOf(pt.b + off));
        M.autoAt(t.id, id, PJ.autoValue(pts, hi), tOf(hi + off));
      }
    }
  }

  /* ---------- transport ---------- */
  const T = { on: false };
  let TK = null; // playing back the raw recording

  const spb = () => 60 / T.bpm;
  const beatAbs = () => T.beat0 + (actx.currentTime - T.t0) / spb();
  const timeOf = (b) => T.t0 + (b - T.beat0) * spb();
  const looping = () => P.loop && !T.rec;

  /* Playback runs on an unwrapped beat counter ("abs"). The first pass goes from the start point to the loop end E,
     then every pass repeats [S, E). songPos maps abs to the song position. */
  function songPos(abs) {
    if (!looping() || abs < T.E) return abs;
    return T.S + ((abs - T.E) % (T.E - T.S));
  }

  function play(from = cursor(), opts = {}) {
    stopAll();
    let ac;
    try { ac = audio(); } catch (err) { say('This browser cannot play sound here.', 'warn'); return false; }
    const mode = opts.rec ? 'song' : P.mode;
    const L = PJ.playItems(P, mode).length, lr = PJ.loopRange(P, mode, L);
    // starting outside the loop jumps to its start
    if (!opts.rec && P.loop && (from < lr.start || from >= lr.end)) from = lr.start;
    Object.assign(T, {
      on: true, rec: !!opts.rec, mode, bpm: P.bpm, L, S: lr.start, E: lr.end,
      t0: ac.currentTime + 0.08, beat0: from, sched: from, from, skipTrack: opts.skipTrack || null,
      M: SND.createMixer(ac, { bpm: P.bpm, master: P.master }),
    });
    for (const t of P.tracks) T.M.channel(t);
    T.timer = setInterval(pump, 25);
    pump();
    frame();
    $('playBtn').classList.add('on');
    $('playLabel').textContent = 'Stop';
    return true;
  }

  function pump() {
    if (!T.on) return;
    const now = actx.currentTime;
    const { items, length: L } = PJ.playItems(P, T.mode);
    const lr = PJ.loopRange(P, T.mode, L);
    if (P.bpm !== T.bpm || L !== T.L || lr.start !== T.S || lr.end !== T.E) {
      // tempo, length or loop region changed while playing: carry on from the current song position
      const b = beatAbs();
      let pos = songPos(b);
      const ahead = T.sched - b;
      if (looping() && (pos < lr.start || pos >= lr.end)) pos = lr.start;
      T.beat0 = pos; T.t0 = now; T.sched = pos + ahead * (T.bpm / P.bpm);
      T.bpm = P.bpm; T.L = L; T.S = lr.start; T.E = lr.end;
      T.M.setBpm(P.bpm);
    }
    const endB = T.beat0 + (now + 0.15 - T.t0) / spb();
    if (endB > T.sched) {
      if (looping()) {
        // cut the window at every loop boundary
        let a = T.sched;
        const span = T.E - T.S;
        for (let guard = 0; a < endB - 1e-9 && guard < 64; guard++) {
          const pos = songPos(a), off = a - pos;
          const wrapAt = a < T.E ? T.E : T.E + (Math.floor((a - T.E) / span) + 1) * span;
          const b = Math.min(endB, wrapAt);
          scheduleEvents(actx, T.M, items, pos, pos + (b - a), off, timeOf, T.bpm);
          if (T.mode === 'song') scheduleAuto(T.M, pos, pos + (b - a), off, timeOf);
          clicks(pos, pos + (b - a), off, false);
          a = b;
        }
      } else {
        const a = T.sched, b = endB;
        // a recording count-in starts before the marker: only clicks there
        const lo = Math.max(a, T.rec ? T.from + 4 : 0);
        if (lo < b && a < L) scheduleEvents(actx, T.M, items, lo, Math.min(b, L), 0, timeOf, T.bpm, T.skipTrack);
        if (T.mode === 'song') scheduleAuto(T.M, a, b, 0, timeOf);
        clicks(a, b, 0, T.rec && !items.some((it) => it.track.id !== T.skipTrack && PJ.audible(P, it.track)));
      }
      T.sched = endB;
    }
    if (!looping() && !T.rec && beatAbs() > L + 0.5) stopAll();
  }

  /* metronome clicks on whole beats of the song positions [lo, hi), played at abs = pos + off */
  function clicks(lo, hi, off, always) {
    for (let k = Math.ceil(lo - EPS); k < hi - EPS; k++) {
      const countIn = T.rec && k < T.from + 4;
      if (P.click || countIn || always) clickAt(actx, T.M.master, timeOf(k + off), ((k % 4) + 4) % 4 === 0, T.M.live);
    }
  }

  /* Song (or pattern) position: wrapped into the loop. During a count-in, before the marker. */
  function transportPos() {
    if (!T.on) return null;
    return songPos(beatAbs());
  }

  /* Where the playhead is inside the pattern being edited, or null. */
  function editorPlayhead() {
    if (R) return R.liveBeat;
    if (TK && take && take.patternId === P.sel.patternId) return (actx.currentTime - TK.t0 - take.shift) * take.bpm / 60;
    const b = transportPos();
    if (b == null) return null;
    if (T.mode === 'pattern') return b;
    const pat = curPat(), PL = PJ.patternBeats(pat);
    const c = P.clips.find((x) => x.patternId === pat.id && b >= x.start && b < x.start + x.len);
    return c ? (b - c.start) % PL : null;
  }
  function songPlayhead() {
    if (!T.on || T.mode !== 'song') return null;
    return transportPos();
  }

  function frame() {
    cancelAnimationFrame(T.raf);
    const tickUI = () => {
      if (!T.on && !TK && !R) return;
      const eb = editorPlayhead(), sb = songPlayhead();
      if (eb != null && eb >= 0) roll.follow(eb);
      if (sb != null && sb >= 0) playlist.follow(sb);
      const shown = T.on ? transportPos() : eb;
      showPos(shown);
      const N = curPat().bars * PJ.STEPS_PER_BAR;
      rack.setPlayhead(eb != null && eb >= 0 && curTrack().type === 'drums' ? Math.floor(eb * 4 + 1e-6) % N : -1);
      mixer.meter(T.on ? (id) => T.M.level(id) : null);
      roll.draw();
      playlist.draw();
      T.raf = requestAnimationFrame(tickUI);
    };
    T.raf = requestAnimationFrame(tickUI);
  }

  function showPos(b) {
    if (b == null) b = cursor();
    if (T.on && T.rec && b < T.from + 4) { $('pos').textContent = 'count ' + Math.ceil(T.from + 4 - b); return; }
    if (b < 0) b = 0;
    const bar = Math.floor(b / 4) + 1, beat = Math.floor(b % 4) + 1, six = Math.floor((b % 1) * 4 + 1e-6) + 1;
    $('pos').textContent = bar + '.' + beat + '.' + six;
  }

  function stopAll() {
    finishRec();
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
    mixer.meter(null);
    showPos(null);
    roll.draw();
    playlist.draw();
  }

  function togglePlay() {
    if (R) { stopRec(); return; }
    if (T.on) stopAll(); else play();
  }

  function setMode(mode, restart = true) {
    if (P.mode === mode) return;
    P.mode = mode;
    syncMode();
    autosave();
    if (restart && T.on && !T.rec) play();
  }
  function syncMode() {
    $('modePat').classList.toggle('on', P.mode === 'pattern');
    $('modeSong').classList.toggle('on', P.mode === 'song');
    $('modePat').setAttribute('aria-pressed', String(P.mode === 'pattern'));
    $('modeSong').setAttribute('aria-pressed', String(P.mode === 'song'));
    showPos(null);
  }

  function updateMixer() {
    if (T.on && T.M) for (const t of P.tracks) T.M.update(t);
    if (liveM) { for (const t of P.tracks) liveM.update(t); liveM.setMaster(P.master); }
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

  /* ---------- trace (what the microphone heard) ---------- */
  let traceCache = null;
  function hostTrace() {
    if (R) return R.targetId === P.sel.patternId ? liveTrace() : null;
    if (!take || !take.track || take.patternId !== P.sel.patternId) return null;
    const pat = takePattern();
    const tun = P.capture.fixTuning ? take.tuning : 0, oct = 12 * (pat.takeOctave || 0);
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
    // make sure a synth pattern is selected so the live pitch shows where the notes will land
    if (curTrack().type !== 'synth') { commit(() => takeTarget()); }
    const target = curPat();
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
    R = { stream, src, node, mute, an, chunks, started: performance.now(), timer: setInterval(recTick, 50), anchor: null, liveBeat: null, targetId: target.id };
    if (P.capture.playBeat) {
      // one bar of count-in before the song marker, then the rest of the song plays along (minus this track)
      play(songCursor - 4, { rec: true, skipTrack: target.trackId });
      let inLat = 0.01;
      try { const st = stream.getAudioTracks()[0].getSettings(); if (st && isFinite(st.latency)) inLat = st.latency; } catch (err) { /* unknown */ }
      R.anchor = timeOf(songCursor) - ctxStart + (ac.outputLatency || 0) + (ac.baseLatency || 0) + inLat;
      say('Count-in: one bar of clicks, then hum along with the song from bar ' + (Math.floor(songCursor / 4) + 1) + '. Press Stop (or Space) when you are done.');
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
    R.liveBeat = T.on && T.rec ? beatAbs() - songCursor : (n * R.an.dt) * P.bpm / 60;
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
    ingest(r.an.frames(), buf, r.anchor, r.targetId);
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
    ingest(an.frames(), buf, null, curTrack().type === 'synth' ? P.sel.patternId : null);
  }

  /* ---------- drum samples ----------
     A kit row with your own sound has k.sample = {hash, name}; the audio lives in BDJ.Samples (IndexedDB),
     decoded buffers are cached here by hash. */
  let sampleTarget = null;
  const decoding = new Map(); // hash -> Promise
  /* decoding needs a context; an offline one works before the user has clicked anything (no autoplay warning) */
  let decoder = null;
  const decodeCtx = () => actx || decoder || (decoder = new (window.OfflineAudioContext || window.webkitOfflineAudioContext)(2, 1, 48000));
  function sampleBuf(t, id) {
    const k = t && t.kit && t.kit.find((r) => r.id === id);
    return k && k.sample ? decoded.get(k.sample.hash) || null : null;
  }
  /* decode every sample the project uses that is not decoded yet; reports any the browser does not have */
  async function ensureSamples() {
    const missing = [];
    const jobs = [];
    for (const t of P.tracks) for (const k of t.kit || []) {
      if (!k.sample || decoded.has(k.sample.hash)) continue;
      const h = k.sample.hash;
      if (!decoding.has(h)) {
        decoding.set(h, (async () => {
          const rec = await BDJ.Samples.get(h);
          if (!rec) return false;
          try { decoded.set(h, await decodeCtx().decodeAudioData(rec.bytes.slice(0))); return true; } catch (err) { return false; }
        })().finally(() => decoding.delete(h)));
      }
      jobs.push(decoding.get(h).then((ok) => { if (!ok) missing.push(k.sample.name); }));
    }
    if (!jobs.length) return;
    await Promise.all(jobs);
    rack.render();
    if (missing.length) say('This browser does not have ' + [...new Set(missing)].join(', ') + '. Drop the file on its drum row again, or open a saved project file that contains it.', 'warn');
  }

  async function loadSample(id, file) {
    if (!file) return;
    if (!/^audio\//.test(file.type) && !/\.(wav|mp3|ogg|flac|m4a|aif|aiff)$/i.test(file.name)) {
      say('"' + file.name + '" does not look like an audio file.', 'warn');
      return;
    }
    const t = curTrack();
    try {
      const bytes = await file.arrayBuffer();
      const buffer = await audio().decodeAudioData(bytes.slice(0)); // decoding takes the buffer over, so give it a copy
      const ref = await BDJ.Samples.put(file.name, file.type, bytes);
      decoded.set(ref.hash, buffer);
      commit(() => { t.kit.find((r) => r.id === id).sample = ref; });
      previewDrum(id, 110);
      say('The ' + SND.DRUMS.find((d) => d.id === id).name.toLowerCase() + ' in ' + t.name + ' now plays ' + file.name + '. It is kept in this browser and goes into saved project files.');
    } catch (err) {
      say('Could not use "' + file.name + '": ' + (err && err.message && /too big/.test(err.message) ? err.message : 'it does not read as audio') + '.', 'warn');
    }
  }
  function clearSample(id) { commit(() => { delete curTrack().kit.find((r) => r.id === id).sample; }); }

  /* ---------- project files and export ---------- */
  const slug = () => (P.name || 'song').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'song';
  function downloadBlob(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }
  const whatPlays = () => (P.mode === 'song' ? 'the song' : 'the pattern "' + curPat().name + '"');

  function exportMidi() {
    const tracks = PJ.midiTracks(P, P.mode);
    if (!tracks.length) { say('There is nothing to export in ' + whatPlays() + ' yet.', 'warn'); return; }
    const name = slug() + (P.mode === 'pattern' ? '-' + curPat().name.toLowerCase().replace(/[^a-z0-9]+/g, '-') : '') + '.mid';
    downloadBlob(new Blob([E.writeMidiTracks(tracks, P.bpm, P.mode === 'song' ? P.markers : [])], { type: 'audio/midi' }), name);
    say('Saved ' + name + ' with ' + whatPlays() + ': ' + tracks.length + (tracks.length === 1 ? ' track' : ' tracks') + ', drums on channel 10. Set your music program to ' + P.bpm + ' BPM.');
  }

  async function exportWav() {
    stopAll();
    const sr = 44100, { items, length: L } = PJ.playItems(P, P.mode), secs = L * 60 / P.bpm;
    const Ctx = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    if (!Ctx) { say('This browser cannot render audio files.', 'warn'); return; }
    say('Rendering ' + whatPlays() + '…');
    $('wavBtn').disabled = true;
    try {
      const total = secs + 2.5;
      const oac = new Ctx(2, Math.ceil(total * sr), sr);
      const M = SND.createMixer(oac, { bpm: P.bpm, master: P.master });
      M.live = null;
      for (const t of P.tracks) M.channel(t);
      const tOf = (b) => 0.02 + b * 60 / P.bpm;
      const song = P.mode === 'song';
      // Schedule a few seconds at a time: the renderer pauses at each chunk boundary, we add the next
      // chunk's notes and report progress. Far fewer nodes exist at once, which also makes it faster.
      const CHUNK = 3, chunkBeats = CHUNK * P.bpm / 60;
      let next = 0;
      const scheduleChunk = () => {
        const a = next, b = Math.min(L, next + chunkBeats);
        if (a < b) { scheduleEvents(oac, M, items, a, b, 0, tOf, P.bpm); if (song) scheduleAuto(M, a, b, 0, tOf); }
        next = b;
      };
      let chunked = typeof oac.suspend === 'function';
      if (chunked) {
        try {
          scheduleChunk();
          for (let k = 1; k * CHUNK < secs; k++) {
            const at = k * CHUNK;
            oac.suspend(at).then(() => {
              if (chunked) scheduleChunk();
              say('Rendering ' + whatPlays() + '… ' + Math.round((at / total) * 100) + '%');
              oac.resume();
            });
          }
        } catch (err) { chunked = false; }
      }
      // no suspend support (or it failed): schedule whatever is left in one go
      if (!chunked && next < L) { scheduleEvents(oac, M, items, next, L, 0, tOf, P.bpm); if (song) scheduleAuto(M, next, L, 0, tOf); next = L; }
      const t0 = performance.now();
      const buf = await oac.startRendering();
      if (next < L - 1e-9) throw new Error('rendering stopped early');
      console.debug('BrowserDJ: rendered ' + total.toFixed(1) + ' s in ' + ((performance.now() - t0) / 1000).toFixed(1) + ' s');
      downloadBlob(SND.encodeWav(buf), slug() + '.wav');
      say('Saved ' + slug() + '.wav with ' + whatPlays() + ' (' + secs.toFixed(1) + ' s at ' + P.bpm + ' BPM).');
    } catch (err) {
      say('Rendering failed: ' + (err && err.message ? err.message : err), 'warn');
    } finally {
      $('wavBtn').disabled = false;
    }
  }

  async function saveProject() {
    const name = prompt('Name this project', P.name === 'Untitled' || P.name === 'Example' ? '' : P.name);
    if (name === null) return;
    if (name.trim()) commit(() => { P.name = name.trim().slice(0, 80); });
    // your own sounds go inside the file so it opens complete anywhere
    const hashes = new Set();
    for (const t of P.tracks) for (const k of t.kit || []) if (k.sample) hashes.add(k.sample.hash);
    const sampleData = await BDJ.Samples.pack([...hashes]);
    const n = Object.keys(sampleData).length;
    const file = n ? { ...P, sampleData } : P;
    downloadBlob(new Blob([JSON.stringify(file, null, n ? undefined : 1)], { type: 'application/json' }), slug() + '.browserdj.json');
    say('Saved ' + slug() + '.browserdj.json' + (n ? ' with ' + n + (n === 1 ? ' sample' : ' samples') + ' inside' : '') + '. Open it here any time to keep working.');
  }

  async function openProject(file) {
    try {
      const obj = JSON.parse(await file.text());
      stopAll();
      if (obj && obj.sampleData) await BDJ.Samples.unpack(obj.sampleData);
      commit(() => { P = PJ.normalize(obj); take = null; });
      ensureSamples();
      patCursor = songCursor = 0;
      roll.sel.clear();
      roll.fit();
      playlist.fit();
      say('Opened ' + file.name + '.');
    } catch (err) {
      say('Could not open "' + file.name + '" as a BrowserDJ project.', 'warn');
    }
  }

  /* ---------- UI sync ---------- */
  const keyLabel = () => (P.scale === 'chromatic' ? 'no key' : E.NOTE_NAMES[P.root] + ' ' + E.SCALES[P.scale].name.toLowerCase());

  function refreshInfo() {
    const L = PJ.songBeats(P), bars = L / 4;
    $('songInfo').textContent = P.clips.length
      ? bars + (bars === 1 ? ' bar' : ' bars') + ' · ' + fmtTime(L * 60 / P.bpm) + ' · ' + keyLabel() + ' · ' + P.bpm + ' BPM'
      : 'Empty song · ' + keyLabel() + ' · ' + P.bpm + ' BPM';
    const t = curTrack(), pat = curPat();
    const pb = PJ.patternBeats(pat) / 4;
    if (t.type === 'synth') {
      const n = pat.notes.length;
      $('patInfo').textContent = n + (n === 1 ? ' note' : ' notes') + ' · ' + pb + (pb === 1 ? ' bar' : ' bars');
    } else {
      const hits = Object.values(pat.steps).reduce((a, s) => a + s.filter((v) => v).length, 0);
      $('patInfo').textContent = hits + (hits === 1 ? ' hit' : ' hits') + ' · ' + pb + (pb === 1 ? ' bar' : ' bars');
    }
    const uses = P.clips.filter((c) => c.patternId === pat.id).length;
    $('notInSong').hidden = uses > 0;
    $('patUses').textContent = uses ? 'used ' + uses + '× in the song' : '';
    const chip = $('takeChip');
    const mine = take && take.patternId === pat.id;
    chip.hidden = !mine;
    chip.textContent = mine && pat.fromTake ? 'From your take' : 'Edited';
    chip.classList.toggle('edited', !(mine && pat.fromTake));
    chip.title = mine && pat.fromTake ? 'Key, snap, tempo and note detail rebuild these notes from your recording.' : 'You edited the notes, so the settings no longer rebuild them. "Rebuild notes" starts over from the recording.';
    $('takeRow').classList.toggle('off', !take);
    $('guessTempo').disabled = !take || take.aligned;
    $('playTakeBtn').disabled = !take || !take.audio || !!R;
    const cents = take ? Math.round(take.tuning * 100) : 0;
    $('tuningInfo').textContent = take && Math.abs(cents) >= 5 ? '(you were ' + Math.abs(cents) + ' cents ' + (cents > 0 ? 'sharp' : 'flat') + ')' : '';
    if (t.type === 'synth') {
      $('bars').value = pat.bars;
      $('bars').min = Math.max(1, Math.ceil(PJ.notesEnd(pat) / 4 - 1e-6));
    }
  }

  function syncControls() {
    $('bpm').value = P.bpm;
    $('root').value = P.root;
    $('scale').value = P.scale;
    $('snap').value = P.snap;
    $('loop').checked = P.loop;
    $('click').checked = P.click;
    $('detail').value = Math.round(P.capture.detail * 100);
    $('fixTuning').checked = P.capture.fixTuning;
    $('playBeat').checked = P.capture.playBeat;
    syncMode();
    updateMixer();
  }

  function renderEditorHead() {
    const t = curTrack(), pat = curPat();
    $('edSwatch').style.background = t.color;
    $('edTrack').textContent = t.name;
    const sel = $('patSel');
    sel.innerHTML = '';
    for (const x of PJ.patternsOf(P, t.id)) sel.add(new Option(x.name, x.id));
    sel.value = pat.id;
    $('delPat').disabled = PJ.patternsOf(P, t.id).length < 2;
    const synth = t.type === 'synth';
    $('synthCtl').hidden = !synth;
    $('drumCtl').hidden = synth;
    $('shapeBar').hidden = !synth;
    if (synth) {
      $('instrument').value = t.instrument;
      $('echo').checked = (t.echoSend || 0) > 0;
      syncShape();
    } else {
      $('drumBars').value = pat.bars;
      $('swing').value = Math.round((t.swing || 0) * 100);
    }
    document.getElementById('editor').style.setProperty('--tc', t.color);
  }

  /* the Shape row: sliders and readable values */
  const fmtSecs = (s) => (s < 1 ? Math.round(s * 1000) + ' ms' : s.toFixed(2) + ' s');
  const shapeText = {
    attack: (v) => (v > 0 ? fmtSecs(SND.attackTime(v)) : 'own'),
    release: (v) => (v > 0 ? fmtSecs(SND.releaseTime(v)) : 'own'),
    tone: (v) => (Math.abs(v - 0.5) < 0.005 ? 'as is' : (v > 0.5 ? '+' : '−') + (Math.abs(v - 0.5) * 4).toFixed(1) + ' oct'),
  };
  function syncShape() {
    const sh = curTrack().shape || SND.SHAPE;
    for (const k of ['attack', 'release', 'tone']) {
      const id = 'sh' + k[0].toUpperCase() + k.slice(1);
      $(id).value = Math.round(sh[k] * 100);
      $(id + 'Out').textContent = shapeText[k](sh[k]);
    }
  }

  function renderEditor() {
    const synth = curTrack().type === 'synth';
    renderEditorHead();
    $('rollTools').hidden = !synth;
    $('rollWrap').hidden = !synth;
    $('rack').hidden = synth;
    if (synth) roll.draw(); else rack.render();
  }

  /* ---------- components ---------- */
  const roll = new BDJ.PianoRoll($('roll'), {
    project: () => P,
    pattern: curPat,
    length: () => PJ.patternBeats(curPat()),
    color: () => curTrack().color,
    begin, end, changed, preview,
    playhead: editorPlayhead,
    cursor: () => patCursor,
    setCursor: (b) => {
      patCursor = Math.max(0, b);
      setMode('pattern', false);
      showPos(null); roll.draw();
      if (T.on && !T.rec) play();
    },
    trace: hostTrace,
    held: () => held,
  });

  const rack = new BDJ.DrumRack($('rack'), {
    project: () => P,
    track: curTrack,
    pattern: curPat,
    begin, end, changed, previewDrum,
    loadSample, clearSample,
    pickSample: (id) => { sampleTarget = id; $('sampleInput').click(); },
    sampleName: (id) => { const k = curTrack().kit.find((r) => r.id === id); return k && k.sample ? k.sample.name + (decoded.has(k.sample.hash) ? '' : ' (missing)') : null; },
  });

  const playlist = new BDJ.Playlist($('plHeads'), $('plCanvas'), {
    project: () => P,
    begin, end, changed,
    select,
    playhead: songPlayhead,
    cursor: () => songCursor,
    setCursor: (b) => {
      songCursor = Math.max(0, b);
      setMode('song', false);
      showPos(null); playlist.draw();
      if (T.on && !T.rec) play();
    },
    trackChanged: (t) => { if (T.on && T.M) T.M.update(t); if (liveM) liveM.update(t); mixer.render(); },
    removeTrack: (id) => {
      const t = PJ.track(P, id);
      commit(() => PJ.deleteTrack(P, id));
      say('Deleted the track "' + t.name + '". Undo brings it back.');
    },
  });
  playlist.remember(P.sel.trackId, P.sel.patternId);
  if (curTrack().type === 'synth') lastSynth = curTrack().id;

  const live = new BDJ.Live({
    enabled: () => keysOn,
    noteOn, noteOff: (pitch) => noteOff(pitch),
    status: (text, kind) => { say(text, kind); $('midiConnect').textContent = live.inputs && live.inputs.length ? 'MIDI: ' + live.inputs.length + ' connected' : 'Connect MIDI keyboard'; },
  });

  // handle for debugging and tests (and, later, for an AI helper to read and write the project)
  const mixer = new BDJ.Mixer($('mixer'), {
    project: () => P,
    begin, end, changed, select,
    trackChanged: (t) => { if (T.on && T.M) T.M.update(t); if (liveM) liveM.update(t); },
    masterChanged: (v) => { if (T.on && T.M) T.M.setMaster(v); if (liveM) liveM.setMaster(v); },
  });

  window.BrowserDJ = { get project() { return P; }, get take() { return take; }, roll, rack, playlist, mixer, live, transport: T };

  /* ---------- wiring ---------- */
  E.NOTE_NAMES.forEach((nm, i) => $('root').add(new Option(nm, i)));
  for (const k of ['major', 'minor', 'minorPent', 'majorPent', 'dorian', 'phrygian', 'harmonicMinor', 'chromatic']) $('scale').add(new Option(E.SCALES[k].name, k));
  for (const i of SND.INSTRUMENTS) $('instrument').add(new Option(i.name, i.id));
  for (const [k, pre] of Object.entries(PJ.PRESETS)) if (k !== 'empty') $('preset').add(new Option(pre.name, k));

  const on = (id, ev, fn) => $(id).addEventListener(ev, fn);

  // transport
  on('playBtn', 'click', togglePlay);
  on('stopBtn', 'click', () => {
    if (R) { stopRec(); return; }
    stopAll();
    if (P.mode === 'song') songCursor = 0; else patCursor = 0;
    showPos(null); roll.draw(); playlist.draw();
  });
  on('modePat', 'click', () => setMode('pattern'));
  on('modeSong', 'click', () => setMode('song'));
  on('loop', 'change', () => { P.loop = $('loop').checked; autosave(); });
  on('click', 'change', () => { P.click = $('click').checked; autosave(); });
  on('bpm', 'change', () => {
    const v = clamp(Math.round(+$('bpm').value) || 120, 40, 240);
    commit(() => { P.bpm = v; if (takeFresh() && !take.aligned) rederive(); });
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
  on('root', 'change', () => commit(() => { P.root = +$('root').value; if (takeFresh()) rederive(); }));
  on('scale', 'change', () => commit(() => { P.scale = $('scale').value; if (takeFresh()) rederive(); }));
  on('detectKey', 'click', () => {
    if (!P.patterns.some((x) => x.notes && x.notes.length) && !take) { say('Add some notes first, then I can guess the key.', 'warn'); return; }
    commit(() => { const k = PJ.detectKey(P, take); P.root = k.root; P.scale = k.scale; if (takeFresh()) rederive(); });
    say('This sounds like ' + keyLabel() + '.');
  });
  on('undoBtn', 'click', undo);
  on('redoBtn', 'click', redo);
  on('newBtn', 'click', () => {
    stopAll();
    commit(() => { P = PJ.blank(); take = null; });
    patCursor = songCursor = 0; roll.sel.clear(); roll.fit(); playlist.fit();
    say('A fresh project with a melody track and a drum track. Hum something, draw notes, or load a drum pattern. Undo brings the old one back.');
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
    if (!take || !takePattern()) return;
    if (detailBefore == null) detailBefore = begin();
    P.capture.detail = +$('detail').value / 100;
    const seg = E.segment(take.frames, P.capture.detail);
    take.raw = seg.notes; take.track = seg.track; take.tuning = seg.tuning;
    rederive();
    refreshInfo(); roll.draw(); playlist.draw();
  });
  on('detail', 'change', () => {
    if (detailBefore == null) return;
    end(detailBefore); detailBefore = null; changed('all');
  });
  on('fixTuning', 'change', () => commit(() => { P.capture.fixTuning = $('fixTuning').checked; if (takePattern()) rederive(); }));
  on('guessTempo', 'click', () => {
    if (!take) return;
    commit(() => { P.bpm = E.guessTempo(take.raw).bpm; if (takeFresh()) rederive(); });
    say('Tempo guessed at ' + P.bpm + ' BPM.');
  });
  on('rereadBtn', 'click', () => {
    const pat = takePattern();
    if (!pat) { say('The pattern your take went into is gone. Record again.', 'warn'); return; }
    commit(() => { rederive(); PJ.select(P, pat.trackId, pat.id); });
    roll.fit();
    say('Notes in "' + pat.name + '" rebuilt from your recording. Undo brings your edits back.');
  });
  on('playTakeBtn', 'click', playTake);

  // playlist
  on('addSynth', 'click', () => {
    commit(() => { const t = PJ.addTrack(P, 'synth'); PJ.select(P, t.id); });
    say('Added a synth track. Pick its sound in the editor below, then draw or hum a pattern.');
  });
  on('addDrums', 'click', () => {
    commit(() => { const t = PJ.addTrack(P, 'drums'); PJ.select(P, t.id); });
    say('Added a drum track. Load a pattern or click steps in the editor below.');
  });
  on('plFit', 'click', () => playlist.fit());
  on('addMarker', 'click', () => playlist.addMarkerAt(songCursor));
  on('clearLoop', 'click', () => {
    if (!P.region) { say('Drag along the playlist ruler to make a loop region.'); return; }
    commit(() => { P.region = null; });
  });

  // mixer panel: shown or hidden, remembered in this browser
  const setMixerOpen = (open) => {
    $('mixerBody').hidden = !open;
    $('mixerToggle').textContent = open ? 'Hide' : 'Show';
    $('mixerToggle').setAttribute('aria-expanded', String(open));
    try { localStorage.setItem('browserdj.ui.mixer', open ? '1' : '0'); } catch (err) { /* storage blocked */ }
    if (open) mixer.render();
  };
  on('mixerToggle', 'click', () => setMixerOpen($('mixerBody').hidden));

  // editor: patterns
  on('patSel', 'change', () => select(P.sel.trackId, +$('patSel').value));
  on('newPat', 'click', () => {
    commit(() => { const pat = PJ.addPattern(P, P.sel.trackId); PJ.select(P, pat.trackId, pat.id); });
    patCursor = 0; roll.fit();
  });
  on('clonePat', 'click', () => {
    commit(() => { const pat = PJ.clonePattern(P, curPat()); PJ.select(P, pat.trackId, pat.id); });
    say('Made a copy called "' + curPat().name + '". Changes to it leave the original alone.');
  });
  on('renamePat', 'click', () => {
    const name = prompt('Rename this pattern', curPat().name);
    if (name && name.trim()) commit(() => { curPat().name = name.trim().slice(0, 40); });
  });
  on('delPat', 'click', () => {
    const pat = curPat();
    commit(() => PJ.deletePattern(P, pat.id));
    say('Deleted "' + pat.name + '" and its clips. Undo brings it back.');
  });
  on('addToSong', 'click', () => {
    const pat = curPat();
    const endOfTrack = P.clips.filter((c) => c.trackId === pat.trackId).reduce((a, c) => Math.max(a, c.start + c.len), 0);
    commit(() => PJ.addClip(P, pat, Math.ceil(endOfTrack / 4) * 4));
  });

  // editor: synth
  on('instrument', 'change', () => { commit(() => { curTrack().instrument = $('instrument').value; }); preview(60); });
  // the mixer sets the exact amount; this checkbox is the quick on/off
  on('echo', 'change', () => commit(() => { curTrack().echoSend = $('echo').checked ? 1 : 0; }));
  on('snap', 'change', () => commit(() => { P.snap = +$('snap').value; if (takeFresh()) rederive(); }));
  on('bars', 'change', () => {
    const pat = curPat();
    const min = Math.max(1, Math.ceil(PJ.notesEnd(pat) / 4 - 1e-6));
    const v = clamp(Math.round(+$('bars').value) || min, 1, 128);
    if (v < min) say('The notes reach bar ' + min + '. Delete the later notes to make the pattern shorter.', 'warn');
    commit(() => { pat.bars = Math.max(v, min); });
  });
  const octave = (d) => {
    const pat = curPat();
    if (take && take.patternId === pat.id && pat.fromTake && !roll.sel.size) commit(() => { pat.takeOctave = clamp((pat.takeOctave || 0) + d, -4, 4); rederive(); });
    else roll.transpose(12 * d);
  };
  on('octUp', 'click', () => octave(1));
  on('octDown', 'click', () => octave(-1));
  on('quantBtn', 'click', () => { if (!roll.quantize()) say('Pick a Snap value first, then Quantize lines the notes up to it.', 'warn'); });
  on('keyBtn', 'click', () => { if (P.scale === 'chromatic') say('Pick a key first. Chromatic has no wrong notes to fix.', 'warn'); else roll.fitToKey(); });
  on('legatoBtn', 'click', () => roll.legato());
  on('clearMelBtn', 'click', () => {
    const pat = curPat();
    if (!pat.notes.length) return;
    commit(() => { pat.notes = []; pat.fromTake = false; });
    roll.sel.clear();
    say('Pattern cleared. Undo brings the notes back.');
  });
  on('fitBtn', 'click', () => roll.fit());

  // sound shape
  let shapeBefore = null;
  for (const k of ['attack', 'release', 'tone']) {
    const id = 'sh' + k[0].toUpperCase() + k.slice(1);
    on(id, 'input', () => {
      const t = curTrack();
      if (t.type !== 'synth') return;
      if (shapeBefore == null) shapeBefore = begin();
      t.shape = { ...(t.shape || SND.SHAPE), [k]: +$(id).value / 100 };
      $(id + 'Out').textContent = shapeText[k](t.shape[k]);
    });
    on(id, 'change', () => {
      if (shapeBefore != null) { end(shapeBefore); shapeBefore = null; autosave(); }
      if (!T.on && !held.size) preview(60);
    });
    on(id, 'dblclick', () => {
      $(id).value = k === 'tone' ? 50 : 0;
      $(id).dispatchEvent(new Event('input'));
      $(id).dispatchEvent(new Event('change'));
    });
  }
  on('shReset', 'click', () => { commit(() => { curTrack().shape = { ...SND.SHAPE }; }); preview(60); });

  // live keys
  const syncKeys = () => {
    $('keysToggle').classList.toggle('on', keysOn);
    $('keysToggle').setAttribute('aria-pressed', String(keysOn));
    $('recNotes').classList.toggle('on', recArmed);
    $('recNotes').setAttribute('aria-pressed', String(recArmed));
    $('kOct').textContent = 'C' + live.octave;
  };
  on('keysToggle', 'click', () => {
    keysOn = !keysOn;
    if (!keysOn) live.releaseAll();
    try { localStorage.setItem('browserdj.ui.keys', keysOn ? '1' : '0'); } catch (err) { /* storage blocked */ }
    syncKeys();
    say(keysOn ? 'Your keyboard plays the selected track: Z to M and Q to U are two octaves. Shift plays louder.' : 'Keyboard playing is off; letter shortcuts like Q (quantize) work again.');
  });
  on('kOctDown', 'click', () => { live.shiftOctave(-1); syncKeys(); });
  on('kOctUp', 'click', () => { live.shiftOctave(1); syncKeys(); });
  on('midiConnect', 'click', () => live.connectMidi());
  on('recNotes', 'click', () => {
    recArmed = !recArmed;
    if (!recArmed) finishRec();
    syncKeys();
    if (recArmed) say(T.on ? 'Recording: play and your notes go into "' + curPat().name + '".' : 'Armed. Press Play (Space) and play along; notes go into "' + curPat().name + '" while it loops.');
  });
  syncKeys();

  // editor: drums
  on('preset', 'change', () => {
    const k = $('preset').value;
    if (!k) return;
    commit(() => PJ.applyPreset(P, curPat(), k));
    $('preset').value = '';
    const pre = PJ.PRESETS[k];
    say(pre.name + ' loaded into "' + curPat().name + '".' + (pre.bpm && Math.abs(pre.bpm - P.bpm) > 12 ? ' It usually sits around ' + pre.bpm + ' BPM.' : ''));
  });
  on('drumBars', 'change', () => commit(() => PJ.setDrumBars(curPat(), +$('drumBars').value)));
  on('drumClear', 'click', () => commit(() => PJ.applyPreset(P, curPat(), 'empty')));
  let swingBefore = null;
  on('swing', 'input', () => { if (swingBefore == null) swingBefore = begin(); curTrack().swing = +$('swing').value / 100; });
  on('swing', 'change', () => { if (swingBefore != null) { end(swingBefore); swingBefore = null; autosave(); } });
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
  renderEditor();
  playlist.renderHeads();
  let mixOpen = true;
  try { mixOpen = localStorage.getItem('browserdj.ui.mixer') !== '0'; } catch (err) { /* storage blocked */ }
  setMixerOpen(mixOpen);
  refreshInfo();
  updateUndo();
  showPos(null);
  roll.fit();
  playlist.fit();
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => { roll.draw(); playlist.draw(); });
  say(restored
    ? 'Welcome back, your last project is loaded. Press Space to play.'
    : 'This is an example song. Press Space to hear it. Click a clip in the playlist to edit its pattern below, or press Record and hum a new idea.');
  ensureSamples(); // your own drum sounds, from this browser's sample store
})();
