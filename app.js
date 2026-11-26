(() => {
  'use strict';

  const KEY = 'gong-timer-v1';
  const MAX_STEPS = 20;
  const MAX_STRIKES = 12;
  const LOOKAHEAD_MS = 20000;   // schedule audio this far ahead
  const RING_CIRC = 2 * Math.PI * 88;

  const DEFAULTS = {
    steps: [
      { min: 15, sec: 0, strikes: 1 },
      { min: 15, sec: 0, strikes: 2 },
      { min: 15, sec: 0, strikes: 3 },
      { min: 15, sec: 0, strikes: 4 },
    ],
    volume: 100,   // percent, 10 to 300
    gap: 6,        // seconds between strikes within one bell
    repeat: 1,     // how many times the whole schedule runs
  };

  // Synth gong (used only if no recording is found in sounds/gong.mp3).
  // Deep fundamental, slow swelling attack, long warm decay, soft mallet thump.
  // [ratio, level, decay seconds, attack seconds]
  const PARTIALS = [
    [1.00, 1.00, 24, 0.10],
    [1.42, 0.55, 20, 0.14],
    [1.98, 0.40, 16, 0.18],
    [2.61, 0.28, 13, 0.22],
    [3.12, 0.20, 10, 0.26],
    [3.95, 0.13, 8, 0.30],
    [4.84, 0.08, 6, 0.34],
  ];
  const BASE_HZ = 62;

  const $ = (id) => document.getElementById(id);
  const els = {
    rows: $('rows'),
    add: $('addBtn'),
    start: $('startBtn'),
    stop: $('stopBtn'),
    test: $('testBtn'),
    dial: $('dial'),
    progress: $('progress'),
    status: $('status'),
    countdown: $('countdown'),
    next: $('nextInfo'),
    totals: $('totalInfo'),
    volume: $('volume'),
    volOut: $('volOut'),
    gap: $('gap'),
    gapOut: $('gapOut'),
    repeat: $('repeat'),
    repOut: $('repOut'),
  };

  els.progress.style.strokeDasharray = RING_CIRC;

  let state = load();
  let audio = null;     // { ctx, master, noise }
  let session = null;   // { out, plan, startAt, queued, fired, timerId }
  let wakeLock = null;

  // ---------- storage ----------
  function load() {
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem(KEY)); } catch (_) { /* ignore */ }
    const s = { ...structuredClone(DEFAULTS), ...(saved || {}) };
    if (!Array.isArray(s.steps) || !s.steps.length) s.steps = structuredClone(DEFAULTS.steps);
    return s;
  }
  function save() {
    try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (_) { /* ignore */ }
  }

  // ---------- helpers ----------
  const isRunning = () => session !== null;
  const pad = (n) => String(n).padStart(2, '0');
  function fmt(ms) {
    const s = Math.max(0, Math.ceil(ms / 1000));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    return h ? `${h}:${pad(m)}:${pad(sec)}` : `${pad(m)}:${pad(sec)}`;
  }

  // Flat list of every strike, as milliseconds from the start of the session.
  // Each bell's delay is measured from the previous bell (the first from Start).
  function buildPlan() {
    const hits = [];
    let t = 0;
    for (let r = 0; r < state.repeat; r++) {
      for (const s of state.steps) {
        t += (s.min * 60 + s.sec) * 1000;
        for (let k = 0; k < s.strikes; k++) hits.push(t + k * state.gap * 1000);
      }
    }
    return hits.sort((a, b) => a - b);
  }

  // ---------- audio ----------
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

      // one shared burst of noise for the mallet-strike transient
      const len = Math.floor(ctx.sampleRate * 0.3);
      const noise = ctx.createBuffer(1, len, ctx.sampleRate);
      const data = noise.getChannelData(0);
      for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;

      audio = { ctx, master, noise, sample: null };
      // A real recording of your gong, if you add one at sounds/gong.mp3 in the repo.
      loadSample(ctx).then((buf) => { if (audio) audio.sample = buf; });
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
    const { ctx, noise } = a;

    // Prefer the recorded gong when it is present.
    if (a.sample) {
      const src = ctx.createBufferSource();
      src.buffer = a.sample;
      src.connect(out);
      src.start(when);
      return;
    }

    // Soft, warm lowpass so the tone never gets metallic or harsh.
    const warm = ctx.createBiquadFilter();
    warm.type = 'lowpass';
    warm.frequency.value = 2400;
    warm.Q.value = 0.4;
    warm.connect(out);

    PARTIALS.forEach(([ratio, level, decay, attack], i) => {
      // two detuned sines per partial: the slow shimmer and swell of a real gong
      for (const detune of [-0.7, 0.7]) {
        const osc = ctx.createOscillator();
        const env = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.value = BASE_HZ * ratio + detune * (1 + i * 0.2);
        env.gain.setValueAtTime(0.0001, when);
        env.gain.linearRampToValueAtTime(level * 0.12, when + attack);
        env.gain.exponentialRampToValueAtTime(0.0001, when + decay);
        osc.connect(env).connect(warm);
        osc.start(when);
        osc.stop(when + decay + 0.05);
      }
    });

    // soft mallet thump: a low, short noise burst
    const src = ctx.createBufferSource();
    src.buffer = noise;
    const band = ctx.createBiquadFilter();
    band.type = 'bandpass';
    band.frequency.value = 380;
    band.Q.value = 0.6;
    const env = ctx.createGain();
    env.gain.setValueAtTime(0.25, when);
    env.gain.exponentialRampToValueAtTime(0.0001, when + 0.25);
    src.connect(band).connect(env).connect(out);
    src.start(when);
    src.stop(when + 0.3);
  }

  function testGong() {
    const a = getAudio();
    const out = a.ctx.createGain();
    out.connect(a.master);
    strike(a, a.ctx.currentTime + 0.05, out);
    setTimeout(() => out.disconnect(), 14000);
  }

  // ---------- session ----------
  function start() {
    if (isRunning()) return;
    const plan = buildPlan();
    if (!plan.length) return;

    const a = getAudio();
    const out = a.ctx.createGain();
    out.connect(a.master);

    session = {
      out,
      plan,
      startAt: Date.now() + 250,
      queued: 0,
      fired: 0,
      timerId: null,
    };
    session.timerId = setInterval(tick, 150);

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
    // the last gong keeps ringing out; only the timer stops
    session = null;
    finishUi(true);
  }

  function finishUi(completed) {
    document.body.classList.remove('is-running');
    els.start.disabled = false;
    els.stop.disabled = true;
    keepAwake(false);
    els.progress.style.strokeDashoffset = completed ? 0 : RING_CIRC;
    els.dial.classList.remove('hit');
    if (completed) {
      els.status.textContent = 'Complete';
      els.countdown.textContent = '00:00';
      els.next.textContent = 'Session finished';
    } else {
      renderIdle();
    }
  }

  function tick() {
    if (!session) return;
    const now = Date.now();
    const { plan, startAt, out } = session;
    const a = audio;

    // queue upcoming strikes into the audio timeline
    while (session.queued < plan.length && startAt + plan[session.queued] <= now + LOOKAHEAD_MS) {
      const delay = Math.max(0.01, (startAt + plan[session.queued] - now) / 1000);
      strike(a, a.ctx.currentTime + delay, out);
      session.queued++;
    }

    // visual: count strikes that have passed
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
    const progress = total > 0 ? Math.min(1, Math.max(0, elapsed / total)) : 1;
    els.progress.style.strokeDashoffset = RING_CIRC * (1 - progress);

    const untilNext = startAt + plan[session.fired] - now;
    els.status.textContent = session.fired === 0 ? 'First gong in' : 'Next gong in';
    els.countdown.textContent = fmt(untilNext);
    els.next.textContent = `Gong ${session.fired + 1} of ${plan.length}`;
  }

  function flash() {
    els.dial.classList.remove('hit');
    void els.dial.offsetWidth;       // restart the animation
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
    } catch (_) { /* wake lock is optional */ }
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    if (isRunning()) { keepAwake(true); tick(); }
    if (audio && audio.ctx.state === 'suspended') audio.ctx.resume().catch(() => {});
  });

  // ---------- rendering ----------
  function renderRows() {
    els.rows.innerHTML = state.steps.map((s, i) => `
      <li class="row" data-i="${i}">
        <span class="badge">${i + 1}</span>
        <div class="row-main">
          <div class="line">
            <span class="lbl">${i === 0 ? 'Starts after' : 'Then after'}</span>
            <input class="num" data-k="min" type="number" inputmode="numeric" min="0" max="999" value="${s.min}" aria-label="Minutes">
            <span class="unit">min</span>
            <input class="num" data-k="sec" type="number" inputmode="numeric" min="0" max="59" value="${s.sec}" aria-label="Seconds">
            <span class="unit">sec</span>
          </div>
          <div class="line">
            <span class="lbl">Gongs</span>
            <button class="step" data-act="dec" type="button" aria-label="One fewer gong">−</button>
            <span class="dots" aria-label="${s.strikes} gongs">${'<i></i>'.repeat(s.strikes)}</span>
            <button class="step" data-act="inc" type="button" aria-label="One more gong">+</button>
          </div>
        </div>
        <button class="del" data-act="del" type="button" aria-label="Remove bell">×</button>
      </li>`).join('');
    els.add.disabled = state.steps.length >= MAX_STEPS;
    renderTotals();
  }

  function renderTotals() {
    const plan = buildPlan();
    const total = plan.length ? plan[plan.length - 1] : 0;
    els.totals.textContent = plan.length
      ? `${fmt(total)} · ${plan.length} gong${plan.length === 1 ? '' : 's'}`
      : '';
  }

  function renderIdle() {
    const plan = buildPlan();
    const total = plan.length ? plan[plan.length - 1] : 0;
    els.status.textContent = 'Ready';
    els.countdown.textContent = fmt(total);
    els.next.textContent = plan.length ? 'Total session length' : 'Add a bell to begin';
    els.progress.style.strokeDashoffset = RING_CIRC;
    els.start.disabled = plan.length === 0;
    els.stop.disabled = true;
    renderTotals();
  }

  function renderSound() {
    els.volume.value = state.volume;
    els.volOut.textContent = `${state.volume}%`;
    els.gap.value = state.gap;
    els.gapOut.textContent = `${state.gap} s`;
    els.repeat.value = state.repeat;
    els.repOut.textContent = `${state.repeat}×`;
  }

  // ---------- events ----------
  els.rows.addEventListener('change', (e) => {
    if (isRunning()) return;
    const input = e.target.closest('input[data-k]');
    const li = e.target.closest('li[data-i]');
    if (!input || !li) return;
    const i = Number(li.dataset.i);
    const k = input.dataset.k;
    const max = k === 'min' ? 999 : 59;
    let v = parseInt(input.value, 10);
    if (Number.isNaN(v)) v = 0;
    state.steps[i][k] = Math.min(Math.max(v, 0), max);
    save();
    renderRows();
  });

  els.rows.addEventListener('click', (e) => {
    if (isRunning()) return;
    const btn = e.target.closest('button[data-act]');
    const li = e.target.closest('li[data-i]');
    if (!btn || !li) return;
    const i = Number(li.dataset.i);
    const step = state.steps[i];
    switch (btn.dataset.act) {
      case 'inc': step.strikes = Math.min(MAX_STRIKES, step.strikes + 1); break;
      case 'dec': step.strikes = Math.max(1, step.strikes - 1); break;
      case 'del': if (state.steps.length > 1) state.steps.splice(i, 1); break;
    }
    save();
    renderRows();
  });

  els.add.addEventListener('click', () => {
    if (isRunning() || state.steps.length >= MAX_STEPS) return;
    const last = state.steps[state.steps.length - 1];
    state.steps.push({ min: 15, sec: 0, strikes: Math.min(MAX_STRIKES, (last ? last.strikes : 0) + 1) });
    save();
    renderRows();
  });

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
    if (!isRunning()) renderTotals();
  });

  els.repeat.addEventListener('input', () => {
    state.repeat = Number(els.repeat.value);
    els.repOut.textContent = `${state.repeat}×`;
    save();
    if (!isRunning()) { renderRows(); }
  });

  els.start.addEventListener('click', start);
  els.stop.addEventListener('click', stop);
  els.test.addEventListener('click', testGong);

  // ---------- boot ----------
  renderSound();
  renderRows();
  renderIdle();

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js').catch(() => {});
    });
  }
})();
