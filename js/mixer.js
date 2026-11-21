/* BrowserDJ mixer: one strip per track (fader, pan, echo send, mute/solo, level meter) and a master strip. */
window.BDJ = window.BDJ || {};
BDJ.Mixer = (() => {
  'use strict';
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const dbText = (g) => (g <= 0.0005 ? '−∞ dB' : (20 * Math.log10(g) >= 0 ? '+' : '') + (20 * Math.log10(g)).toFixed(1) + ' dB');
  const panText = (v) => (Math.abs(v) < 0.01 ? 'C' : (v < 0 ? 'L' : 'R') + Math.round(Math.abs(v) * 100));
  /* peak (linear) -> meter height 0..1 over a 48 dB range */
  const meterH = (pk) => (pk <= 0.00001 ? 0 : clamp((20 * Math.log10(pk) + 48) / 48, 0, 1));

  class Mixer {
    /* host: { project(), begin(), end(before), changed(kind), trackChanged(track), masterChanged(v), select(trackId) } */
    constructor(el, host) {
      this.el = el;
      this.host = host;
      this.shown = new Map(); // id -> smoothed meter height
      this.before = null;
      el.addEventListener('input', (e) => this.input(e));
      el.addEventListener('change', (e) => this.commit(e));
      el.addEventListener('click', (e) => this.click(e));
      el.addEventListener('dblclick', (e) => this.reset(e));
    }
    get p() { return this.host.project(); }

    render() {
      const p = this.p, anySolo = p.tracks.some((t) => t.solo), html = [];
      for (const t of p.tracks) {
        const on = t.id === p.sel.trackId, silent = t.mute || (anySolo && !t.solo);
        html.push(`<div class="strip${on ? ' on' : ''}${silent ? ' silent' : ''}" data-id="${t.id}" style="--tc:${t.color}">`);
        html.push(`<button type="button" class="sname" data-act="sel" title="Edit ${esc(t.name)}">${esc(t.name)}</button>`);
        html.push(this.faderHtml(t.volume, t.name));
        html.push(`<label class="knob"><span>Pan</span><input type="range" class="pan" min="-100" max="100" value="${Math.round((t.pan || 0) * 100)}" aria-label="${esc(t.name)} pan" title="Pan (double-click to centre)"><output>${panText(t.pan || 0)}</output></label>`);
        html.push(`<label class="knob"><span>Echo</span><input type="range" class="send" min="0" max="100" value="${Math.round((t.echoSend || 0) * 100)}" aria-label="${esc(t.name)} echo send" title="How much of this track goes into the echo"><output>${Math.round((t.echoSend || 0) * 100)}</output></label>`);
        html.push(`<div class="ms"><button type="button" class="tog${t.mute ? ' on' : ''}" data-act="mute" aria-pressed="${t.mute}" title="Mute">M</button><button type="button" class="tog solo${t.solo ? ' on' : ''}" data-act="solo" aria-pressed="${t.solo}" title="Solo">S</button></div>`);
        html.push('</div>');
      }
      html.push(`<div class="strip master" data-id="master">`);
      html.push(`<div class="sname">Master</div>`);
      html.push(this.faderHtml(p.master, 'Master'));
      html.push(`<p class="mnote">A limiter on the master keeps the mix from clipping.</p>`);
      html.push('</div>');
      this.el.innerHTML = html.join('');
      this.meters = new Map([...this.el.querySelectorAll('.strip')].map((s) => [s.dataset.id, s.querySelector('.mfill')]));
    }

    faderHtml(v, name) {
      return `<div class="fwrap"><div class="meter" aria-hidden="true"><div class="mfill"></div></div>` +
        `<input type="range" class="fader" min="0" max="100" value="${Math.round(v * 100)}" aria-label="${esc(name)} volume" title="Volume (double-click for the default)"></div>` +
        `<output class="db">${dbText(v)}</output>`;
    }

    stripOf(el) { const s = el.closest('.strip'); return s && s.dataset.id; }
    trackOf(id) { return id && id !== 'master' ? this.p.tracks.find((t) => t.id === +id) : null; }

    input(e) {
      const id = this.stripOf(e.target);
      if (!id) return;
      if (this.before == null) this.before = this.host.begin();
      const v = +e.target.value / 100, out = e.target.parentElement.querySelector('output');
      if (id === 'master') {
        this.p.master = v;
        e.target.closest('.strip').querySelector('.db').textContent = dbText(v);
        this.host.masterChanged(v);
        return;
      }
      const t = this.trackOf(id);
      if (e.target.classList.contains('fader')) { t.volume = v; e.target.closest('.strip').querySelector('.db').textContent = dbText(v); }
      else if (e.target.classList.contains('pan')) { t.pan = v; if (out) out.textContent = panText(v); }
      else if (e.target.classList.contains('send')) { t.echoSend = v; if (out) out.textContent = Math.round(v * 100); }
      this.host.trackChanged(t);
    }

    commit() {
      if (this.before == null) return;
      const b = this.before;
      this.before = null;
      this.host.end(b);
      this.host.changed('mix');
    }

    reset(e) {
      const id = this.stripOf(e.target);
      if (!id || e.target.tagName !== 'INPUT') return;
      const c = e.target.classList;
      const value = c.contains('pan') ? 0 : c.contains('fader') ? (id === 'master' ? 85 : 80) : null;
      if (value == null) return;
      e.target.value = value;
      this.input({ target: e.target });
      this.commit();
    }

    click(e) {
      const b = e.target.closest('[data-act]');
      if (!b) return;
      const t = this.trackOf(this.stripOf(b));
      if (!t) return;
      if (b.dataset.act === 'sel') { this.host.select(t.id); return; }
      const before = this.host.begin();
      if (b.dataset.act === 'mute') t.mute = !t.mute;
      if (b.dataset.act === 'solo') t.solo = !t.solo;
      this.host.end(before);
      this.host.changed('tracks');
    }

    markSelected() {
      for (const s of this.el.querySelectorAll('.strip[data-id]')) s.classList.toggle('on', +s.dataset.id === this.p.sel.trackId);
    }

    /* level(id | null) -> current peak; pass null to let the meters fall to zero */
    meter(level) {
      if (!this.meters) return;
      for (const [id, fill] of this.meters) {
        const target = level ? meterH(level(id === 'master' ? null : +id)) : 0;
        const prev = this.shown.get(id) || 0;
        const h = !level ? 0 : target > prev ? target : Math.max(target, prev - 0.025); // quick rise, slow fall
        if (Math.abs(h - prev) < 0.001 && h === 0) continue;
        this.shown.set(id, h);
        fill.style.transform = 'scaleY(' + h.toFixed(3) + ')';
        fill.classList.toggle('hot', h > 0.97);
      }
    }
  }

  return Mixer;
})();
