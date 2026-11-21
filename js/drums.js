/* BrowserDJ drum rack: a step sequencer, one row per drum sound.
   Click or drag across steps to paint, right-click a step to change its accent. */
window.BDJ = window.BDJ || {};
BDJ.DrumRack = (() => {
  'use strict';
  const ACCENTS = [100, 127, 60];

  class DrumRack {
    /* host: { project(), track(), pattern(), begin(), end(before), changed(kind), previewDrum(id), loadSample(id, file), clearSample(id), sampleName(id) } */
    constructor(el, host) {
      this.el = el;
      this.host = host;
      this.paint = null;
      this.cur = -1;
      this.el.addEventListener('contextmenu', (e) => { if (e.target.closest('.step')) e.preventDefault(); });
      this.el.addEventListener('pointerdown', (e) => this.down(e));
      this.el.addEventListener('pointermove', (e) => this.move(e));
      window.addEventListener('pointerup', () => this.up());
      window.addEventListener('pointercancel', () => this.up());
      this.el.addEventListener('click', (e) => this.click(e));
      this.el.addEventListener('input', (e) => this.input(e));
      this.el.addEventListener('change', (e) => this.commitInput(e));
      this.el.addEventListener('dragover', (e) => { if (e.target.closest('.drow')) { e.preventDefault(); e.stopPropagation(); e.target.closest('.drow').classList.add('drop'); } });
      this.el.addEventListener('dragleave', (e) => { const r = e.target.closest('.drow'); if (r) r.classList.remove('drop'); });
      this.el.addEventListener('drop', (e) => {
        const r = e.target.closest('.drow');
        if (!r) return;
        e.preventDefault(); e.stopPropagation();
        r.classList.remove('drop');
        document.body.classList.remove('dropping');
        const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
        if (f) this.host.loadSample(r.dataset.id, f);
      });
    }

    get p() { return this.host.project(); }
    get kit() { return this.host.track().kit; }
    steps(id) { const pat = this.host.pattern(); return pat.steps[id] || (pat.steps[id] = new Array(pat.bars * BDJ.Project.STEPS_PER_BAR).fill(0)); }

    render() {
      if (!this.host.track().kit) { this.el.innerHTML = ''; return; } // a synth track is selected
      const n = this.host.pattern().bars * BDJ.Project.STEPS_PER_BAR;
      const anySolo = this.kit.some((r) => r.solo);
      const html = [];
      for (const row of this.kit) {
        const steps = this.steps(row.id);
        const def = BDJ.Sound.DRUMS.find((d) => d.id === row.id);
        const sample = this.host.sampleName(row.id);
        const silent = row.mute || (anySolo && !row.solo);
        html.push(`<div class="drow${silent ? ' silent' : ''}" data-id="${row.id}">`);
        html.push(`<div class="dhead">`);
        // "(missing)" is shown on its own so shortening a long name can never hide it
        const missing = !!sample && / \(missing\)$/.test(sample), base = sample ? sample.replace(/ \(missing\)$/, '') : '';
        const tip = sample ? (missing ? 'This browser does not have ' + esc(base) + '. Drop the file on this row again, or open a saved project that contains it. ' : 'Sample: ' + esc(base) + '. ') : '';
        html.push(`<button type="button" class="dname" data-act="hit" title="${tip}Click to hear it. Drop an audio file on this row to use your own sound.">${esc(def.name)}${sample ? '<i>' + esc(shorten(base)) + '</i>' : ''}${missing ? '<b class="miss">missing</b>' : ''}</button>`);
        html.push(`<button type="button" class="tog${row.mute ? ' on' : ''}" data-act="mute" aria-pressed="${row.mute}" title="Mute">M</button>`);
        html.push(`<button type="button" class="tog solo${row.solo ? ' on' : ''}" data-act="solo" aria-pressed="${row.solo}" title="Solo">S</button>`);
        html.push(`<input type="range" class="dvol" min="0" max="100" value="${Math.round(row.vol * 100)}" aria-label="${esc(def.name)} volume" title="Volume">`);
        html.push(`<button type="button" class="tog small" data-act="${sample ? 'unsample' : 'sample'}" title="${sample ? 'Go back to the built-in sound' : 'Use your own sound file'}">${sample ? '&times;' : '&#8613;'}</button>`);
        html.push(`</div><div class="steps">`);
        for (let i = 0; i < n; i++) {
          const v = steps[i] || 0;
          const cls = 'step' + (v ? ' on' : '') + (v >= 127 ? ' acc' : v && v < 80 ? ' ghost' : '') + (Math.floor(i / 4) % 2 ? ' alt' : '') + (i === this.cur ? ' now' : '');
          html.push(`<button type="button" class="${cls}" data-i="${i}" aria-label="${esc(def.name)} step ${i + 1}" aria-pressed="${!!v}"></button>`);
        }
        html.push(`</div></div>`);
      }
      this.el.innerHTML = html.join('');
      this.el.style.setProperty('--steps', n);
    }

    /* briefly light up a row's name when it is played live */
    flash(id) {
      const b = this.el.querySelector(`.drow[data-id="${id}"] .dname`);
      if (!b) return;
      b.classList.remove('hit');
      void b.offsetWidth; // restart the animation
      b.classList.add('hit');
    }

    setPlayhead(i) {
      if (i === this.cur) return;
      for (const b of this.el.querySelectorAll('.step.now')) b.classList.remove('now');
      this.cur = i;
      if (i < 0) return;
      for (const b of this.el.querySelectorAll(`.step[data-i="${i}"]`)) b.classList.add('now');
    }

    rowOf(el) { const r = el.closest('.drow'); return r && this.kit.find((x) => x.id === r.dataset.id); }

    down(e) {
      const st = e.target.closest('.step');
      if (!st) return;
      e.preventDefault();
      const row = this.rowOf(st), i = +st.dataset.i;
      const before = this.host.begin();
      if (e.button === 2 || e.altKey) {
        const st = this.steps(row.id), v = st[i];
        st[i] = v ? ACCENTS[(ACCENTS.indexOf(v) + 1) % ACCENTS.length] || 100 : 127;
        this.host.end(before);
        this.host.changed('drums');
        this.render();
        return;
      }
      const val = this.steps(row.id)[i] ? 0 : 100;
      this.paint = { val, before, touched: new Set() };
      this.apply(st);
      if (val) this.host.previewDrum(row.id, val);
    }

    move(e) {
      if (!this.paint) return;
      const el = document.elementFromPoint(e.clientX, e.clientY);
      const st = el && el.closest && el.closest('.step');
      if (st && this.el.contains(st)) this.apply(st);
    }

    apply(st) {
      const key = st.closest('.drow').dataset.id + ':' + st.dataset.i;
      if (this.paint.touched.has(key)) return;
      this.paint.touched.add(key);
      const row = this.rowOf(st), i = +st.dataset.i;
      this.steps(row.id)[i] = this.paint.val;
      st.classList.toggle('on', !!this.paint.val);
      st.classList.remove('acc', 'ghost');
      st.setAttribute('aria-pressed', String(!!this.paint.val));
      this.host.changed('live');
    }

    up() {
      if (!this.paint) return;
      const P = this.paint;
      this.paint = null;
      this.host.end(P.before);
      this.host.changed('drums');
    }

    click(e) {
      const b = e.target.closest('[data-act]');
      if (!b) return;
      const row = this.rowOf(b), act = b.dataset.act;
      if (act === 'hit') { this.host.previewDrum(row.id, 110); return; }
      if (act === 'sample') { this.host.pickSample(row.id); return; }
      if (act === 'unsample') { this.host.clearSample(row.id); return; }
      const before = this.host.begin();
      if (act === 'mute') row.mute = !row.mute;
      if (act === 'solo') row.solo = !row.solo;
      this.host.end(before);
      this.host.changed('drums');
      this.render();
    }

    input(e) {
      if (!e.target.classList.contains('dvol')) return;
      const row = this.rowOf(e.target);
      if (this.volBefore == null) this.volBefore = this.host.begin();
      row.vol = +e.target.value / 100;
      this.host.changed('live');
    }
    commitInput(e) {
      if (!e.target.classList.contains('dvol') || this.volBefore == null) return;
      this.host.end(this.volBefore);
      this.volBefore = null;
      this.host.changed('drums');
    }
  }

  function esc(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
  function shorten(s) { s = s.replace(/\.[a-z0-9]+$/i, ''); return s.length > 12 ? s.slice(0, 11) + '…' : s; }

  return DrumRack;
})();
