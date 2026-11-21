/* BrowserDJ beatbox: turns a recording of mouth drums ("boots", "ka", "ts") into kick, snare and hi-hat hits.
   1. onsets: energy in 5 ms frames; a hit is a sharp rise above the recent level (with a short dead time)
   2. sound:  spectral centroid of the first ~30 ms of each hit (where its energy sits, low to high)
   3. groups: the hits are clustered into dark / middle / bright relative to each other (1-D k-means on log
      centroid), so it adapts to any voice and microphone. Dark = kick, middle = snare, bright = hi-hat.
   Pure JS, no dependencies; runs in the browser and in Node (tests). */
(function (root) {
  'use strict';

  /* in-place radix-2 FFT on re/im arrays (length a power of two) */
  function fft(re, im) {
    const n = re.length;
    for (let i = 1, j = 0; i < n; i++) {
      let bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
    }
    for (let len = 2; len <= n; len <<= 1) {
      const ang = (-2 * Math.PI) / len, wr = Math.cos(ang), wi = Math.sin(ang);
      for (let i = 0; i < n; i += len) {
        let cr = 1, ci = 0;
        for (let k = 0; k < len / 2; k++) {
          const a = i + k, b = a + len / 2;
          const tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr;
          re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
          const ncr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = ncr;
        }
      }
    }
  }

  /* where the energy of samples[start..] sits, in Hz (Hann-windowed, 2048-point FFT, ~30 ms of sound) */
  function centroid(samples, start, sr) {
    const N = 2048, use = Math.min(N, Math.round(sr * 0.03));
    const re = new Float64Array(N), im = new Float64Array(N);
    for (let i = 0; i < use && start + i < samples.length; i++) re[i] = samples[start + i] * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (use - 1)));
    fft(re, im);
    let num = 0, den = 0;
    for (let k = 1; k < N / 2; k++) {
      const f = (k * sr) / N;
      if (f < 30) continue;
      const m = Math.hypot(re[k], im[k]);
      num += f * m; den += m;
    }
    return den > 0 ? num / den : 0;
  }

  /* hit times (seconds) and strengths */
  function onsets(samples, sr) {
    const hop = Math.round(sr * 0.005), n = Math.floor(samples.length / hop);
    const env = new Float32Array(n);
    for (let f = 0; f < n; f++) {
      let e = 0;
      for (let i = f * hop; i < (f + 1) * hop; i++) e += samples[i] * samples[i];
      env[f] = Math.sqrt(e / hop);
    }
    let peak = 0;
    for (const v of env) peak = Math.max(peak, v);
    if (peak < 0.005) return [];
    const floor = peak * 0.06, dead = Math.round(0.07 / 0.005); // 70 ms between hits
    const hits = [];
    let last = -1e9;
    for (let f = 2; f < n - 1; f++) {
      // compare with the quietest of the previous ~20 ms: a hit is a sharp rise
      let before = Infinity;
      for (let k = Math.max(0, f - 4); k < f; k++) before = Math.min(before, env[k]);
      const rise = env[f] - before;
      if (env[f] > floor && rise > Math.max(floor, before * 1.5) && env[f] >= env[f + 1] * 0.7 && f - last >= dead) {
        // walk back to where the rise starts, so the hit lands on the attack
        let s = f;
        while (s > 0 && env[s - 1] < env[s] && env[s - 1] > before * 1.2) s--;
        let strength = 0;
        for (let k = f; k < Math.min(n, f + 8); k++) strength = Math.max(strength, env[k]);
        hits.push({ t: s * 0.005, frame: s, strength });
        last = f;
      }
    }
    return hits.map((h) => ({ t: h.t, strength: h.strength / peak, c: centroid(samples, h.frame * hop, sr) }));
  }

  /* 1-D k-means on log values, k groups, started at spread-out percentiles; returns sorted centres */
  function kmeans(x, k) {
    const sorted = x.slice().sort((a, b) => a - b);
    const q = (p) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
    let m = k === 3 ? [q(0.1), q(0.5), q(0.9)] : [q(0.15), q(0.85)];
    for (let it = 0; it < 40; it++) {
      const sum = new Array(k).fill(0), cnt = new Array(k).fill(0);
      for (const v of x) { const b = nearest(v, m); sum[b] += v; cnt[b]++; }
      m = m.map((c, j) => (cnt[j] ? sum[j] / cnt[j] : c));
    }
    return m.sort((a, b) => a - b);
  }
  const nearest = (v, m) => { let b = 0; for (let j = 1; j < m.length; j++) if (Math.abs(v - m[j]) < Math.abs(v - m[b])) b = j; return b; };
  /* what a group of this brightness most likely is, when there are fewer than three groups */
  // a "boots" sits low, a "ka"/"psh" up to about 5 kHz, a "ts" well above 6 kHz
  const byBrightness = (hz) => (hz < 700 ? 0 : hz < 6000 ? 1 : 2);

  /* label per hit: 0 dark (kick), 1 middle (snare), 2 bright (hi-hat) */
  function groups(cs) {
    const x = cs.map((c) => Math.log(Math.max(40, c)));
    const lo = Math.min(...x), hi = Math.max(...x);
    // one kind of sound: name it by how bright it is
    if (x.length < 2 || hi - lo < 0.5) return x.map((v) => byBrightness(Math.exp(v)));
    const three = kmeans(x, 3);
    // three real groups need clear gaps between them (about 1.4x in frequency); otherwise use two
    if (x.length >= 3 && three[1] - three[0] > 0.33 && three[2] - three[1] > 0.33) return x.map((v) => nearest(v, three));
    const two = kmeans(x, 2);
    const darkAs = Math.min(1, byBrightness(Math.exp(two[0])));          // the darker group: kick, or snare at most
    const brightAs = Math.max(darkAs + 1, byBrightness(Math.exp(two[1]))); // the brighter one: snare or hi-hat
    return x.map((v) => (nearest(v, two) === 0 ? darkAs : brightAs));
  }

  /* samples (mono Float32Array), sample rate -> [{t (s), drum: 'kick'|'snare'|'chat', vel (1..127), centroid}] */
  function analyze(samples, sr) {
    const hits = onsets(samples, sr);
    if (!hits.length) return [];
    const label = groups(hits.map((h) => h.c));
    const DRUM = ['kick', 'snare', 'chat'];
    return hits.map((h, i) => ({ t: h.t, drum: DRUM[label[i]], vel: Math.max(40, Math.min(127, Math.round(50 + 77 * Math.sqrt(h.strength)))), centroid: Math.round(h.c) }));
  }

  /* hits -> drum steps: {bars, steps: {drum: [vel...]}, first} on a 16th grid. anchor (s) = where beat 0 is;
     without one, the first hit is beat 0. */
  function toSteps(hits, bpm, anchor) {
    if (!hits.length) return null;
    const zero = anchor != null ? anchor : hits[0].t;
    const at = hits.map((h) => ({ ...h, step: Math.round(((h.t - zero) * bpm) / 60 * 4) })).filter((h) => h.step >= 0);
    if (!at.length) return null;
    const lastStep = Math.max(...at.map((h) => h.step));
    const bars = Math.min(8, Math.max(1, Math.ceil((lastStep + 1) / 16)));
    const n = bars * 16, steps = { kick: new Array(n).fill(0), snare: new Array(n).fill(0), chat: new Array(n).fill(0) };
    for (const h of at) if (h.step < n) steps[h.drum][h.step] = Math.max(steps[h.drum][h.step], h.vel);
    return { bars, steps, count: at.filter((h) => h.step < n).length };
  }

  const api = { analyze, toSteps, onsets, centroid, groups, fft };
  root.BDJ = root.BDJ || {};
  root.BDJ.Beatbox = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
