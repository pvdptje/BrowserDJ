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
  if (!P.songId) P.songId = BDJ.Library.newId();

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
    if (before !== snap()) { H.push(before); updateUndo(); if (!libQuiet) scheduleLib(); }
  }
  function commit(fn) { const b = begin(); fn(); end(b); changed('all'); }

  /* ---------- My songs ----------
     A song joins the list the first time it is changed (opening an example or a file is not a change), and is
     then kept up to date a moment after every edit. Each project carries its own songId, so undo stays with it. */
  let libQuiet = false, libTimer = 0;
  function scheduleLib() { clearTimeout(libTimer); libTimer = setTimeout(saveLib, 1200); }
  function saveLib() {
    clearTimeout(libTimer); libTimer = 0;
    if (!P.songId) P.songId = BDJ.Library.newId();
    const { length } = PJ.playItems(P, P.clips.length ? 'song' : 'pattern');
    return BDJ.Library.put(P.songId, JSON.parse(snap()), PJ.songSecs(P, P.clips.length ? 'song' : 'pattern', length));
  }
  /* save anything pending right now (before switching songs, or when the tab is hidden) */
  function flushLib() { return libTimer ? saveLib() : Promise.resolve(); }
  /* replace the project as one undo step that does not count as editing it */
  function loadCommit(fn) {
    flushLib();
    libQuiet = true;
    try { commit(fn); } finally { libQuiet = false; }
  }
  document.addEventListener('visibilitychange', () => { if (document.hidden) flushLib(); });
  window.addEventListener('pagehide', () => { flushLib(); });
  function updateUndo() {
    $('undoBtn').disabled = !H.undo.length;
    $('redoBtn').disabled = !H.redo.length;
  }
  function restore(s) {
    P = JSON.parse(s);
    scheduleLib(); // undo and redo are edits to whichever song they land on
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
    PJ.syncAudio(P);
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
    if (kind !== 'quiet') { refreshInfo(); roll.draw(); playlist.draw(); drawAudio(); }
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
    take.bpm = take.tempo || P.bpm;
    pat.bars = Math.max(1, Math.ceil(PJ.notesEnd(pat) / 4 - 1e-6));
    roll.sel.clear();
  }

  /* The drum pattern a beatbox take goes into: the selected one, or a fresh "Beatbox" pattern on a drum track. */
  function beatTarget() {
    if (curTrack().type === 'drums') return curPat();
    let t = P.tracks.find((x) => x.type === 'drums');
    if (!t) t = PJ.addTrack(P, 'drums', { name: 'Beatbox' });
    const pat = PJ.addPattern(P, t.id, PJ.uniqueName(P, t.id, 'Beatbox'));
    PJ.select(P, t.id, pat.id);
    return pat;
  }

  /* Mouth drums -> a drum pattern. samples: mono Float32Array. anchor: seconds where beat 0 fell (hum over the beat). */
  function beatIngest(samples, sr, anchor, targetId) {
    const hits = BDJ.Beatbox.analyze(samples, sr);
    if (hits.length < 2) {
      say('I heard ' + (hits.length ? 'only one hit' : 'no hits') + '. Make short, sharp sounds close to the microphone: "boots" for a kick, "ka" or "psh" for a snare, "ts" for a hi-hat.', 'warn');
      return false;
    }
    const aligned = anchor != null;
    let kept = false, st = null;
    commit(() => {
      const pat = PJ.pattern(P, targetId) || beatTarget();
      kept = otherMusic(pat.id);
      // A beat is about which 16th each hit falls on, so read it at the tempo it was performed at; the pattern
      // then simply plays at the song's tempo. Over the song (aligned) the song's own grid is the right one.
      // A first idea also hands its tempo to the song.
      const performed = hits.length >= 4 ? E.guessTempo(hits.map((h) => ({ start: h.t }))).bpm : P.bpm;
      if (!kept && !aligned) P.bpm = performed;
      st = BDJ.Beatbox.toSteps(hits, aligned ? PJ.tempoAt(P, songCursor, 'song') : performed, aligned ? anchor : null);
      if (!st) return;
      pat.bars = st.bars;
      pat.steps = Object.fromEntries(SND.DRUMS.map((d) => [d.id, st.steps[d.id] ? st.steps[d.id].slice() : new Array(st.bars * PJ.STEPS_PER_BAR).fill(0)]));
      PJ.select(P, pat.trackId, pat.id);
      const at = aligned ? songCursor : (P.clips.some((c) => c.patternId === pat.id) ? null : songCursor);
      if (at != null && !P.clips.some((c) => c.patternId === pat.id && c.start === at)) PJ.addClip(P, pat, at);
    });
    if (!st) { say('Those hits all came before the song marker. Try again and start on the beat.', 'warn'); return false; }
    const count = (id) => st.steps[id].filter((v) => v).length;
    const parts = [['kick', 'kick'], ['snare', 'snare'], ['chat', 'hi-hat']].map(([id, n]) => [count(id), n]).filter(([c]) => c)
      .map(([c, n]) => c + ' ' + n + (c === 1 ? '' : 's'));
    say('Heard ' + parts.join(', ') + ' in "' + curPat().name + '" (' + st.bars + (st.bars === 1 ? ' bar' : ' bars') + ').' +
      (aligned ? ' They sit where you made them against the beat.' : kept ? ' It plays at your song’s tempo.' : ' The tempo follows your rhythm: ' + P.bpm + ' BPM.') +
      ' Fix any step by clicking it.');
    return true;
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
      // over the song, the notes are read at the tempo where the recording started
      if (aligned) take.tempo = PJ.tempoAt(P, songCursor, 'song');
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
    if (!actx) {
      // iPhones mute web audio when the ringer switch is on silent, unless the page says it plays music
      try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch (err) { /* older browsers */ }
      actx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'interactive' });
    }
    if (actx.state === 'suspended') actx.resume().catch(() => {});
    return actx;
  }

  /* A mixer that is always there for sounds you trigger by hand (previews, live keys), so they go through
     the track's own channel: drive, filter, pan and volume sound exactly like playback. */
  /* the shape a track's notes play with; Wobble keeps the voice's own filter open */
  function voiceShape(t) {
    return t.lfo && t.lfo.target === 'filter' && t.lfo.depth > 0 ? { ...(t.shape || SND.SHAPE), wobble: true } : t.shape;
  }
  let liveM = null;
  function liveMixer() {
    const ac = audio();
    if (!liveM) liveM = SND.createMixer(ac, { bpm: P.bpm, master: P.master, loud: P.loud });
    return liveM;
  }
  function preview(pitch) {
    if (T.on) return;
    try {
      const ac = audio(), t = curTrack();
      SND.melodyNote(ac, liveMixer().channel(t), { pitch: clamp(pitch, 0, 127), vel: 100 }, ac.currentTime + 0.01, 0.18, t.instrument || 'pluck', null, voiceShape(t), samplerFor(t));
    } catch (err) { /* sound is optional */ }
  }
  function previewDrum(id, vel) {
    try {
      const ac = audio(), t = curTrack();
      const k = (t.kit || []).find((r) => r.id === id);
      SND.drumHit(ac, liveMixer().channel(t), id, ac.currentTime + 0.01, vel || 110, sampleBuf(t, id), null, k ? k.vol : 0.8, t.kitStyle);
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
    const t = curTrack();
    if (t.type === 'audio') return;
    const out = liveMixer().channel(t), now = ac.currentTime + 0.003;
    if (t.type === 'drums') {
      const id = drumFor(pitch, source), k = t.kit.find((r) => r.id === id);
      SND.drumHit(ac, out, id, now, vel, sampleBuf(t, id), null, k ? k.vol : 0.8, t.kitStyle);
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
    const voice = SND.voiceStart(ac, out, { pitch, vel }, now, t.instrument || 'pluck', null, undefined, voiceShape(t), samplerFor(t));
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
  /* catchUp: also start recordings already under way at lo. cut: a song beat where recordings stop (the loop end). */
  function scheduleEvents(ac, M, items, lo, hi, off, timeOf, skipTrack, catchUp, cut) {
    const bps = 60 / P.bpm; // a take's beats are counted at the song's tempo (PJ.syncAudio): audio is not stretched
    PJ.eventsIn(P, items, lo, hi, (ev) => {
      const out = M.channel(ev.track), when = timeOf(ev.at + off);
      if (ev.kind === 'audio') {
        const au = ev.pattern.audio, buf = decoded.get(au.hash);
        const len = cut != null ? Math.min(ev.len, cut - ev.at) : ev.len;
        if (buf && len > 0) SND.audioClip(ac, out, buf, when, au.start + ev.offset * bps, len * bps, au.gain, M.live);
      } else if (ev.kind === 'note') SND.melodyNote(ac, out, ev, when, timeOf(ev.at + ev.len + off) - when, ev.track.instrument, M.live, voiceShape(ev.track), samplerFor(ev.track));
      else {
        SND.drumHit(ac, out, ev.drum, when, ev.vel, sampleBuf(ev.track, ev.drum), M.live, ev.gain, ev.track.kitStyle);
        // every kick pumps the tracks that have Pump turned up
        if (ev.drum === 'kick' || ev.drum === 'hkick') M.pumpAt(when, ev.track.id);
      }
    }, { skipTrack, catchUp });
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

  /* The clock: T.A is a list of tempo anchors {t, b, bpm}: from audio time t (beat b of the unwrapped counter)
     on, beats go by at bpm. A tempo change in the song adds one, a little ahead of time, at the exact beat. */
  const anchorAtT = (t) => { const A = T.A; let i = A.length - 1; while (i > 0 && A[i].t > t) i--; return A[i]; };
  const anchorAtB = (b) => { const A = T.A; let i = A.length - 1; while (i > 0 && A[i].b > b) i--; return A[i]; };
  const beatAt = (t) => { const a = anchorAtT(t); return a.b + ((t - a.t) * a.bpm) / 60; };
  const beatAbs = () => beatAt(actx.currentTime);
  const timeOf = (b) => { const a = anchorAtB(b); return a.t + ((b - a.b) * 60) / a.bpm; };
  const looping = () => P.loop && !T.rec;
  // what the clock has to follow: the song tempo and its changes (Song mode only)
  const tempoKey = (mode) => P.bpm + (mode === 'song' && P.tempo.length ? JSON.stringify(P.tempo) : '');
  /* The tempo at abs beat a (song position pos): adds an anchor when it differs from the running one.
     Returns the abs beat of the next tempo change in the song (Infinity when there is none). */
  function tempoStep(a, pos) {
    const bpm = PJ.tempoAt(P, pos, T.mode), last = T.A[T.A.length - 1];
    if (bpm !== last.bpm) {
      const t = timeOf(a);
      T.A.push({ t, b: a, bpm });
      T.M.setBpm(bpm, t, t - (a * 60) / bpm);
    }
    return a + (PJ.nextTempo(P, pos, T.mode) - pos);
  }

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
    const bpm = PJ.tempoAt(P, from, mode), t0 = ac.currentTime + 0.08;
    Object.assign(T, {
      on: true, rec: !!opts.rec, mode, bpm, tk: tempoKey(mode), L, S: lr.start, E: lr.end,
      A: [{ t: t0, b: from, bpm }], sched: from, from, skipTrack: opts.skipTrack || null, catchUp: true,
      // LFOs count their cycles from the moment beat 0 of what plays would have sounded
      M: SND.createMixer(ac, { bpm, master: P.master, loud: P.loud, lfoZero: t0 - (from * 60) / bpm }),
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
    const tk = tempoKey(T.mode);
    if (tk !== T.tk || L !== T.L || lr.start !== T.S || lr.end !== T.E) {
      // tempo, length or loop region changed while playing: carry on from the current song position
      const b = beatAbs(), covered = timeOf(T.sched);
      let pos = songPos(b);
      if (looping() && (pos < lr.start || pos >= lr.end)) pos = lr.start;
      T.tk = tk; T.L = L; T.S = lr.start; T.E = lr.end;
      const bpm = PJ.tempoAt(P, pos, T.mode);
      T.A = [{ t: now, b: pos, bpm }];
      // what is already scheduled stays; carry on from the beat where it ends
      T.sched = pos + (Math.max(0, covered - now) * bpm) / 60;
      T.bpm = bpm;
      T.M.setBpm(bpm);
      T.M.setLfoZero(now - (pos * 60) / bpm, P.tracks);
    }
    // anchors that are long gone; the running tempo (for the latency correction)
    while (T.A.length > 1 && T.A[1].t < now - 1) T.A.shift();
    T.bpm = anchorAtT(now).bpm;
    let endB = beatAt(now + 0.15);
    if (endB > T.sched) {
      if (looping()) {
        // cut the window at every loop boundary and every tempo change
        let a = T.sched;
        const span = T.E - T.S;
        for (let guard = 0; a < endB - 1e-9 && guard < 64; guard++) {
          const pos = songPos(a), off = a - pos;
          const wrapAt = a < T.E ? T.E : T.E + (Math.floor((a - T.E) / span) + 1) * span;
          const nextT = tempoStep(a, pos);
          endB = beatAt(now + 0.15);
          if (a >= endB - 1e-9) break;
          const b = Math.min(endB, wrapAt, nextT);
          // at the start and at every jump back to the loop start, recordings already under way join in
          const fresh = T.catchUp || (a > T.from && Math.abs(pos - T.S) < 1e-9);
          T.catchUp = false;
          scheduleEvents(actx, T.M, items, pos, pos + (b - a), off, timeOf, null, fresh, T.E);
          if (T.mode === 'song') scheduleAuto(T.M, pos, pos + (b - a), off, timeOf);
          clicks(pos, pos + (b - a), off, false);
          a = b;
        }
        endB = a;
      } else {
        let a = T.sched;
        for (let guard = 0; a < endB - 1e-9 && guard < 64; guard++) {
          const nextT = tempoStep(a, a);
          endB = beatAt(now + 0.15);
          if (a >= endB - 1e-9) break;
          const b = Math.min(endB, nextT);
          // a recording count-in starts before the marker: only clicks there
          const lo = Math.max(a, T.rec ? T.from + 4 : 0);
          if (lo < b && a < L) { scheduleEvents(actx, T.M, items, lo, Math.min(b, L), 0, timeOf, T.skipTrack, T.catchUp); T.catchUp = false; }
          if (T.mode === 'song') scheduleAuto(T.M, a, b, 0, timeOf);
          clicks(a, b, 0, T.rec && !items.some((it) => it.track.id !== T.skipTrack && PJ.audible(P, it.track)));
          a = b;
        }
        endB = a;
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
      drawAudio();
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
    if (liveM) { for (const t of P.tracks) liveM.update(t); liveM.setMaster(P.master); liveM.setLoud(P.loud); }
    if (T.on && T.M) { T.M.setMaster(P.master); T.M.setLoud(P.loud); }
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
    const audioMode = curTrack().type === 'audio';
    const drumsMode = !audioMode && P.capture.mode === 'drums';
    // melody: a synth pattern, so the live pitch shows where the notes will land; drums: a drum pattern
    if (!audioMode && drumsMode && curTrack().type !== 'drums') commit(() => beatTarget());
    if (!audioMode && !drumsMode && curTrack().type !== 'synth') commit(() => takeTarget());
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
    R = { stream, src, node, mute, an, chunks, started: performance.now(), timer: setInterval(recTick, 50), anchor: null, liveBeat: null, targetId: target.id, drums: drumsMode, audio: audioMode, trackId: target.trackId };
    if (P.capture.playBeat || audioMode) {
      // one bar of count-in before the song marker, then the rest of the song plays along (minus this track)
      play(songCursor - 4, { rec: true, skipTrack: target.trackId });
      let inLat = 0.01;
      try { const st = stream.getAudioTracks()[0].getSettings(); if (st && isFinite(st.latency)) inLat = st.latency; } catch (err) { /* unknown */ }
      R.anchor = timeOf(songCursor) - ctxStart + (ac.outputLatency || 0) + (ac.baseLatency || 0) + inLat;
      say('Count-in: one bar of clicks, then ' + (audioMode ? 'sing or play' : drumsMode ? 'beatbox' : 'hum') + ' along with the song from bar ' + (Math.floor(songCursor / 4) + 1) + '. Press Stop (or Space) when you are done.' + (audioMode ? ' Use headphones, so the microphone only hears you.' : ''));
    } else {
      say(drumsMode ? 'Listening. Beatbox: "boots" for a kick, "ka" for a snare, "ts" for a hi-hat. Then press Stop.' : 'Listening. Hum your tune, then press Stop.');
      frame();
    }
    $('recBtn').classList.add('on');
    $('audRec').classList.add('on');
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
      // in drums mode a note name means nothing; show the level only
      $('liveNote').textContent = heard && !R.drums ? E.noteName(Math.round(R.an.midi[n - 1])) : '--';
      $('liveNote').classList.toggle('idle', !heard || R.drums);
    }
    R.liveBeat = T.on && T.rec ? beatAbs() - songCursor : (n * R.an.dt) * P.bpm / 60;
    if (el > (R.audio ? 600 : 180)) stopRec();
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
    $('audRec').classList.remove('on');
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
      say(r.audio ? 'That was too short. Press Record, wait for the count-in, and keep going for a bit.' : r.drums ? 'That was too short to find a beat. Press Record and beatbox for a few seconds.' : 'That was too short to find a tune. Press Record and hum for a few seconds.', 'warn');
      refreshInfo(); roll.draw();
      return;
    }
    const buf = actx.createBuffer(1, len, actx.sampleRate), ch = buf.getChannelData(0);
    let o = 0;
    for (const c of r.chunks) { ch.set(c, o); o += c.length; }
    if (r.audio) audioIngest(ch, actx.sampleRate, r.anchor, r.trackId);
    else if (r.drums) beatIngest(ch, actx.sampleRate, r.anchor, r.targetId);
    else ingest(r.an.frames(), buf, r.anchor, r.targetId);
    refreshInfo(); roll.draw();
  }

  /* ---------- loading a recording ---------- */
  async function loadFile(file) {
    if (!file || R) return;
    if (/\.(json|bdj)$/i.test(file.name) || file.type === 'application/json') { openProject(file); return; }
    if (/\.(mid|midi|smf)$/i.test(file.name) || file.type === 'audio/midi' || file.type === 'audio/x-midi') { importMidi(file); return; }
    stopAll();
    say('Reading ' + file.name + '…');
    const audioT = curTrack().type === 'audio' ? curTrack() : null;
    let buf, bytes;
    try {
      bytes = await file.arrayBuffer();
      buf = await audio().decodeAudioData(bytes.slice(0));
    } catch (err) {
      say('Could not read "' + file.name + '" as audio. Try a WAV, MP3, M4A or OGG file.', 'warn');
      return;
    }
    if (audioT) {
      if (buf.duration > 900) { say('"' + file.name + '" is longer than 15 minutes: too long to keep in the browser.', 'warn'); return; }
      addTake(bytes, file.name, file.type || 'audio/wav', buf, audioT.id, songCursor, 'Loaded');
      return;
    }
    const n = Math.min(buf.length, Math.round(buf.sampleRate * 300));
    const mono = new Float32Array(n);
    for (let c = 0; c < buf.numberOfChannels; c++) {
      const d = buf.getChannelData(c);
      for (let i = 0; i < n; i++) mono[i] += d[i] / buf.numberOfChannels;
    }
    if (P.capture.mode === 'drums') {
      beatIngest(mono, buf.sampleRate, null, curTrack().type === 'drums' ? P.sel.patternId : null);
      return;
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
  function soundRefs() {
    const out = [];
    for (const t of P.tracks) {
      for (const k of t.kit || []) if (k.sample) out.push(k.sample);
      if (t.sampler) out.push(t.sampler);
    }
    for (const x of P.patterns) if (x.audio) out.push(x.audio);
    return out;
  }
  /* what the Sampler instrument of track t plays: {buffer, root, gain}, or null while it has no sound */
  function samplerFor(t) {
    const sm = t && t.sampler, buffer = sm && decoded.get(sm.hash);
    return buffer ? { buffer, root: sm.root, gain: sm.gain } : null;
  }
  function sampleBuf(t, id) {
    const k = t && t.kit && t.kit.find((r) => r.id === id);
    return k && k.sample ? decoded.get(k.sample.hash) || null : null;
  }
  /* decode every sample the project uses that is not decoded yet; reports any the browser does not have */
  async function ensureSamples() {
    const missing = [];
    const jobs = [];
    for (const ref of soundRefs()) {
      if (decoded.has(ref.hash)) continue;
      const h = ref.hash;
      if (!decoding.has(h)) {
        decoding.set(h, (async () => {
          const rec = await BDJ.Samples.get(h);
          if (!rec) return false;
          try { decoded.set(h, await decodeCtx().decodeAudioData(rec.bytes.slice(0))); return true; } catch (err) { return false; }
        })().finally(() => decoding.delete(h)));
      }
      jobs.push(decoding.get(h).then((ok) => { if (!ok) missing.push(ref.name); }));
    }
    if (!jobs.length) return;
    await Promise.all(jobs);
    rack.render();
    playlist.draw();
    drawAudio();
    if (curTrack().type === 'synth') syncSampler();
    if (missing.length) say('This browser does not have ' + [...new Set(missing)].join(', ') + '. Load the sound again, or open a saved project file that contains it.', 'warn');
  }

  /* ---------- the Sampler: your own sound as an instrument ---------- */
  /* Finds the note a sound was played at, with the same pitch tracker the humming uses. null: no clear pitch. */
  function findRoot(buffer) {
    const d = buffer.getChannelData(0), n = Math.min(d.length, Math.round(buffer.sampleRate * 4));
    const an = new E.Analyzer(buffer.sampleRate);
    an.push(d.subarray(0, n));
    an.process();
    const F = an.frames(), good = [];
    let peak = 0;
    for (const r of F.rms) peak = Math.max(peak, r);
    for (let i = 0; i < F.midi.length; i++) if (F.conf[i] < 0.2 && F.rms[i] > peak * 0.2 && isFinite(F.midi[i])) good.push(F.midi[i]);
    if (good.length < 5) return null;
    good.sort((a, b) => a - b);
    return good[good.length >> 1];
  }
  function peakOf(buffer) {
    let pk = 0;
    for (let c = 0; c < buffer.numberOfChannels; c++) { const d = buffer.getChannelData(c); for (let i = 0; i < d.length; i++) pk = Math.max(pk, Math.abs(d[i])); }
    return pk;
  }
  async function useSamplerSound(bytes, name, type) {
    const t = curTrack();
    if (t.type !== 'synth') return;
    let buffer;
    try { buffer = await audio().decodeAudioData(bytes.slice(0)); } catch (err) { say('Could not read "' + name + '" as audio.', 'warn'); return; }
    if (buffer.duration < 0.05) { say('That sound is too short to play.', 'warn'); return; }
    const found = findRoot(buffer), root = found == null ? 60 : Math.round(found * 100) / 100;
    let ref;
    try { ref = await BDJ.Samples.put(name, type, bytes); } catch (err) { say('Could not keep "' + name + '": ' + err.message + '.', 'warn'); return; }
    decoded.set(ref.hash, buffer);
    const gain = Math.min(20, 0.7 / Math.max(0.01, peakOf(buffer)));
    commit(() => { t.instrument = 'sampler'; t.sampler = { hash: ref.hash, name, root, gain }; });
    preview(Math.round(root));
    say('"' + name + '" is now the ' + t.name + ' sound. ' + (found == null
      ? 'It has no clear pitch, so it plays as C4 on the C4 key.'
      : 'It was played at ' + E.noteName(Math.round(found)) + ', so every key plays it in tune.') + ' Play it from the keyboard or the piano roll.');
  }

  /* Record a sound with the microphone: press once to start, once to stop. Silence at the ends is trimmed. */
  let soundRec = null;
  async function toggleRecordSound() {
    if (soundRec) { soundRec.stop(); return; }
    if (!navigator.mediaDevices || !window.MediaRecorder) { say('This browser cannot record here. Load a sound file instead.', 'warn'); return; }
    let stream;
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } }); }
    catch (err) { say(micHelp(err), 'warn'); return; }
    const chunks = [], mr = new MediaRecorder(stream);
    mr.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
    mr.onstop = async () => {
      stream.getTracks().forEach((x) => x.stop());
      soundRec = null; clearTimeout(timer);
      $('smpRec').classList.remove('on'); $('smpRec').textContent = '\u25cf Record a sound';
      try {
        const raw = await audio().decodeAudioData(await new Blob(chunks).arrayBuffer());
        const trimmed = trimSilence(raw);
        if (!trimmed) { say('I did not hear anything. Sing or play one note close to the microphone.', 'warn'); return; }
        const wav = await SND.encodeWav(trimmed).arrayBuffer();
        useSamplerSound(wav, 'My sound ' + new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) + '.wav', 'audio/wav');
      } catch (err) { say('Could not use that recording: ' + (err && err.message ? err.message : err) + '.', 'warn'); }
    };
    mr.start();
    soundRec = mr;
    const timer = setTimeout(() => { if (soundRec) soundRec.stop(); }, 6000); // a sound, not a song
    $('smpRec').classList.add('on'); $('smpRec').textContent = '\u25a0 Stop';
    say('Recording a sound: sing or play one steady note (up to 6 seconds), then press Stop.');
  }
  /* cut leading and trailing silence; null if there is nothing */
  function trimSilence(buf) {
    const d = buf.getChannelData(0), sr = buf.sampleRate;
    let pk = 0;
    for (let i = 0; i < d.length; i++) pk = Math.max(pk, Math.abs(d[i]));
    if (pk < 0.01) return null;
    const th = pk * 0.06;
    let a = 0, z = d.length - 1;
    while (a < d.length && Math.abs(d[a]) < th) a++;
    while (z > a && Math.abs(d[z]) < th) z--;
    a = Math.max(0, a - Math.round(sr * 0.005)); z = Math.min(d.length - 1, z + Math.round(sr * 0.05));
    const n = z - a + 1;
    if (n < sr * 0.05) return null;
    const out = new AudioBuffer({ length: n, numberOfChannels: 1, sampleRate: sr });
    const o = out.getChannelData(0);
    for (let i = 0; i < n; i++) {
      // short fades so the cut never clicks
      const f = Math.min(1, i / (sr * 0.003), (n - i) / (sr * 0.02));
      o[i] = d[a + i] * f;
    }
    return out;
  }
  /* the Sampler line in the Shape row */
  function syncSampler() {
    const t = curTrack(), on = t.type === 'synth' && t.instrument === 'sampler';
    $('samplerBox').hidden = !on;
    if (!on) return;
    const sm = t.sampler;
    $('smpName').textContent = sm ? sm.name + (decoded.has(sm.hash) ? '' : ' (missing)') + ' · plays at ' + E.noteName(Math.round(sm.root)) : 'no sound yet: load a file or record one';
    $('smpName').classList.toggle('none', !sm);
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
    downloadBlob(new Blob([E.writeMidiTracks(tracks, P.bpm, P.mode === 'song' ? P.markers : [], P.mode === 'song' ? P.tempo : [])], { type: 'audio/midi' }), name);
    say('Saved ' + name + ' with ' + whatPlays() + ': ' + tracks.length + (tracks.length === 1 ? ' track' : ' tracks') + ', drums on channel 10. ' + (P.mode === 'song' && P.tempo.length ? 'The tempo changes are in the file too.' : 'Set your music program to ' + P.bpm + ' BPM.'));
  }

  /* Renders what Play plays to an AudioBuffer, a few seconds at a time: the renderer pauses at each chunk
     boundary, we add the next chunk's notes and report progress. Far fewer nodes exist at once, which also
     makes it much faster. `only` renders one track (a stem); `label` prefixes the progress message. */
  async function renderAudio(opts = {}) {
    const sr = 44100, { items, length: L } = PJ.playItems(P, P.mode), map = PJ.tempoMap(P, P.mode), secs = map.sec(L);
    const Ctx = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    if (!Ctx) throw new Error('this browser cannot render audio files');
    const label = opts.label || 'Rendering ' + whatPlays();
    const total = secs + 2.5;
    const oac = new Ctx(2, Math.ceil(total * sr), sr);
    const M = SND.createMixer(oac, { bpm: P.bpm, master: P.master, loud: P.loud, only: opts.only, lfoZero: 0.02 });
    M.live = null;
    for (const t of P.tracks) M.channel(t);
    const tOf = (b) => 0.02 + map.sec(b);
    const song = P.mode === 'song';
    // the song's tempo changes: the echo and the LFOs follow
    for (const z of map.seg.slice(1)) M.setBpm(z.bpm, tOf(z.b), tOf(z.b) - (z.b * 60) / z.bpm);
    const CHUNK = 3;
    let next = 0, k = 0;
    const scheduleChunk = () => {
      const a = next, b = Math.min(L, map.beat(++k * CHUNK));
      if (a < b) { scheduleEvents(oac, M, items, a, b, 0, tOf); if (song) scheduleAuto(M, a, b, 0, tOf); }
      next = Math.max(a, b);
    };
    let chunked = typeof oac.suspend === 'function';
    if (chunked) {
      try {
        scheduleChunk();
        for (let k = 1; k * CHUNK < secs; k++) {
          const at = k * CHUNK;
          oac.suspend(at).then(() => {
            if (chunked) scheduleChunk();
            say(label + '… ' + Math.round((at / total) * 100) + '%');
            oac.resume();
          });
        }
      } catch (err) { chunked = false; }
    }
    // no suspend support (or it failed): schedule whatever is left in one go
    if (!chunked && next < L) { scheduleEvents(oac, M, items, next, L, 0, tOf); if (song) scheduleAuto(M, next, L, 0, tOf); next = L; }
    const t0 = performance.now();
    const buf = await oac.startRendering();
    if (next < L - 1e-9) throw new Error('rendering stopped early');
    console.debug('BrowserDJ: rendered ' + total.toFixed(1) + ' s in ' + ((performance.now() - t0) / 1000).toFixed(1) + ' s');
    return { buf, secs };
  }

  async function exportWav() {
    stopAll();
    say('Rendering ' + whatPlays() + '…');
    $('wavBtn').disabled = true;
    try {
      const { buf, secs } = await renderAudio();
      downloadBlob(SND.encodeWav(buf), slug() + '.wav');
      say('Saved ' + slug() + '.wav with ' + whatPlays() + ' (' + secs.toFixed(1) + ' s' + (P.mode === 'song' && P.tempo.length ? ', starting at ' + P.bpm + ' BPM, with its tempo ' + (P.tempo.length === 1 ? 'change' : 'changes') : ' at ' + P.bpm + ' BPM') + ').');
    } catch (err) {
      say('Rendering failed: ' + (err && err.message ? err.message : err), 'warn');
    } finally {
      $('wavBtn').disabled = false;
    }
  }

  /* One WAV per track that plays something, each with its own effects, all the same length so they line up
     in another program. Drum kicks still drive the pump in the other stems. */
  async function exportStems() {
    stopAll();
    const { items } = PJ.playItems(P, P.mode);
    const tracks = P.tracks.filter((t) => !t.mute && items.some((it) => it.track === t));
    if (!tracks.length) { say('There is nothing to export in ' + whatPlays() + ' yet.', 'warn'); return; }
    $('stemsBtn').disabled = true; $('wavBtn').disabled = true;
    say('Rendering ' + tracks.length + ' stems. Your browser may ask once whether this page may download several files: allow it.');
    try {
      for (let i = 0; i < tracks.length; i++) {
        const t = tracks[i];
        const { buf } = await renderAudio({ only: t.id, label: 'Stem ' + (i + 1) + ' of ' + tracks.length + ': ' + t.name });
        const name = slug() + '-' + (i + 1) + '-' + (t.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'track') + '.wav';
        downloadBlob(SND.encodeWav(buf), name);
      }
      say('Saved ' + tracks.length + ' stems of ' + whatPlays() + ', one WAV per track, all the same length. Drop them into your music program at the start of the song.');
    } catch (err) {
      say('Rendering stems failed: ' + (err && err.message ? err.message : err), 'warn');
    } finally {
      $('stemsBtn').disabled = false; $('wavBtn').disabled = false;
    }
  }

  async function saveProject() {
    const name = prompt('Name this project', P.name === 'Untitled' || P.name === 'Example' ? '' : P.name);
    if (name === null) return;
    if (name.trim()) commit(() => { P.name = name.trim().slice(0, 80); });
    // your own sounds go inside the file so it opens complete anywhere
    const hashes = new Set();
    for (const ref of soundRefs()) hashes.add(ref.hash);
    const sampleData = await BDJ.Samples.pack([...hashes]);
    const n = Object.keys(sampleData).length;
    const file = n ? { ...P, sampleData } : P;
    downloadBlob(new Blob([JSON.stringify(file, null, n ? undefined : 1)], { type: 'application/json' }), slug() + '.browserdj.json');
    say('Saved ' + slug() + '.browserdj.json' + (n ? ' with ' + n + (n === 1 ? ' sample' : ' samples') + ' inside' : '') + '. Open it here any time to keep working.');
  }

  /* a MIDI file (from FL Studio or anywhere): tracks, patterns and clips, as one undo step */
  async function importMidi(file) {
    try {
      const obj = BDJ.MidiImport.toProject(new Uint8Array(await file.arrayBuffer()), file.name);
      stopAll();
      loadCommit(() => {
        P = PJ.normalize(obj); take = null; P.songId = BDJ.Library.newId();
        const k = PJ.detectKey(P, null); P.root = k.root; P.scale = k.scale;
      });
      patCursor = songCursor = 0;
      roll.sel.clear(); roll.fit(); playlist.fit();
      const synths = P.tracks.filter((t) => t.type === 'synth').length, drums = P.tracks.length - synths;
      say('Imported ' + file.name + ': ' + [synths && synths + (synths === 1 ? ' synth track' : ' synth tracks'), drums && drums + (drums === 1 ? ' drum track' : ' drum tracks')].filter(Boolean).join(' and ') +
        ', ' + P.patterns.length + ' patterns, ' + P.bpm + ' BPM. The sounds are a best guess from the file; change them in the editor. Undo brings back what you had.');
    } catch (err) {
      say('Could not import "' + file.name + '": ' + (err && err.message ? err.message : 'unreadable') + '.', 'warn');
    }
  }

  async function openProject(file) {
    try {
      const obj = JSON.parse(await file.text());
      stopAll();
      if (obj && obj.sampleData) await BDJ.Samples.unpack(obj.sampleData);
      loadCommit(() => { P = PJ.normalize(obj); take = null; P.songId = BDJ.Library.newId(); });
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

  /* ---------- example songs ----------
     The library lives in examples/examples.js, loaded the first time it is needed. A script tag works even
     when the page is opened straight from disk, where fetch() is not allowed. */
  const FIRST_EXAMPLE = 'firstlight';
  const TOUCH = window.matchMedia && window.matchMedia('(pointer: coarse)').matches; // a phone or tablet
  let examplesReady = null;
  function loadExamples() {
    if (BDJ.EXAMPLES) return Promise.resolve(BDJ.EXAMPLES);
    if (!examplesReady) {
      examplesReady = new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = 'examples/examples.js';
        s.onload = () => (BDJ.EXAMPLES ? resolve(BDJ.EXAMPLES) : reject(new Error('empty')));
        s.onerror = () => { examplesReady = null; s.remove(); reject(new Error('could not load the examples')); };
        document.head.appendChild(s);
      });
    }
    return examplesReady;
  }

  /* replace: swap it in without an undo step (first visit); otherwise undo brings the old project back */
  function openExample(ex, opts = {}) {
    stopAll();
    if (opts.replace) {
      P = PJ.normalize(ex.project); take = null; P.songId = BDJ.Library.newId();
      changed('all');
    } else {
      loadCommit(() => { P = PJ.normalize(ex.project); take = null; P.songId = BDJ.Library.newId(); });
    }
    ensureSamples();
    patCursor = songCursor = 0;
    roll.sel.clear(); roll.fit(); playlist.fit();
    say(opts.replace
      ? 'This is "' + ex.title + '", one of the example songs. ' + (TOUCH ? 'Tap Play to hear it, then tap any clip' : 'Press Space to play it, then click any clip') + ' to see how it is made.'
      : 'Loaded "' + ex.title + '". Press Space to play it; click any clip to see how it is made. Undo brings back what you had.');
  }

  const fmtLen = (s) => Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
  function closeExamples() {
    $('exPanel').hidden = true;
    $('examplesBtn').setAttribute('aria-expanded', 'false');
  }
  async function toggleExamples() {
    const panel = $('exPanel');
    if (!panel.hidden) { closeExamples(); return; }
    closeShare(); closeSongs();
    panel.hidden = false;
    $('examplesBtn').setAttribute('aria-expanded', 'true');
    panel.innerHTML = '<p class="exnote">Loading the example songs…</p>';
    let list = [];
    try { list = await loadExamples(); } catch (err) {
      panel.innerHTML = '<p class="exnote">The example songs could not be loaded here. Open a project file instead.</p>';
      return;
    }
    const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const items = list.map((ex) => `<button type="button" class="exitem" role="menuitem" data-ex="${esc(ex.id)}">` +
      `<span class="t">${esc(ex.title)}</span><span class="m">${ex.bpm} BPM · ${fmtLen(ex.secs)}</span>` +
      `<span class="b"><span class="s">${esc(ex.style)}</span> · ${esc(ex.blurb)}</span></button>`);
    items.push('<button type="button" class="exitem" role="menuitem" data-ex="starter"><span class="t">Starter</span><span class="m">124 BPM · 0:15</span>' +
      '<span class="b"><span class="s">House</span> · Drums, bass and a hook: a small song that is easy to take apart.</span></button>');
    panel.innerHTML = items.join('') + '<p class="exnote">Opening an example replaces what is loaded; Undo brings it back.</p>';
    const firstItem = panel.querySelector('.exitem');
    if (firstItem) firstItem.focus();
  }

  /* ---------- share links ----------
     The whole song travels in the link after '#s=' (compressed), so nothing is uploaded anywhere.
     Opened from disk, links point at the public site so they work for whoever gets them. */
  const SHARE_HOST = 'https://browserdj.dev/';
  const shareBase = () => (/^https?:$/.test(location.protocol) ? location.origin + location.pathname : SHARE_HOST);
  const sharedToken = () => { const m = /^#s=(.+)$/.exec(location.hash); return m ? m[1] : null; };

  async function openShared(token, replace) {
    try {
      const obj = await BDJ.Share.decode(token);
      stopAll();
      if (replace) { P = PJ.normalize(obj); take = null; P.songId = BDJ.Library.newId(); changed('all'); }
      else loadCommit(() => { P = PJ.normalize(obj); take = null; P.songId = BDJ.Library.newId(); });
      patCursor = songCursor = 0;
      roll.sel.clear(); roll.fit(); playlist.fit();
      say('Opened the shared song "' + P.name + '". Press Space to play it; everything in it is yours to change.' + (replace ? '' : ' Undo brings back what you had.'));
      ensureSamples(); // its maker's own drum sounds do not travel in a link; this explains if they are missing
    } catch (err) {
      say('This share link could not be opened (' + (err && err.message ? err.message : 'unreadable') + '). Maybe it got cut off when it was copied.', 'warn');
    } finally {
      try { history.replaceState(null, '', location.pathname + location.search); } catch (err) { /* fine */ }
    }
  }

  const fmtAgo = (t) => {
    const s = Math.round((Date.now() - t) / 1000);
    if (s < 45) return 'just now';
    if (s < 3600) return Math.round(s / 60) + ' min ago';
    if (s < 86400) return Math.round(s / 3600) + ' h ago';
    const d = Math.round(s / 86400);
    return d === 1 ? 'yesterday' : d < 30 ? d + ' days ago' : new Date(t).toLocaleDateString();
  };
  function closeSongs() { $('songsPanel').hidden = true; $('songsBtn').setAttribute('aria-expanded', 'false'); }
  async function renderSongs() {
    const panel = $('songsPanel');
    await flushLib();
    const list = await BDJ.Library.list();
    if (!list.length) {
      panel.innerHTML = '<p class="exnote">Nothing here yet. Songs appear here once you change something, and stay in this browser.</p>';
      return;
    }
    panel.innerHTML = list.map((x) => {
      const cur = x.id === P.songId;
      return '<div class="songrow' + (cur ? ' cur' : '') + '" data-song="' + x.id + '">' +
        '<button type="button" class="exitem" data-act="open" role="menuitem"><span class="t">' + escHtml(x.name) + (cur ? '<span class="nowtag">open now</span>' : '') + '</span>' +
        '<span class="m">' + x.bpm + ' BPM · ' + fmtLen(x.secs) + '</span><span class="b">' + fmtAgo(x.updated) + '</span></button>' +
        '<button type="button" class="tog" data-act="rename" title="Rename" aria-label="Rename ' + escHtml(x.name) + '">&#9998;</button>' +
        '<button type="button" class="tog x" data-act="delete" title="Delete from this list" aria-label="Delete ' + escHtml(x.name) + '">&times;</button></div>';
    }).join('') + '<p class="exnote">Kept in this browser. Use Save to keep a copy as a file.</p>';
  }
  async function toggleSongs() {
    const panel = $('songsPanel');
    if (!panel.hidden) { closeSongs(); return; }
    closeExamples(); closeShare();
    panel.hidden = false;
    $('songsBtn').setAttribute('aria-expanded', 'true');
    panel.innerHTML = '<p class="exnote">Loading…</p>';
    await renderSongs();
    const first = panel.querySelector('.exitem');
    if (first) first.focus();
  }
  async function openSong(id) {
    await flushLib();
    const obj = await BDJ.Library.get(id);
    if (!obj) { say('That song is no longer in this browser.', 'warn'); return; }
    stopAll();
    loadCommit(() => { P = PJ.normalize(obj); P.songId = id; take = null; });
    ensureSamples();
    patCursor = songCursor = 0;
    roll.sel.clear(); roll.fit(); playlist.fit();
    say('Opened "' + P.name + '". Undo brings back what you had open.');
  }

  function closeShare() { $('sharePanel').hidden = true; $('shareBtn').setAttribute('aria-expanded', 'false'); }
  async function toggleShare() {
    const panel = $('sharePanel');
    if (!panel.hidden) { closeShare(); return; }
    closeExamples(); closeSongs();
    panel.hidden = false;
    $('shareBtn').setAttribute('aria-expanded', 'true');
    panel.innerHTML = '<p class="exnote">Making a link…</p>';
    let link;
    try { link = shareBase() + '#s=' + (await BDJ.Share.encode(P)); } catch (err) {
      panel.innerHTML = '<p class="exnote">Could not make a link here: ' + (err && err.message ? err.message : 'unknown error') + '.</p>';
      return;
    }
    const ownSounds = soundRefs().length > 0; // drum samples and Sampler sounds stay home
    panel.innerHTML =
      '<p class="sharehead">Anyone with this link hears "' + escHtml(P.name) + '" and can change it. Nothing is uploaded: the song travels inside the link.</p>' +
      '<div class="sharerow"><input id="shareLink" type="text" readonly aria-label="Share link"><button id="shareCopy" class="btn primary small" type="button">Copy link</button></div>' +
      '<p class="exnote">' + link.length.toLocaleString() + ' characters.' +
      (location.protocol === 'file:' ? ' It opens on browserdj.dev.' : '') +
      (ownSounds ? ' Your own sounds do not fit in a link; there the built-in sounds play. Use Save to pass them on.' : '') + '</p>';
    const input = $('shareLink');
    input.value = link;
    input.focus(); input.select();
    $('shareCopy').addEventListener('click', async () => {
      let ok = false;
      try { await navigator.clipboard.writeText(link); ok = true; } catch (err) {
        input.focus(); input.select();
        try { ok = document.execCommand('copy'); } catch (e2) { ok = false; }
      }
      $('shareCopy').textContent = ok ? 'Copied!' : 'Press Ctrl+C';
      say(ok ? 'Share link copied. Paste it anywhere: chat, email, a post.' : 'The link is selected; press Ctrl+C to copy it.');
    });
  }
  const escHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  /* ---------- UI sync ---------- */
  const keyLabel = () => (P.scale === 'chromatic' ? 'no key' : E.NOTE_NAMES[P.root] + ' ' + E.SCALES[P.scale].name.toLowerCase());

  function refreshInfo() {
    const L = PJ.songBeats(P), bars = L / 4;
    $('songInfo').textContent = P.clips.length
      ? bars + (bars === 1 ? ' bar' : ' bars') + ' · ' + fmtTime(PJ.songSecs(P, 'song', L)) + ' · ' + keyLabel() + ' · ' + P.bpm + ' BPM' + (P.tempo.length ? ' (' + P.tempo.length + (P.tempo.length === 1 ? ' tempo change)' : ' tempo changes)') : '')
      : 'Empty song · ' + keyLabel() + ' · ' + P.bpm + ' BPM';
    const t = curTrack(), pat = curPat();
    const pb = PJ.patternBeats(pat) / 4;
    if (t.type === 'synth') {
      const n = pat.notes.length;
      $('patInfo').textContent = n + (n === 1 ? ' note' : ' notes') + ' · ' + pb + (pb === 1 ? ' bar' : ' bars');
    } else if (t.type === 'audio') {
      const au = pat.audio;
      $('patInfo').textContent = au ? (au.end - au.start).toFixed(1) + ' s · ' + (Math.round(pb * 10) / 10) + ' bars' : 'empty take';
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

  function syncCapMode() {
    const drums = P.capture.mode === 'drums';
    $('capMelody').classList.toggle('on', !drums); $('capMelody').setAttribute('aria-pressed', String(!drums));
    $('capDrums').classList.toggle('on', drums); $('capDrums').setAttribute('aria-pressed', String(drums));
    // the take settings (note detail, tuning...) are about humming
    $('takeRow').classList.toggle('drums', drums);
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
    syncCapMode();
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
    const synth = t.type === 'synth', audioT = t.type === 'audio';
    $('synthCtl').hidden = !synth;
    $('drumCtl').hidden = t.type !== 'drums';
    $('shapeBar').hidden = !synth;
    $('audioBar').hidden = !audioT;
    document.querySelector('.keysbar').hidden = audioT;
    if (audioT) syncAudioBar();
    else if (synth) {
      $('instrument').value = t.instrument;
      $('echo').checked = (t.echoSend || 0) > 0;
      syncShape();
      syncSampler();
    } else {
      $('drumBars').value = pat.bars;
      $('kitStyle').value = t.kitStyle || 'classic';
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
    glide: (v) => fmtSecs(SND.glideTime(v)),
  };
  function syncShape() {
    const sh = { ...SND.SHAPE, ...(curTrack().shape || {}) };
    for (const k of ['attack', 'release', 'tone', 'glide']) {
      const id = 'sh' + k[0].toUpperCase() + k.slice(1);
      $(id).value = Math.round(sh[k] * 100);
      $(id + 'Out').textContent = shapeText[k](sh[k]);
    }
    const lfo = curTrack().lfo || { target: 'off', rate: '1/8', depth: 0.6 };
    $('lfoTarget').value = lfo.target;
    $('lfoRate').value = lfo.rate;
    $('lfoDepth').value = Math.round(lfo.depth * 100);
    $('lfoDepthOut').textContent = Math.round(lfo.depth * 100);
    $('lfoRate').disabled = $('lfoDepth').disabled = lfo.target === 'off';
  }

  function renderEditor() {
    const type = curTrack().type, synth = type === 'synth';
    renderEditorHead();
    $('rollTools').hidden = !synth;
    $('rollWrap').hidden = !synth;
    $('rack').hidden = type !== 'drums';
    $('audioWrap').hidden = type !== 'audio';
    if (synth) roll.draw(); else if (type === 'audio') drawAudio(); else rack.render();
  }

  /* ---------- audio tracks ----------
     A take is a pattern whose audio is a recording in the sample store: pat.audio = {hash, name, secs, start, end,
     gain}. Its clip plays it once, from start to end (seconds into the file). Trimming keeps the sound where it is
     in the song: the clips move with the trimmed start. */
  var peakCache = new Map(); // (var: drawing can be asked for during start-up, before this line runs) hash -> {rate, data}: loudest sample per 1/200 s, for drawing
  function peaksFor(hash) {
    if (peakCache.has(hash)) return peakCache.get(hash);
    const buf = decoded.get(hash);
    if (!buf) return null;
    const rate = 200, blk = buf.sampleRate / rate, data = new Float32Array(Math.ceil(buf.length / blk));
    for (let c = 0; c < buf.numberOfChannels; c++) {
      const d = buf.getChannelData(c);
      for (let i = 0; i < d.length; i++) { const k = (i / blk) | 0, v = Math.abs(d[i]); if (v > data[k]) data[k] = v; }
    }
    const pk = { rate, data };
    peakCache.set(hash, pk);
    return pk;
  }
  function dbOf(g) { return g > 0 ? 20 * Math.log10(g) : -60; }
  function syncAudioBar() {
    const au = curPat().audio;
    const db = au ? Math.round(dbOf(au.gain) * 2) / 2 : 0;
    $('audGain').value = clamp(db, -24, 18);
    $('audGainOut').textContent = (db > 0 ? '+' : '') + db.toFixed(1) + ' dB';
    $('audGain').disabled = $('audTrim').disabled = !au;
  }

  /* Keeps a recording (bytes + decoded buffer) as a take on trackId, with a clip at beat `at`. */
  async function addTake(bytes, name, type, buffer, trackId, at, how) {
    let ref;
    try { ref = await BDJ.Samples.put(name, type, bytes); } catch (err) { say('Could not keep "' + name + '": ' + err.message + '.', 'warn'); return false; }
    decoded.set(ref.hash, buffer);
    // a comfortable level to start from: quiet recordings come up, loud files stay put
    const gain = clamp(0.8 / Math.max(0.01, peakOf(buffer)), 0.1, 8);
    let pat;
    commit(() => {
      const empty = PJ.patternsOf(P, trackId).find((x) => !x.audio && x.id === P.sel.patternId) || PJ.patternsOf(P, trackId).find((x) => !x.audio && !P.clips.some((c) => c.patternId === x.id));
      pat = empty || PJ.addPattern(P, trackId);
      pat.audio = { hash: ref.hash, name, secs: buffer.duration, start: 0, end: buffer.duration, gain };
      PJ.syncAudio(P);
      PJ.addClip(P, pat, at);
      PJ.select(P, trackId, pat.id);
    });
    playlist.remember(P.sel.trackId, P.sel.patternId);
    say(how + ' ' + buffer.duration.toFixed(1) + ' s into "' + pat.name + '" at bar ' + (Math.floor(at / 4) + 1) + '. Drag its edges below to trim, move the clip in the playlist, and set its level in the mixer.');
    return true;
  }

  /* A recording made over the song: from `anchor` (seconds into the capture) it lines up with the song marker. */
  async function audioIngest(ch, sr, anchor, trackId) {
    const from = Math.max(0, Math.round((anchor || 0) * sr)), n = ch.length - from;
    if (n < sr * 0.3) { say('That was too short: the recording starts after the count-in. Press Record and keep going for a bit.', 'warn'); return; }
    const buf = new AudioBuffer({ length: n, numberOfChannels: 1, sampleRate: sr });
    buf.getChannelData(0).set(ch.subarray(from));
    if (peakOf(buf) < 0.002) { say('I did not hear anything. Check that the right microphone is picked, then record again.', 'warn'); return; }
    const name = 'Recording ' + new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) + '.wav';
    const bytes = await SND.encodeWav(buf).arrayBuffer();
    await addTake(bytes, name, 'audio/wav', buf, trackId, songCursor, 'Recorded');
  }

  /* Moves the trim points of take `pat`, keeping the sound in place: clips shift with the start; clips that held
     the whole take keep holding all of it. o: the take and its clips as they were when the edit began. */
  function trimTake(pat, o, start, end) {
    const au = pat.audio;
    au.start = clamp(start, 0, au.secs - 0.05);
    au.end = clamp(end, au.start + 0.05, au.secs);
    PJ.syncAudio(P);
    const db = ((au.start - o.start) * P.bpm) / 60;
    for (const x of o.clips) {
      x.c.start = Math.max(0, x.start + db);
      x.c.len = x.full ? au.beats : Math.max(0.25, x.len - db);
    }
  }
  function trimState(pat) {
    const au = pat.audio;
    return { start: au.start, end: au.end, clips: P.clips.filter((c) => c.patternId === pat.id).map((c) => ({ c, start: c.start, len: c.len, full: c.len >= au.beats - 1e-6 })) };
  }

  var aview = $('audioView'), ag = aview.getContext('2d'), audDrag = null;
  var APAD = 14;
  function audX(au, W, t) { return APAD + (t / au.secs) * (W - 2 * APAD); }
  function audT(au, W, x) { return ((x - APAD) / (W - 2 * APAD)) * au.secs; }
  function drawAudio() {
    if (!ag || $('audioWrap').hidden || curTrack().type !== 'audio') return;
    const dpr = window.devicePixelRatio || 1, W = Math.max(200, aview.clientWidth), H = aview.clientHeight || 220;
    if (aview.width !== Math.round(W * dpr) || aview.height !== Math.round(H * dpr)) { aview.width = Math.round(W * dpr); aview.height = Math.round(H * dpr); }
    ag.setTransform(dpr, 0, 0, dpr, 0, 0);
    ag.clearRect(0, 0, W, H);
    const au = curPat().audio;
    $('audioEmpty').hidden = !!au;
    if (!au) return;
    const pk = peaksFor(au.hash), color = curTrack().color, spb = 60 / P.bpm, mid = (H - 18) / 2;
    // beats, counted from where the take starts (where its clip starts in the song)
    ag.fillStyle = 'rgba(255,255,255,0.06)';
    for (let k = -Math.floor(au.start / spb); au.start + k * spb <= au.secs; k++) {
      const x = Math.round(audX(au, W, au.start + k * spb));
      ag.fillStyle = k % 4 === 0 ? 'rgba(255,255,255,0.13)' : 'rgba(255,255,255,0.05)';
      ag.fillRect(x, 0, 1, H - 18);
    }
    if (!pk) {
      ag.fillStyle = 'rgba(255,255,255,0.5)'; ag.font = '13px ' + getComputedStyle(document.body).fontFamily;
      ag.fillText('"' + au.name + '" is not in this browser. Load it again, or open a saved project file that contains it.', APAD, mid);
      return;
    }
    for (let x = APAD; x < W - APAD; x++) {
      const a = audT(au, W, x), z = audT(au, W, x + 1);
      let m = 0;
      for (let i = Math.floor(a * pk.rate), e = Math.min(pk.data.length, Math.ceil(z * pk.rate)); i < e; i++) m = Math.max(m, pk.data[i]);
      const inside = (a + z) / 2 >= au.start && (a + z) / 2 <= au.end;
      const hh = Math.max(0.5, Math.min(1, m * au.gain) * (mid - 6));
      ag.fillStyle = inside ? color : 'rgba(255,255,255,0.18)';
      ag.fillRect(x, mid - hh, 1, hh * 2);
    }
    // trimmed-off parts are shaded, the edges have handles
    ag.fillStyle = 'rgba(10,9,16,0.55)';
    const xs = audX(au, W, au.start), xe = audX(au, W, au.end);
    ag.fillRect(0, 0, xs, H - 18); ag.fillRect(xe, 0, W - xe, H - 18);
    for (const x of [xs, xe]) {
      ag.fillStyle = '#fff'; ag.fillRect(Math.round(x) - 1, 0, 2, H - 18);
      ag.fillRect(Math.round(x) - 5, mid - 14, 10, 28);
    }
    // seconds along the bottom
    ag.fillStyle = 'rgba(255,255,255,0.45)'; ag.font = '11px ' + getComputedStyle(document.body).fontFamily;
    const step = au.secs > 120 ? 30 : au.secs > 40 ? 10 : au.secs > 12 ? 5 : 1;
    for (let t = 0; t <= au.secs + 1e-6; t += step) { const x = audX(au, W, t) + 3; if (x < W - 34) ag.fillText(fmtTime(t), x, H - 5); }
    // playhead
    const eb = editorPlayhead();
    if (eb != null && eb >= 0 && (T.on || TK)) {
      const t = au.start + eb * spb;
      if (t <= au.end) { ag.fillStyle = '#fff'; ag.fillRect(Math.round(audX(au, W, t)), 0, 2, H - 18); }
    }
  }
  function audEdgeAt(x) {
    const au = curPat().audio, W = aview.clientWidth;
    if (!au) return null;
    const ds = Math.abs(x - audX(au, W, au.start)), de = Math.abs(x - audX(au, W, au.end));
    if (Math.min(ds, de) > (TOUCH ? 22 : 12)) return null; // fingers get a wider handle
    return ds <= de ? 'start' : 'end';
  }
  aview.addEventListener('pointerdown', (e) => {
    const x = e.offsetX, edge = audEdgeAt(x), pat = curPat();
    if (!edge || !pat.audio) return;
    e.preventDefault();
    aview.setPointerCapture(e.pointerId);
    audDrag = { edge, pat, before: begin(), o: trimState(pat) };
  });
  aview.addEventListener('pointermove', (e) => {
    if (!audDrag) { aview.style.cursor = audEdgeAt(e.offsetX) ? 'ew-resize' : 'default'; return; }
    const { pat, o, edge } = audDrag, t = audT(pat.audio, aview.clientWidth, e.offsetX);
    trimTake(pat, o, edge === 'start' ? t : o.start, edge === 'end' ? t : o.end);
    refreshInfo(); drawAudio(); playlist.draw();
  });
  const audUp = () => {
    if (!audDrag) return;
    const d = audDrag;
    audDrag = null;
    end(d.before);
    changed('clips');
  };
  aview.addEventListener('pointerup', audUp);
  aview.addEventListener('pointercancel', audUp);
  window.addEventListener('resize', () => drawAudio());

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
    chord: () => $('chordType').value,
  });

  const rack = new BDJ.DrumRack($('rack'), {
    project: () => P,
    track: curTrack,
    pattern: curPat,
    begin, end, changed, previewDrum,
    rollMode: () => rollMode,
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
    peaks: peaksFor,
    status: say,
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
    masterChanged: () => {
      for (const M of [T.on && T.M, liveM]) if (M) { M.setMaster(P.master); M.setLoud(P.loud); }
    },
  });

  /* ---------- offline + install ----------
     On a real web address (not a file opened from disk) a service worker keeps the studio working offline.
     Where the browser offers it, Install app puts BrowserDJ on the desktop or home screen. */
  // the manifest is linked here, not in the HTML: a page opened from disk cannot load it and would log an error
  if (/^https?:$/.test(location.protocol)) {
    const m = document.createElement('link'); m.rel = 'manifest'; m.href = 'manifest.webmanifest'; document.head.appendChild(m);
  }
  if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol)) {
    window.addEventListener('load', () => { navigator.serviceWorker.register('sw.js').catch(() => { /* private mode or blocked: the site still works */ }); });
  }
  let installPrompt = null;
  window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installPrompt = e; $('installBtn').hidden = false; });
  window.addEventListener('appinstalled', () => { installPrompt = null; $('installBtn').hidden = true; say('BrowserDJ is installed. It works offline too.'); });
  $('installBtn').addEventListener('click', async () => {
    if (!installPrompt) return;
    const p = installPrompt; installPrompt = null;
    $('installBtn').hidden = true; // a prompt can be shown once; the browser offers a new one later if wanted
    p.prompt();
    await p.userChoice.catch(() => null);
  });

  window.BrowserDJ = { get project() { return P; }, get take() { return take; }, roll, rack, playlist, mixer, live, transport: T, get tour() { return tour; } };

  /* ---------- wiring ---------- */
  E.NOTE_NAMES.forEach((nm, i) => $('root').add(new Option(nm, i)));
  for (const k of ['major', 'minor', 'minorPent', 'majorPent', 'dorian', 'phrygian', 'harmonicMinor', 'chromatic']) $('scale').add(new Option(E.SCALES[k].name, k));
  for (const i of SND.INSTRUMENTS) $('instrument').add(new Option(i.name, i.id));
  for (const [k, pre] of Object.entries(PJ.PRESETS)) if (k !== 'empty') $('preset').add(new Option(pre.name, k));
  for (const k of SND.KITS) $('kitStyle').add(new Option(k.name, k.id));

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
  // example picker and welcome card
  on('examplesBtn', 'click', (e) => { e.stopPropagation(); toggleExamples(); });
  on('exPanel', 'click', (e) => {
    const b = e.target.closest('[data-ex]');
    if (!b) return;
    const id = b.dataset.ex;
    closeExamples();
    if (id === 'starter') { openExample({ title: 'Starter', project: PJ.example() }); return; }
    const ex = (BDJ.EXAMPLES || []).find((x) => x.id === id);
    if (ex) openExample(ex);
  });
  document.addEventListener('click', (e) => {
    if (!$('exPanel').hidden && !e.target.closest('.exwrap:not(.sharewrap):not(.songswrap)')) closeExamples();
    if (!$('sharePanel').hidden && !e.target.closest('.sharewrap')) closeShare();
    if (!$('songsPanel').hidden && !e.target.closest('.songswrap')) closeSongs();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (!$('exPanel').hidden) { closeExamples(); $('examplesBtn').focus(); }
    if (!$('sharePanel').hidden) { closeShare(); $('shareBtn').focus(); }
    if (!$('songsPanel').hidden) { closeSongs(); $('songsBtn').focus(); }
  });
  on('shareBtn', 'click', (e) => { e.stopPropagation(); toggleShare(); });
  on('songsBtn', 'click', (e) => { e.stopPropagation(); toggleSongs(); });
  on('songsPanel', 'click', async (e) => {
    const b = e.target.closest('[data-act]'), row = e.target.closest('[data-song]');
    if (!b || !row) return;
    const id = row.dataset.song;
    if (b.dataset.act === 'open') { closeSongs(); if (id !== P.songId) openSong(id); return; }
    if (b.dataset.act === 'rename') {
      const old = row.querySelector('.t').firstChild.textContent;
      const name = prompt('Rename this song', old);
      if (!name || !name.trim()) return;
      if (id === P.songId) commit(() => { P.name = name.trim().slice(0, 80); }); // saved by the edit
      else await BDJ.Library.rename(id, name.trim().slice(0, 80));
      await flushLib();
      renderSongs();
      return;
    }
    if (b.dataset.act === 'delete') {
      // a second click confirms
      if (!b.classList.contains('sure')) { b.classList.add('sure'); b.textContent = 'Delete?'; return; }
      await BDJ.Library.remove(id);
      say(id === P.songId ? 'Removed from My songs. It is still open; changing it adds it back.' : 'Removed from My songs.');
      renderSongs();
    }
  });
  // a share link pasted into this tab only changes the part after '#': no reload, so listen for it
  window.addEventListener('hashchange', () => { const t = sharedToken(); if (t) openShared(t, false); });
  const closeWelcome = () => {
    $('welcome').hidden = true;
    try { localStorage.setItem('browserdj.ui.welcomed', '1'); } catch (err) { /* storage blocked */ }
  };
  on('wClose', 'click', closeWelcome);
  on('wPlay', 'click', () => { closeWelcome(); if (!T.on) togglePlay(); });
  on('wExamples', 'click', (e) => { e.stopPropagation(); closeWelcome(); toggleExamples(); });
  on('wNew', 'click', () => { closeWelcome(); $('newBtn').click(); });

  /* ---------- the tour: six steps, each pointing at the real thing; doing it moves on ---------- */
  let tourKey = null;
  const patKey = () => { const pat = curPat(); return pat.id + ':' + JSON.stringify(pat.notes || pat.steps || pat.audio); };
  const tour = new BDJ.Tour([
    {
      target: () => $('playBtn'), title: 'Press Play',
      text: (TOUCH ? 'Tap <b>Play</b>' : 'Press <b>Play</b> (or Space)') + ' to hear the song. Every sound in it is made right here, in your browser: no samples, no server.',
      done: () => T.on,
    },
    {
      target: () => $('plCanvas').closest('section'), title: 'The playlist is your song',
      text: 'One row per track; each block is a pattern, placed where it plays. ' + (TOUCH ? '<b>Tap a block</b>' : '<b>Click a block</b>') + ' to open it in the editor below. Drag blocks to move them, drag a right edge to repeat one.',
      enter: () => { tourKey = P.sel.patternId; }, done: () => P.sel.patternId !== tourKey,
    },
    {
      // the editing surface itself (the whole editor is taller than a phone screen)
      target: () => $({ drums: 'rack', audio: 'audioWrap' }[curTrack().type] || 'rollWrap'), title: 'The editor: change anything',
      text: () => (curTrack().type === 'drums'
        ? (TOUCH ? 'Tap' : 'Click') + ' steps to switch drum hits on or off; right-click one for an accent. Try one while it plays.'
        : curTrack().type === 'audio' ? 'A recording: drag the edges of the waveform to trim it.'
          : (TOUCH ? 'Tap' : 'Click') + ' the grid to add a note and drag to move it' + (TOUCH ? '' : ', right-click to delete') + '. The keys on the left play the sound. Try adding a note.'),
      enter: () => { tourKey = patKey(); }, done: () => patKey() !== tourKey,
    },
    {
      target: () => document.querySelector('.capture'), title: 'Hum it, or beatbox it',
      text: 'Press <b>Record</b> and hum a tune: it becomes notes, in the song’s key. Switch to <b>Drums</b> and beatbox ("boots", "ka", "ts") to get a beat. Headphones help when you record over the song.',
    },
    {
      target: () => $('mixerBody').closest('section'), title: 'The mixer',
      text: 'Every track gets a strip: volume, a DJ filter, pan, drive, echo and reverb. <b>Pump</b> ducks a track on every kick, for that breathing dance-music feel.',
      enter: () => setMixerOpen(true),
    },
    {
      target: () => document.querySelector('.hactions'), title: 'Take it with you',
      text: '<b>Share</b> makes a link with the whole song inside it. <b>Export WAV</b> gives you audio; <b>Download MIDI</b> takes the notes into FL Studio, Ableton or anything else. <b>My songs</b> keeps everything you make in this browser.',
      last: true,
    },
  ], {
    onEnd: (finished) => say(finished
      ? 'That’s the tour. Make something: Undo is always there, and My songs keeps every song you work on.'
      : 'Tour closed. "Take the one-minute tour" in Mouse and keyboard, at the bottom of the page, brings it back.'),
  });
  on('wTour', 'click', () => { closeWelcome(); tour.start(); });
  on('helpTour', 'click', () => tour.start());

  on('newBtn', 'click', () => {
    stopAll();
    loadCommit(() => { P = PJ.blank(); take = null; P.songId = BDJ.Library.newId(); });
    patCursor = songCursor = 0; roll.sel.clear(); roll.fit(); playlist.fit();
    say('A fresh project with a melody track and a drum track. Hum something, draw notes, or load a drum pattern. Undo brings the old one back.');
  });
  on('openBtn', 'click', () => $('projectInput').click());
  on('projectInput', 'change', (e) => { const f = e.target.files[0]; if (f) loadFile(f); e.target.value = ''; });
  on('saveBtn', 'click', saveProject);
  on('midiBtn', 'click', exportMidi);
  on('wavBtn', 'click', exportWav);
  on('stemsBtn', 'click', exportStems);

  // capture
  on('recBtn', 'click', () => (R ? stopRec() : startRec()));
  on('fileBtn', 'click', () => $('fileInput').click());
  on('fileInput', 'change', (e) => { loadFile(e.target.files[0]); e.target.value = ''; });
  on('playBeat', 'change', () => { P.capture.playBeat = $('playBeat').checked; autosave(); });
  const setCapMode = (m) => {
    if (R) return; // not while recording
    P.capture.mode = m;
    syncCapMode();
    autosave();
    say(m === 'drums'
      ? 'Drums: Record listens for beatboxing. "Boots" is a kick, "ka" or "psh" a snare, "ts" a hi-hat; they become a drum pattern.'
      : 'Melody: Record listens for humming or singing; it becomes notes in a synth pattern.');
  };
  on('capMelody', 'click', () => setCapMode('melody'));
  on('capDrums', 'click', () => setCapMode('drums'));
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
  on('addAudio', 'click', () => {
    commit(() => { const t = PJ.addTrack(P, 'audio'); PJ.select(P, t.id); });
    say('Added an audio track. Put the song marker where you want to start, then Record over the song (headphones on), or load an audio file.');
  });
  on('audRec', 'click', () => (R ? stopRec() : startRec()));
  on('audLoad', 'click', () => $('fileInput').click());
  let gainBefore = null;
  on('audGain', 'input', () => {
    const au = curPat().audio;
    if (!au) return;
    if (gainBefore == null) gainBefore = begin();
    au.gain = Math.pow(10, +$('audGain').value / 20);
    syncAudioBar(); drawAudio(); playlist.draw();
  });
  on('audGain', 'change', () => { if (gainBefore != null) { end(gainBefore); gainBefore = null; autosave(); } });
  on('audTrim', 'click', () => {
    const pat = curPat(), au = pat.audio, buf = au && decoded.get(au.hash);
    if (!buf) return;
    const d = buf.getChannelData(0), sr = buf.sampleRate;
    let pk = 0;
    for (let i = Math.floor(au.start * sr); i < au.end * sr; i++) pk = Math.max(pk, Math.abs(d[i]));
    const th = pk * 0.04;
    let a = Math.floor(au.start * sr), z = Math.min(d.length, Math.ceil(au.end * sr)) - 1;
    while (a < z && Math.abs(d[a]) < th) a++;
    while (z > a && Math.abs(d[z]) < th) z--;
    const ns = Math.max(au.start, a / sr - 0.01), ne = Math.min(au.end, z / sr + 0.08);
    if (ne - ns < 0.05 || (ns - au.start < 0.005 && au.end - ne < 0.005)) { say('Nothing to trim: this take has no quiet start or end.'); return; }
    const cut = (ns - au.start) + (au.end - ne);
    commit(() => trimTake(pat, trimState(pat), ns, ne));
    say('Trimmed ' + cut.toFixed(2) + ' s of quiet from "' + pat.name + '". The sound stays where it was in the song.');
  });
  on('plFit', 'click', () => playlist.fit());
  on('makeUnique', 'click', () => playlist.makeUnique());
  // touchscreens have no right-click and no Delete key: these buttons are the way to delete there
  on('delClipsBtn', 'click', () => {
    const n = playlist.sel.size;
    if (!n) { say('Tap a clip to select it first (or drag a box around several with Ctrl), then Delete.', 'warn'); return; }
    playlist.deleteSelected();
    say('Deleted ' + n + (n === 1 ? ' clip' : ' clips') + '. Undo brings ' + (n === 1 ? 'it' : 'them') + ' back.');
  });
  on('delNotesBtn', 'click', () => {
    const n = roll.sel.size;
    if (!n) { say('Tap a note to select it first, then Delete.', 'warn'); return; }
    roll.deleteSel();
    say('Deleted ' + n + (n === 1 ? ' note' : ' notes') + '. Undo brings ' + (n === 1 ? 'it' : 'them') + ' back.');
  });
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
  on('instrument', 'change', () => {
    commit(() => { curTrack().instrument = $('instrument').value; });
    syncSampler();
    if ($('instrument').value === 'sampler' && !curTrack().sampler) say('Sampler: load a sound file or record one, and it plays in tune across the keyboard.');
    else preview(60);
  });
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
  on('slideBtn', 'click', () => {
    const r = roll.toggleSlide();
    if (!r) { say('Select the notes that should slide first (click, Shift+click, or Ctrl+drag a box), then press Slide.', 'warn'); return; }
    say(r > 0 ? 'Those notes now glide in from the note before them. Glide in the Shape row sets how long the slide takes.' : 'Slide off for those notes.');
  });
  on('arpBtn', 'click', () => {
    if (roll.arpeggiate($('arpMode').value)) say('Chords turned into arpeggios on the ' + (P.snap ? '1/' + P.snap : '1/16') + ' grid. Undo puts the chords back.');
    else say('Arpeggiate works on chords: notes that start at the same time. Draw some with Draw: Triad.', 'warn');
  });
  on('humanBtn', 'click', () => { roll.humanize(); say('Velocities loosened up a little. Do it again for more.'); });
  on('chordType', 'change', () => { try { localStorage.setItem('browserdj.ui.chord', $('chordType').value); } catch (err) { /* storage blocked */ } });
  try { const c = localStorage.getItem('browserdj.ui.chord'); if (c) $('chordType').value = c; } catch (err) { /* storage blocked */ }
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
  for (const k of ['attack', 'release', 'tone', 'glide']) {
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
      $(id).value = Math.round(SND.SHAPE[k] * 100);
      $(id).dispatchEvent(new Event('input'));
      $(id).dispatchEvent(new Event('change'));
    });
  }
  on('smpLoad', 'click', () => $('samplerInput').click());
  on('samplerInput', 'change', async (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (f) useSamplerSound(await f.arrayBuffer(), f.name, f.type);
  });
  on('smpRec', 'click', toggleRecordSound);
  on('shReset', 'click', () => { commit(() => { curTrack().shape = { ...SND.SHAPE }; }); preview(60); });

  // movement (LFO): heard right away while playing, and on held keys
  const lfoOf = () => { const t = curTrack(); return (t.lfo = t.lfo || { target: 'off', rate: '1/8', depth: 0.6 }); };
  const lfoLive = () => { const t = curTrack(); if (T.on && T.M) T.M.update(t); if (liveM) liveM.update(t); };
  on('lfoTarget', 'change', () => {
    commit(() => { lfoOf().target = $('lfoTarget').value; });
    lfoLive();
    const v = $('lfoTarget').value;
    if (v !== 'off') say((v === 'filter' ? 'Wobble' : v === 'volume' ? 'Tremolo' : 'Auto-pan') + ' on ' + curTrack().name + ', ' + $('lfoRate').selectedOptions[0].text + ' and locked to the tempo. Hold a long note to hear it.');
  });
  on('lfoRate', 'change', () => { commit(() => { lfoOf().rate = $('lfoRate').value; }); lfoLive(); });
  let lfoBefore = null;
  on('lfoDepth', 'input', () => {
    if (lfoBefore == null) lfoBefore = begin();
    lfoOf().depth = +$('lfoDepth').value / 100;
    $('lfoDepthOut').textContent = $('lfoDepth').value;
    lfoLive();
  });
  on('lfoDepth', 'change', () => { if (lfoBefore != null) { end(lfoBefore); lfoBefore = null; autosave(); } });

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
  on('kitStyle', 'change', () => {
    const t = curTrack(), v = $('kitStyle').value;
    commit(() => { t.kitStyle = v; });
    // a quick taste: kick, hat, snare, hat
    ['kick', 'chat', 'snare', 'chat'].forEach((id, i) => setTimeout(() => previewDrum(id, 110), i * 160));
    say('The ' + t.name + ' track now plays the ' + $('kitStyle').selectedOptions[0].text + ' kit. Your own sounds on a row stay as they are.');
  });
  // Rolls: while on, clicking a step makes it 2, 3 or 4 quick hits (a fourth click goes back to one)
  let rollMode = false;
  on('rollMode', 'click', () => {
    rollMode = !rollMode;
    $('rollMode').classList.toggle('on', rollMode);
    $('rollMode').setAttribute('aria-pressed', String(rollMode));
    say(rollMode ? 'Rolls: click a step to split it into 2, 3 or 4 quick hits; click again for more, a fourth time to go back. Turn Rolls off to paint steps again.' : 'Rolls off: clicking steps paints them again.');
  });
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
    : 'This is a small example song. Press Space to hear it. Click a clip in the playlist to edit its pattern below, or press Record and hum a new idea.');
  ensureSamples(); // your own drum sounds, from this browser's sample store

  // A link like ?example=gabber opens that song (undoable when it replaces your own project); the parameter is
  // then dropped from the address bar so a reload does not open it again over what you made since.
  // First visit: say hello, and swap the small built-in song for a full example (if the library loads).
  // ('browserdj.dev.plain' in local storage skips both, for automated tests.)
  let welcomed = false, plain = false;
  try { welcomed = localStorage.getItem('browserdj.ui.welcomed') === '1'; plain = localStorage.getItem('browserdj.dev.plain') === '1'; } catch (err) { /* storage blocked */ }
  const shared = sharedToken();
  if (shared) openShared(shared, !restored);
  const wanted = shared ? null : new URLSearchParams(location.search).get('example');
  if (wanted) {
    const dropParam = () => { try { history.replaceState(null, '', location.pathname + location.hash); } catch (err) { /* fine */ } };
    if (wanted === 'starter') { if (restored) openExample({ title: 'Starter', project: PJ.example() }); dropParam(); }
    else {
      loadExamples().then((list) => {
        const ex = list.find((x) => x.id === wanted);
        if (ex) openExample(ex, { replace: !restored });
        else say('There is no example called "' + wanted + '". The Examples button lists them all.', 'warn');
      }).catch(() => say('The example songs could not be loaded here.', 'warn')).finally(dropParam);
    }
  }
  if (!restored && !plain) {
    if (!welcomed) $('welcome').hidden = false;
    if (!wanted && !shared) {
      loadExamples().then((list) => {
        if (P.name !== 'Example' || H.undo.length) return; // the visitor already started on something
        const first = list.find((x) => x.id === FIRST_EXAMPLE) || list[0];
        if (first) openExample(first, { replace: true });
      }).catch(() => { /* the small built-in song stays */ });
    }
  }
})();
