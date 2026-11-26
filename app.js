(() => {
  'use strict';

  const KEY = 'gong-timer-v2';
  const MAX_STEPS = 20;
  const MAX_STRIKES = 12;
  const LOOKAHEAD_MS = 20000;   // schedule audio this far ahead
  const RING_CIRC = 2 * Math.PI * 88;
  const WHEEL_ITEM_H = 44;      // must match .wheel-item height in styles.css

  // A bell = { secs: delay before it rings (from the previous bell), strikes: gongs }
  const DEFAULTS = {
    steps: [{ secs: 15 * 60, strikes: 1 }],
    volume: 100,   // percent, 10 to 300
    gap: 6,        // seconds between strikes within one bell
    repeat: 1,     // how many times the whole schedule runs
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
    chips: $('gongChips'),
    tabs: $('tabs'),
    del: $('delBtn'),
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
  let pick = { h: 0, m: 15, s: 0, strikes: 1 };  // what the picker currently shows
  let audio = null;     // { ctx, master, sample, ready }
  let session = null;   // { out, plan, startAt, queued, fired, timerId }
  let wakeLock = null;
  let starting = false;
  let sel = 0;          // which duration is selected

  // ---------- storage ----------
  function load() {
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem(KEY)); } catch (_) { /* ignore */ }
    const s = { ...structuredClone(DEFAULTS), ...(saved || {}) };
    if (!Array.isArray(s.steps) || !s.steps.length) s.steps = structuredClone(DEFAULTS.steps);
    s.steps = s.steps.map((b) => ({
      secs: Number.isFinite(b.secs) ? b.secs : (b.min || 0) * 60 + (b.sec || 0),
      strikes: Math.min(MAX_STRIKES, Math.max(1, b.strikes || 1)),
    }));
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
  const hms = (secs) => `${Math.floor(secs / 3600)}:${pad(Math.floor((secs % 3600) / 60))}:${pad(secs % 60)}`;
  const pickSecs = () => pick.h * 3600 + pick.m * 60 + pick.s;

  // Every strike as milliseconds from Start. Each bell's delay counts from the previous bell.
  function buildPlan() {
    const hits = [];
    let t = 0;
    for (let r = 0; r < state.repeat; r++) {
      for (const b of state.steps) {
        t += b.secs * 1000;
        for (let k = 0; k < b.strikes; k++) hits.push(t + k * state.gap * 1000);
      }
    }
    return hits.sort((a, b) => a - b);
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
    } else {
      setMode(false);
    }
    renderTotals();
    renderTabs();
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

  // ---------- time wheels ----------
  // Each wheel is a scroll-snap list. The item under the middle band is the value.
  const wheelSetters = {};
  function buildWheel(unit, max) {
    const wheel = els.wheels[unit];
    const list = wheel.querySelector('.wheel-list');
    list.innerHTML = Array.from({ length: max + 1 }, (_, i) =>
      `<div class="wheel-item">${pad(i)}</div>`).join('');
    let value = 0;
    const mark = (v) => [...list.children].forEach((el, i) => el.classList.toggle('on', i === v));

    list.addEventListener('scroll', () => {
      const v = clamp(Math.round(list.scrollTop / WHEEL_ITEM_H), 0, max);
      if (v === value) return;
      value = v;
      mark(v);
      pick[unit] = v;
      state.steps[sel].secs = pickSecs();
      save();
      renderTabs();
    }, { passive: true });

    wheelSetters[unit] = (v) => {
      value = v;
      mark(v);
      list.scrollTop = v * WHEEL_ITEM_H;
    };
  }
  buildWheel('h', 23);
  buildWheel('m', 59);
  buildWheel('s', 59);

  function renderPicker() {
    wheelSetters.h(pick.h);
    wheelSetters.m(pick.m);
    wheelSetters.s(pick.s);
    renderChips();
  }

  // ---------- gong count chips ----------
  function buildChips() {
    els.chips.innerHTML = Array.from({ length: MAX_STRIKES }, (_, i) => {
      const n = i + 1;
      return `<button class="chip-n" type="button" role="radio" data-n="${n}" aria-label="${n} gong${n > 1 ? 's' : ''}">${n}</button>`;
    }).join('');
  }
  function renderChips() {
    [...els.chips.children].forEach((btn) => {
      const on = Number(btn.dataset.n) === pick.strikes;
      btn.classList.toggle('on', on);
      btn.setAttribute('aria-checked', String(on));
    });
  }
  els.chips.addEventListener('click', (e) => {
    const btn = e.target.closest('.chip-n');
    if (!btn || isRunning()) return;
    pick.strikes = Number(btn.dataset.n);
    state.steps[sel].strikes = pick.strikes;
    save();
    renderChips();
    renderTabs();
  });

  // ---------- durations (tabs) ----------
  // Each duration = a time (set on the wheels) + a number of gongs (chips).
  function selectDuration(i) {
    sel = clamp(i, 0, state.steps.length - 1);
    const b = state.steps[sel];
    pick = { h: Math.floor(b.secs / 3600), m: Math.floor((b.secs % 3600) / 60), s: b.secs % 60, strikes: b.strikes };
    renderPicker();
    renderTabs();
  }

  function renderTabs() {
    els.tabs.innerHTML = state.steps.map((b, i) => `
      <button class="tab${i === sel ? ' on' : ''}" data-i="${i}" type="button">
        <span class="tab-n">${i === 0 ? 'First' : 'Then'} ${i + 1}</span>
        <span class="tab-t">${hms(b.secs)} · ${b.strikes}×</span>
      </button>`).join('') +
      (state.steps.length < MAX_STEPS
        ? '<button class="tab add" data-add="1" type="button" aria-label="Add duration">+</button>' : '');
    els.del.hidden = state.steps.length < 2;
    const el = els.tabs.querySelector('.tab.on');
    if (el) el.scrollIntoView({ inline: 'nearest', block: 'nearest' });
    renderTotals();
    els.start.disabled = isRunning() || !state.steps.every((b) => b.secs > 0);
  }

  els.tabs.addEventListener('click', (e) => {
    if (isRunning()) return;
    if (e.target.closest('[data-add]')) {
      const last = state.steps[state.steps.length - 1];
      state.steps.push({ secs: last ? last.secs : 15 * 60, strikes: last ? last.strikes : 1 });
      save();
      selectDuration(state.steps.length - 1);
      return;
    }
    const t = e.target.closest('.tab[data-i]');
    if (t) selectDuration(Number(t.dataset.i));
  });

  els.del.addEventListener('click', () => {
    if (isRunning() || state.steps.length < 2) return;
    state.steps.splice(sel, 1);
    save();
    selectDuration(Math.min(sel, state.steps.length - 1));
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
  }

  function renderSound() {
    els.volume.value = state.volume;
    els.volOut.textContent = `${state.volume}%`;
    els.gap.value = state.gap;
    els.gapOut.textContent = `${state.gap} s`;
    els.repeat.value = state.repeat;
    els.repOut.textContent = `${state.repeat}×`;
  }

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
  buildChips();
  renderSound();
  getAudio();            // start loading the gong right away
  selectDuration(0);
  renderIdle();

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js').catch(() => {});
    });
  }
})();
