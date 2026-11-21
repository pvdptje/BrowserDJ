/* BrowserDJ tour: a few steps that point at the real controls, one at a time.
   A step is {target: () => Element, title, text (or a function giving it), enter?: () => void, done?: () => bool, last?}. When done() turns true (the visitor
   did the thing), the tour moves on by itself; Next always works, Skip (or Escape) ends it.
   The page stays usable underneath: only the bubble takes clicks. */
window.BDJ = window.BDJ || {};
BDJ.Tour = (() => {
  'use strict';

  class Tour {
    constructor(steps, opts = {}) {
      this.steps = steps;
      this.opts = opts;
      this.i = -1;
      this.el = document.createElement('div');
      this.el.className = 'tour';
      this.el.innerHTML = '<div class="tring" aria-hidden="true"></div>' +
        '<div class="tbub" role="dialog" aria-modal="false" aria-labelledby="tourTitle">' +
        '<div class="tstep"></div><h3 id="tourTitle"></h3><p></p>' +
        '<div class="tact"><button type="button" class="btn small tskip">Skip tour</button><button type="button" class="btn small primary tnext">Next</button></div></div>';
      this.ring = this.el.querySelector('.tring');
      this.bub = this.el.querySelector('.tbub');
      this.el.querySelector('.tskip').addEventListener('click', () => this.end(false));
      this.el.querySelector('.tnext').addEventListener('click', () => this.next());
      this.onKey = (e) => { if (e.key === 'Escape') this.end(false); };
      this.onMove = () => this.place();
    }

    get on() { return this.i >= 0; }

    start() {
      if (this.on) return;
      document.body.appendChild(this.el);
      document.addEventListener('keydown', this.onKey);
      window.addEventListener('resize', this.onMove);
      window.addEventListener('scroll', this.onMove, true);
      this.show(0);
      this.timer = setInterval(() => this.tick(), 200);
    }

    show(i) {
      this.i = i;
      const s = this.steps[i];
      this.el.querySelector('.tstep').textContent = (i + 1) + ' of ' + this.steps.length;
      this.el.querySelector('h3').textContent = s.title;
      this.el.querySelector('p').innerHTML = typeof s.text === 'function' ? s.text() : s.text;
      this.el.querySelector('.tnext').textContent = s.last ? 'Finish' : s.done ? 'Skip this step' : 'Next';
      this.bub.classList.remove('did');
      this.waiting = false;
      if (s.enter) s.enter();
      const t = s.target();
      if (t) {
        const r = t.getBoundingClientRect();
        t.scrollIntoView({ block: r.height > window.innerHeight * 0.7 ? 'start' : 'center', behavior: 'smooth' });
      }
      this.place();
      setTimeout(() => this.place(), 450); // after the smooth scroll
      this.el.querySelector('.tnext').focus({ preventScroll: true });
    }

    tick() {
      if (!this.on) return;
      this.place();
      const s = this.steps[this.i];
      if (!this.waiting && s.done && s.done()) {
        // they did it: a moment to see it worked, then on
        this.waiting = true;
        this.bub.classList.add('did');
        this.el.querySelector('.tnext').textContent = s.last ? 'Finish' : 'Next';
        setTimeout(() => { if (this.on && this.steps[this.i] === s) this.next(); }, 900);
      }
    }

    next() {
      if (this.i + 1 >= this.steps.length) { this.end(true); return; }
      this.show(this.i + 1);
    }

    end(finished) {
      if (!this.on) return;
      this.i = -1;
      clearInterval(this.timer);
      document.removeEventListener('keydown', this.onKey);
      window.removeEventListener('resize', this.onMove);
      window.removeEventListener('scroll', this.onMove, true);
      this.el.remove();
      if (this.opts.onEnd) this.opts.onEnd(finished);
    }

    /* ring around the target, bubble below it (or above, or pinned to the bottom when neither fits) */
    place() {
      if (!this.on) return;
      const t = this.steps[this.i].target();
      const vw = window.innerWidth, vh = window.innerHeight, pad = 6, gap = 12;
      if (!t || !t.getClientRects().length) { this.ring.style.display = 'none'; this.pin(vw, vh); return; }
      const r = t.getBoundingClientRect();
      // still scrolling towards it (or it is off screen): no ring yet, the bubble waits at the bottom
      if (r.bottom < 8 || r.top > vh - 8) { this.ring.style.display = 'none'; this.pin(vw, vh); return; }
      const x = Math.max(4, r.left - pad), y = Math.max(4, r.top - pad);
      const w = Math.min(vw - 8, r.right + pad) - x, h = Math.min(vh - 8, r.bottom + pad) - y;
      Object.assign(this.ring.style, { display: 'block', left: x + 'px', top: y + 'px', width: Math.max(0, w) + 'px', height: Math.max(0, h) + 'px' });
      const bw = this.bub.offsetWidth, bh = this.bub.offsetHeight;
      const left = Math.min(Math.max(16, r.left + r.width / 2 - bw / 2), vw - bw - 16);
      let top;
      if (h <= 0) { this.pin(vw, vh); return; }
      if (y + h + gap + bh <= vh - 8) top = y + h + gap;
      else if (y - gap - bh >= 8) top = y - gap - bh;
      else { this.pin(vw, vh); return; }
      Object.assign(this.bub.style, { left: left + 'px', top: top + 'px', bottom: '' });
    }
    pin(vw, vh) {
      const bw = this.bub.offsetWidth;
      Object.assign(this.bub.style, { left: Math.max(16, (vw - bw) / 2) + 'px', top: '', bottom: '16px' });
    }
  }

  return Tour;
})();
