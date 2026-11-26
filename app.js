(() => {
  'use strict';

  const KEY = 'gong-timer-v3';
  const MAX_PARTS = 6;
  const MAX_STRIKES = 12;
  const MINP = 15;              // shortest allowed part, seconds
  const LOOKAHEAD_MS = 20000;   // schedule audio this far ahead
  const RING_CIRC = 2 * Math.PI * 88;
  const WHEEL_ITEM_H = 44;      // must match .wheel-item height in styles.css
  const COPIES = 9, MID = 4;    // wheels repeat their numbers so they loop forever

  // total = whole time set on the dial; parts = how it is split, each with its own gongs
  const DEFAULTS = {
    total: 15 * 60,
    parts: [{ secs: 15 * 60, strikes: 1 }],
    volume: 100,   // percent, 10 to 300
    gap: 6,        // seconds between strikes within one part's gongs
    repeat: 1,
  };

  const $ = (id) => document.getElementById(id);
  const els = {
    pickerWrap: $('pickerWrap'),
    dial: $('dial'),
    progress: $('progress'),
    status: $('status'),
    countdown: $('countdown'),
    next: $('nextInfo'),
    start: $('startBtn'),
    stop: $('stopBtn'),
    test: $('testBtn'),
    partChips: $('partChips'),
    parts: $('parts'),
    totals: $('totalInfo'),
    volume: $('volume'),
    volOut: $('volOut'),
    gap: $('gap'),
    gapOut: $('gapOut'),
    repeat: $('repeat'),
    repOut: $('repOut'),
    wheels: {
      h: document.querySelector('.wheel[data-unit="h"]'),
      m: document.querySelector('.wheel[data-unit="m"]'),
      s: document.querySelector('.wheel[data-unit="s"]'),
    },
  };

  els.progress.style.strokeDasharray = RING_CIRC;

  let state = load();
  let pick = { h: 0, m: 15, s: 0 };   // what the wheels show
  let audio = null;     // { ctx, master, sample, ready }
  let session = null;   // { out, plan, startAt, queued, fired, timerId }
  let wakeLock = null;
  let starting = false;
  let doneTimer = null;

  // ---------- storage ----------
  function load() {
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem(KEY)); } catch (_) { /* ignore */ }
    const s = { ...structuredClone(DEFAULTS), ...(saved || {}) };
    s.parts = (Array.isArray(s.parts) && s.parts.length ? s.parts : structuredClone(DEFAULTS.parts))
      .slice(0, MAX_PARTS)
      .map((p) => ({ secs: Math.max(0, Math.floor(p.secs) || 0), strikes: Math.min(MAX_STRIKES, Math.max(1, p.strikes || 1)) }));
    const sum = s.parts.reduce((t, p) => t + p.secs, 0);
    if (!(s.total > 0) || sum !== s.total) {
      s.total = sum || DEFAULTS.total;
      if (!sum) s.parts = structuredClone(DEFAULTS.parts);
    }
    return s;
  }
  function save() {
    try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (_) { /* ignore */ }
  }

  // ---------- helpers ----------
  const isRunning = () => session !== null;
  const pad = (n) => String(n).padStart(2, '0');
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

  function fmt(ms) {
    const s = Math.max(0, Math.ceil(ms / 1000));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    return h ? `${h}:${pad(m)}:${pad(sec)}` : `${pad(m)}:${pad(sec)}`;
  }
  const fmtSecs = (secs) => fmt(secs * 1000);
  const pickSecs = () => pick.h * 3600 + pick.m * 60 + pick.s;
  const maxParts = () => Math.max(1, Math.min(MAX_PARTS, Math.floor(state.total / MINP)));

  // Every strike as milliseconds from Start. Part N's gongs ring when its time is up.
  function buildPlan() {
    const hits = [];
    let t = 0;
    for (let r = 0; r < state.repeat; r++) {
      for (const p of state.parts) {
        t += p.secs * 1000;
        for (let k = 0; k < p.strikes; k++) hits.push(t + k * state.gap * 1000);
      }
    }
    return hits.sort((a, b) => a - b);
  }

  // ---------- splitting the total ----------
  const sumBefore = (i) => state.parts.slice(0, i).reduce((t, p) => t + p.secs, 0);
  const maxFor = (i) => state.total - sumBefore(i) - (state.parts.length - 1 - i) * MINP;

  // keep every part within bounds and make the last part the remainder
  function normalize() {
    const n = state.parts.length;
    for (let i = 0; i < n - 1; i++) {
      state.parts[i].secs = clamp(state.parts[i].secs, MINP, Math.max(MINP, maxFor(i)));
    }
    state.parts[n - 1].secs = state.total - sumBefore(n - 1);
  }

  function equalSplit(n) {
    const old = state.parts;
    let base = Math.floor(state.total / n / MINP) * MINP;
    if (base < MINP || base * (n - 1) > state.total - MINP) base = Math.floor(state.total / n);
    state.parts = Array.from({ length: n }, (_, i) => ({
      secs: base,
      strikes: old[i] ? old[i].strikes : old[old.length - 1].strikes,
    }));
    normalize();
  }

  function setTotal(t) {
    const oldTotal = state.total;
    state.total = t;
    const n = Math.min(state.parts.length, maxParts());
    if (t === 0) { state.parts = state.parts.slice(0, 1); state.parts[0].secs = 0; return; }
    state.parts = state.parts.slice(0, n);
    if (oldTotal > 0) {
      const ratio = t / oldTotal;   // keep the same proportions when the total changes
      state.parts.forEach((p) => { p.secs = Math.max(MINP, Math.round((p.secs * ratio) / MINP) * MINP); });
    } else {
      state.parts.forEach((p) => { p.secs = Math.floor(t / n); });
    }
    normalize();
  }

  // ---------- audio ----------
  // Only your recorded gong (sounds/gong.mp3) is ever played.
  function getAudio() {
    if (!audio) {
      const AC = window.AudioContext || window.webkitAudioContext;
      const ctx = new AC();
      const master = ctx.createGain();
      const limiter = ctx.createDynamicsCompressor();
      limiter.threshold.value = -4;
      limiter.knee.value = 2;
      limiter.ratio.value = 12;
      limiter.attack.value = 0.002;
      limiter.release.value = 0.3;
      master.connect(limiter);
      limiter.connect(ctx.destination);
      audio = { ctx, master, sample: null, ready: null };
      audio.ready = loadSample(ctx).then((buf) => { audio.sample = buf; return buf; });
    }
    if (audio.ctx.state === 'suspended') audio.ctx.resume().catch(() => {});
    audio.master.gain.setTargetAtTime(state.volume / 100, audio.ctx.currentTime, 0.02);
    return audio;
  }

  async function loadSample(ctx) {
    try {
      const res = await fetch('sounds/gong.mp3', { cache: 'no-cache' });
      if (!res.ok) return null;
      return await ctx.decodeAudioData(await res.arrayBuffer());
    } catch (_) {
      return null;
    }
  }

  function strike(a, when, out) {
    if (!a.sample) return;
    const src = a.ctx.createBufferSource();
    src.buffer = a.sample;
    src.connect(out);
    src.start(when);
  }

  async function testGong() {
    const a = getAudio();
    await a.ready;
    if (!a.sample) { els.next.textContent = 'Gong sound file not found'; return; }
    const out = a.ctx.createGain();
    out.connect(a.master);
    strike(a, a.ctx.currentTime + 0.05, out);
    setTimeout(() => out.disconnect(), 12000);
  }

  // ---------- session ----------
  async function start() {
    if (isRunning() || starting) return;
    const plan = buildPlan();
    if (!plan.length) return;

    clearTimeout(doneTimer);
    starting = true;
    const a = getAudio();
    await a.ready;
    starting = false;
    if (!a.sample) { alert('Gong sound file (sounds/gong.mp3) was not found.'); return; }
    const out = a.ctx.createGain();
    out.connect(a.master);

    session = { out, plan, startAt: Date.now() + 250, queued: 0, fired: 0, timerId: null };
    session.timerId = setInterval(tick, 150);

    setMode(true);
    document.body.classList.add('is-running');
    els.start.disabled = true;
    els.stop.disabled = false;
    keepAwake(true);
    tick();
  }

  function stop() {
    if (!isRunning()) return;
    clearInterval(session.timerId);
    session.out.disconnect();   // silences anything still ringing
    session = null;
    finishUi(false);
  }

  function finish() {
    clearInterval(session.timerId);
    session = null;             // the last gong rings out; only the timer stops
    finishUi(true);
  }

  // Idle shows the wheels; running shows the countdown ring.
  function setMode(running) {
    els.pickerWrap.hidden = running;
    els.dial.hidden = !running;
    // hidden wheels lose their scroll position, so put them back where the values are
    if (!running) renderPicker();
  }

  function finishUi(completed) {
    document.body.classList.remove('is-running');
    els.stop.disabled = true;
    keepAwake(false);
    els.dial.classList.remove('hit');
    if (completed) {
      els.status.textContent = 'Complete';
      els.countdown.textContent = '00:00';
      els.next.textContent = 'Session finished';
      els.progress.style.strokeDashoffset = 0;
      els.start.disabled = false;
      // go back to the wheels so a new session can be started
      doneTimer = setTimeout(() => { if (!isRunning()) setMode(false); }, 3500);
    } else {
      setMode(false);
    }
    updateStart();
    renderTotals();
  }

  function updateStart() {
    els.start.disabled = isRunning() || starting || state.total === 0;
  }

  function tick() {
    if (!session) return;
    const now = Date.now();
    const { plan, startAt, out } = session;
    const a = audio;

    while (session.queued < plan.length && startAt + plan[session.queued] <= now + LOOKAHEAD_MS) {
      const delay = Math.max(0.01, (startAt + plan[session.queued] - now) / 1000);
      strike(a, a.ctx.currentTime + delay, out);
      session.queued++;
    }

    let fired = false;
    while (session.fired < plan.length && startAt + plan[session.fired] <= now) {
      session.fired++;
      fired = true;
    }
    if (fired) flash();

    if (session.fired >= plan.length) {
      finish();
      return;
    }

    const total = plan[plan.length - 1];
    const elapsed = now - startAt;
    const progress = total > 0 ? clamp(elapsed / total, 0, 1) : 1;
    els.progress.style.strokeDashoffset = RING_CIRC * (1 - progress);

    const untilNext = startAt + plan[session.fired] - now;
    els.status.textContent = session.fired === 0 ? 'First gong in' : 'Next gong in';
    els.countdown.textContent = fmt(untilNext);
    els.next.textContent = `Gong ${session.fired + 1} of ${plan.length}`;
  }

  function flash() {
    els.dial.classList.remove('hit');
    void els.dial.offsetWidth;
    els.dial.classList.add('hit');
  }

  async function keepAwake(on) {
    try {
      if (on) {
        if ('wakeLock' in navigator && document.visibilityState === 'visible') {
          if (wakeLock) await wakeLock.release().catch(() => {});
          wakeLock = await navigator.wakeLock.request('screen');
        }
      } else if (wakeLock) {
        const lock = wakeLock;
        wakeLock = null;
        await lock.release();
      }
    } catch (_) { /* optional */ }
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    if (isRunning()) { keepAwake(true); tick(); }
    if (audio && audio.ctx.state === 'suspended') audio.ctx.resume().catch(() => {});
  });

  // ---------- time wheels (loop forever) ----------
  const wheelSetters = {};
  function buildWheel(unit, max) {
    const wheel = els.wheels[unit];
    const list = wheel.querySelector('.wheel-list');
    const n = max + 1;
    list.innerHTML = Array.from({ length: COPIES * n }, (_, i) =>
      `<div class="wheel-item" data-v="${i % n}">${pad(i % n)}</div>`).join('');
    const items = [...list.children];
    let value = -1;
    let settle = null;
    const mark = (v) => items.forEach((el, i) => el.classList.toggle('on', i % n === v));

    list.addEventListener('scroll', () => {
      const idx = Math.round(list.scrollTop / WHEEL_ITEM_H);
      const v = ((idx % n) + n) % n;
      if (v !== value) {
        value = v;
        mark(v);
        pick[unit] = v;
        onWheelChange();
      }
      clearTimeout(settle);
      settle = setTimeout(() => {
        // after the wheel rests, jump back to the middle copy so it never runs out
        const i = Math.round(list.scrollTop / WHEEL_ITEM_H);
        if (i < n * 2 || i >= n * (COPIES - 2)) list.scrollTop = (MID * n + v) * WHEEL_ITEM_H;
      }, 150);
    }, { passive: true });

    wheelSetters[unit] = (v) => {
      value = v;
      mark(v);
      list.scrollTop = (MID * n + v) * WHEEL_ITEM_H;
    };
  }
  buildWheel('h', 23);
  buildWheel('m', 59);
  buildWheel('s', 59);

  function renderPicker() {
    pick = { h: Math.floor(state.total / 3600), m: Math.floor((state.total % 3600) / 60), s: state.total % 60 };
    wheelSetters.h(pick.h);
    wheelSetters.m(pick.m);
    wheelSetters.s(pick.s);
  }

  function onWheelChange() {
    if (isRunning()) return;
    const t = pickSecs();
    if (t === state.total) return;
    setTotal(t);
    save();
    renderPartChips();
    renderParts();
    renderTotals();
    updateStart();
  }

  // ---------- split into parts ----------
  function renderPartChips() {
    const max = maxParts();
    els.partChips.innerHTML = Array.from({ length: MAX_PARTS }, (_, i) => {
      const n = i + 1;
      const on = n === state.parts.length;
      return `<button class="chip-n${on ? ' on' : ''}" type="button" role="radio" aria-checked="${on}" data-n="${n}" ${n > max ? 'disabled' : ''}>${n}</button>`;
    }).join('');
  }

  els.partChips.addEventListener('click', (e) => {
    const btn = e.target.closest('.chip-n');
    if (!btn || btn.disabled || isRunning()) return;
    const n = Number(btn.dataset.n);
    if (n === state.parts.length) return;
    equalSplit(n);
    save();
    renderPartChips();
    renderParts();
    renderTotals();
  });

  function renderParts() {
    const n = state.parts.length;
    els.parts.innerHTML = state.parts.map((p, i) => {
      const last = i === n - 1;
      const timeLine = n === 1
        ? `<div class="line"><span class="lbl">Rings after</span><strong class="pt" data-i="${i}"></strong></div>`
        : last
          ? `<div class="line"><span class="lbl">Part ${i + 1} · rest</span><strong class="pt" data-i="${i}"></strong></div>`
          : `<div class="line"><span class="lbl">Part ${i + 1}</span><strong class="pt" data-i="${i}"></strong></div>
             <div class="line slider-line">
               <button class="step" data-act="tdec" type="button" aria-label="One minute less">−</button>
               <input class="pslider" data-i="${i}" type="range" min="${MINP}" step="${MINP}">
               <button class="step" data-act="tinc" type="button" aria-label="One minute more">+</button>
             </div>`;
      return `
      <li class="row" data-i="${i}">
        <span class="badge">${i + 1}</span>
        <div class="row-main">
          ${timeLine}
          <div class="line">
            <button class="step" data-act="dec" type="button" aria-label="One fewer gong">−</button>
            <span class="dots" aria-label="${p.strikes} gongs">${'<i></i>'.repeat(p.strikes)}</span>
            <button class="step" data-act="inc" type="button" aria-label="One more gong">+</button>
            <span class="unit">${p.strikes} gong${p.strikes === 1 ? '' : 's'}</span>
          </div>
        </div>
      </li>`;
    }).join('');
    updatePartTimes();
  }

  // update times and slider limits without rebuilding the rows (keeps a drag smooth)
  function updatePartTimes() {
    els.parts.querySelectorAll('.pt').forEach((el) => {
      el.textContent = fmtSecs(state.parts[Number(el.dataset.i)].secs);
    });
    els.parts.querySelectorAll('.pslider').forEach((el) => {
      const i = Number(el.dataset.i);
      el.max = Math.max(MINP, maxFor(i));
      el.value = state.parts[i].secs;
    });
    renderTotals();
  }

  els.parts.addEventListener('input', (e) => {
    const el = e.target.closest('.pslider');
    if (!el || isRunning()) return;
    state.parts[Number(el.dataset.i)].secs = Number(el.value);
    normalize();
    save();
    updatePartTimes();
  });

  els.parts.addEventListener('click', (e) => {
    if (isRunning()) return;
    const btn = e.target.closest('button[data-act]');
    const li = e.target.closest('li[data-i]');
    if (!btn || !li) return;
    const i = Number(li.dataset.i);
    const p = state.parts[i];
    switch (btn.dataset.act) {
      case 'tdec': p.secs = p.secs - 60; normalize(); save(); updatePartTimes(); return;
      case 'tinc': p.secs = p.secs + 60; normalize(); save(); updatePartTimes(); return;
      case 'inc': p.strikes = Math.min(MAX_STRIKES, p.strikes + 1); break;
      case 'dec': p.strikes = Math.max(1, p.strikes - 1); break;
    }
    save();
    renderParts();
  });

  function renderTotals() {
    const plan = buildPlan();
    const total = plan.length ? plan[plan.length - 1] : 0;
    els.totals.textContent = plan.length
      ? `${fmt(total)} · ${plan.length} gong${plan.length === 1 ? '' : 's'}`
      : '';
  }

  function renderIdle() {
    setMode(false);
    els.stop.disabled = true;
    updateStart();
  }

  function renderSound() {
    els.volume.value = state.volume;
    els.volOut.textContent = `${state.volume}%`;
    els.gap.value = state.gap;
    els.gapOut.textContent = `${state.gap} s`;
    els.repeat.value = state.repeat;
    els.repOut.textContent = `${state.repeat}×`;
  }

  // tap the finished dial to get the wheels back right away
  els.dial.addEventListener('click', () => { if (!isRunning()) { clearTimeout(doneTimer); setMode(false); } });

  els.volume.addEventListener('input', () => {
    state.volume = Number(els.volume.value);
    els.volOut.textContent = `${state.volume}%`;
    if (audio) audio.master.gain.setTargetAtTime(state.volume / 100, audio.ctx.currentTime, 0.02);
    save();
  });

  els.gap.addEventListener('input', () => {
    state.gap = Number(els.gap.value);
    els.gapOut.textContent = `${state.gap} s`;
    save();
    renderTotals();
  });

  els.repeat.addEventListener('input', () => {
    state.repeat = Number(els.repeat.value);
    els.repOut.textContent = `${state.repeat}×`;
    save();
    renderTotals();
  });

  els.start.addEventListener('click', start);
  els.stop.addEventListener('click', stop);
  els.test.addEventListener('click', testGong);

  // ---------- boot ----------
  renderSound();
  getAudio();            // start loading the gong right away
  renderPicker();
  renderPartChips();
  renderParts();
  renderIdle();

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js').catch(() => {});
    });
  }
})();
