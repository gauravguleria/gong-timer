(() => {
  'use strict';

  const BUILD = Number('__BUILD__') || 0;      // stamped in by the build
  const REPO = 'gauravguleria/gong-timer';
  const KEY = 'gong-timer-v4';
  const OLD_KEY = 'gong-timer-v3';
  const MAX_PARTS = 6;
  const MAX_STRIKES = 12;
  const MAX_SAVED = 30;
  const MAX_RECENT = 5;
  const MINP = 15;              // shortest allowed part, seconds
  const LOOKAHEAD_MS = 20000;   // browser fallback: schedule audio this far ahead
  const RING_CIRC = 2 * Math.PI * 88;
  const WHEEL_ITEM_H = 44;      // must match .wheel-item height in styles.css
  const COPIES = 9, MID = 4;    // wheels repeat their numbers so they loop forever

  const DEFAULTS = {
    total: 15 * 60,
    parts: [{ secs: 15 * 60, strikes: 1 }],
    volume: 100,
    gap: 6,
    repeat: 1,
    keepScreen: true,
    saved: [],
    recent: [],
  };

  // Native Android helper (foreground service). Absent in a normal browser.
  let native = null;
  try {
    if (window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform()) {
      native = window.Capacitor.registerPlugin('Gong');
    }
  } catch (_) { native = null; }

  const $ = (id) => document.getElementById(id);
  const els = {
    pickerWrap: $('pickerWrap'), dial: $('dial'), progress: $('progress'),
    status: $('status'), countdown: $('countdown'), next: $('nextInfo'),
    fab: $('fab'), partsBtn: $('partsBtn'), partsSummary: $('partsSummary'),
    savedList: $('savedList'), recentList: $('recentList'), recentHead: $('recentHead'), addSaved: $('addSavedBtn'),
    menuBtn: $('menuBtn'), menuDot: $('menuDot'), scrim: $('scrim'), drawer: $('drawer'), sheet: $('sheet'),
    versionText: $('versionText'), updateItem: $('updateItem'), updateState: $('updateState'), updateDownload: $('updateDownload'),
    partChips: $('partChips'), parts: $('parts'), totals: $('totalInfo'),
    volume: $('volume'), volOut: $('volOut'), gap: $('gap'), gapOut: $('gapOut'),
    repeat: $('repeat'), repOut: $('repOut'), test: $('testBtn'), screenOpts: $('screenOpts'),
    saveName: $('saveName'), saveInfo: $('saveInfo'), saveConfirm: $('saveConfirm'),
    wheels: {
      h: document.querySelector('.wheel[data-unit="h"]'),
      m: document.querySelector('.wheel[data-unit="m"]'),
      s: document.querySelector('.wheel[data-unit="s"]'),
    },
  };

  els.progress.style.strokeDasharray = RING_CIRC;

  let state = load();
  let pick = { h: 0, m: 15, s: 0 };
  let audio = null;     // browser audio: { ctx, master, sample, ready }
  let session = null;   // { out, plan, startAt, queued, fired, timerId, useNative }
  let wakeLock = null;
  let starting = false;
  let doneTimer = null;
  let latest = null;    // { build, url } of the newest release

  // ---------- storage ----------
  function load() {
    let saved = null;
    try {
      saved = JSON.parse(localStorage.getItem(KEY) || localStorage.getItem(OLD_KEY));
    } catch (_) { /* ignore */ }
    const s = { ...structuredClone(DEFAULTS), ...(saved || {}) };
    const clean = (parts) => (Array.isArray(parts) ? parts : []).slice(0, MAX_PARTS).map((p) => ({
      secs: Math.max(0, Math.floor(p.secs) || 0),
      strikes: Math.min(MAX_STRIKES, Math.max(1, p.strikes || 1)),
    }));
    s.parts = clean(s.parts);
    if (!s.parts.length) s.parts = structuredClone(DEFAULTS.parts);
    const sum = s.parts.reduce((t, p) => t + p.secs, 0);
    if (!(s.total > 0) || sum !== s.total) {
      s.total = sum || DEFAULTS.total;
      if (!sum) s.parts = structuredClone(DEFAULTS.parts);
    }
    s.saved = (Array.isArray(s.saved) ? s.saved : []).slice(0, MAX_SAVED).map((x) => ({
      id: x.id, name: String(x.name || 'Session').slice(0, 24), total: x.total, parts: clean(x.parts),
    })).filter((x) => x.parts.length);
    s.recent = (Array.isArray(s.recent) ? s.recent : []).slice(0, MAX_RECENT).map((x) => ({
      total: x.total, parts: clean(x.parts),
    })).filter((x) => x.parts.length);
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
  const fmtLong = (secs) => `${pad(Math.floor(secs / 3600))}:${pad(Math.floor((secs % 3600) / 60))}:${pad(secs % 60)}`;
  const pickSecs = () => pick.h * 3600 + pick.m * 60 + pick.s;
  const maxParts = () => Math.max(1, Math.min(MAX_PARTS, Math.floor(state.total / MINP)));
  const sig = (parts) => JSON.stringify(parts.map((p) => [p.secs, p.strikes]));
  const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
  const totalGongs = (parts) => parts.reduce((t, p) => t + p.strikes, 0);

  // Every strike as milliseconds from Start. A part's gongs ring when its time is up.
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

  // ---------- audio (browser: used for the test gong and when not in the Android app) ----------
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
    if (!a.sample) return;
    const out = a.ctx.createGain();
    out.connect(a.master);
    strike(a, a.ctx.currentTime + 0.05, out);
    setTimeout(() => out.disconnect(), 24000);
  }

  // ---------- session ----------
  async function start() {
    if (isRunning() || starting || state.total === 0) return;
    const plan = buildPlan();
    if (!plan.length) return;

    clearTimeout(doneTimer);
    starting = true;
    let useNative = false;
    let out = null;
    try {
      if (native) {
        try {
          await native.start({ offsets: plan, volume: state.volume });
          useNative = true;
        } catch (_) { useNative = false; }
      }
      if (!useNative) {
        const a = getAudio();
        await a.ready;
        if (!a.sample) { alert('Gong sound file was not found.'); return; }
        out = a.ctx.createGain();
        out.connect(a.master);
      }
    } finally {
      starting = false;
    }

    rememberRecent();
    // the clock starts only now, after audio is ready, so the first number shown is the full time
    session = { out, plan, startAt: Date.now(), queued: 0, fired: 0, timerId: null, useNative };
    session.timerId = setInterval(tick, 200);

    setMode(true);
    document.body.classList.add('is-running');
    renderFab();
    keepAwake(true);
    tick();
  }

  function stop() {
    if (!isRunning()) return;
    clearInterval(session.timerId);
    if (session.useNative && native) native.stop().catch(() => {});
    if (session.out) session.out.disconnect();   // silences anything still ringing
    session = null;
    finishUi(false);
  }

  function finish() {
    clearInterval(session.timerId);
    session = null;             // the last gong rings out; only the timer stops
    finishUi(true);
  }

  function setMode(running) {
    els.pickerWrap.hidden = running;
    els.dial.hidden = !running;
    if (!running) renderPicker();
  }

  function finishUi(completed) {
    document.body.classList.remove('is-running');
    keepAwake(false);
    els.dial.classList.remove('hit');
    if (completed) {
      els.status.textContent = 'Complete';
      els.countdown.textContent = '00:00';
      els.next.textContent = 'Session finished';
      els.progress.style.strokeDashoffset = 0;
      doneTimer = setTimeout(() => { if (!isRunning()) setMode(false); }, 3500);
    } else {
      setMode(false);
    }
    renderFab();
    renderAll();
  }

  function tick() {
    if (!session) return;
    const now = Date.now();
    const { plan, startAt, out } = session;

    if (!session.useNative) {
      const a = audio;
      while (session.queued < plan.length && startAt + plan[session.queued] <= now + LOOKAHEAD_MS) {
        const delay = Math.max(0.01, (startAt + plan[session.queued] - now) / 1000);
        strike(a, a.ctx.currentTime + delay, out);
        session.queued++;
      }
    }

    let fired = false;
    while (session.fired < plan.length && startAt + plan[session.fired] <= now) {
      session.fired++;
      fired = true;
    }
    if (fired) flash();

    if (session.fired >= plan.length) { finish(); return; }

    const total = plan[plan.length - 1];
    const progress = total > 0 ? clamp((now - startAt) / total, 0, 1) : 1;
    els.progress.style.strokeDashoffset = RING_CIRC * (1 - progress);

    els.status.textContent = session.fired === 0 ? 'First gong in' : 'Next gong in';
    els.countdown.textContent = fmt(startAt + plan[session.fired] - now);
    els.next.textContent = `Gong ${session.fired + 1} of ${plan.length}`;
  }

  function flash() {
    els.dial.classList.remove('hit');
    void els.dial.offsetWidth;
    els.dial.classList.add('hit');
  }

  // Screen: "on" keeps it awake while running; "off" lets it sleep (gongs still ring).
  async function keepAwake(on) {
    const want = on && state.keepScreen;
    if (native) native.keepAwake({ on: want }).catch(() => {});
    try {
      if (want) {
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
      `<div class="wheel-item">${pad(i % n)}</div>`).join('');
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
    renderAll();
  }

  // ---------- parts editor (inside the sheet) ----------
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
    renderSummary();
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
            <span class="unit">${plural(p.strikes, 'gong')}</span>
          </div>
        </div>
      </li>`;
    }).join('');
    updatePartTimes();
  }

  function updatePartTimes() {
    els.parts.querySelectorAll('.pt').forEach((el) => {
      el.textContent = fmtSecs(state.parts[Number(el.dataset.i)].secs);
    });
    els.parts.querySelectorAll('.pslider').forEach((el) => {
      const i = Number(el.dataset.i);
      el.max = Math.max(MINP, maxFor(i));
      el.value = state.parts[i].secs;
    });
    renderSummary();
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
    const p = state.parts[Number(li.dataset.i)];
    switch (btn.dataset.act) {
      case 'tdec': p.secs -= 60; normalize(); save(); updatePartTimes(); return;
      case 'tinc': p.secs += 60; normalize(); save(); updatePartTimes(); return;
      case 'inc': p.strikes = Math.min(MAX_STRIKES, p.strikes + 1); break;
      case 'dec': p.strikes = Math.max(1, p.strikes - 1); break;
    }
    save();
    renderParts();
  });

  // ---------- summary + saved / recent lists ----------
  function renderSummary() {
    els.partsSummary.textContent = `${plural(state.parts.length, 'part')} · ${plural(totalGongs(state.parts), 'gong')}`;
    const plan = buildPlan();
    const total = plan.length ? plan[plan.length - 1] : 0;
    els.totals.textContent = plan.length ? `${fmt(total)} · ${plural(plan.length, 'gong')}` : '';
    renderLists();
  }

  function itemRow(item, kind, i) {
    const current = item.total === state.total && sig(item.parts) === sig(state.parts);
    const title = kind === 'saved' ? item.name : fmtLong(item.total);
    const sub = `${plural(item.parts.length, 'part')} · ${plural(totalGongs(item.parts), 'gong')}`;
    const action = kind === 'saved'
      ? `<button class="mini" data-act="del" aria-label="Delete">×</button>`
      : `<button class="mini" data-act="star" aria-label="Save">☆</button>`;
    return `<li class="item${current ? ' current' : ''}" data-kind="${kind}" data-i="${i}">
      <button class="item-main" data-act="use" type="button">
        <span class="item-name">${title.replace(/</g, '&lt;')}</span>
        <span class="item-sub">${sub}</span>
      </button>
      <span class="item-time">${fmtLong(item.total)}</span>
      ${action}
    </li>`;
  }

  function renderLists() {
    els.savedList.innerHTML = state.saved.length
      ? state.saved.map((x, i) => itemRow(x, 'saved', i)).join('')
      : '<li class="empty">Tap Add to save the current session.</li>';
    const recent = state.recent.filter((r) => !state.saved.some((s) => s.total === r.total && sig(s.parts) === sig(r.parts)));
    els.recentHead.hidden = recent.length === 0;
    els.recentList.innerHTML = recent.map((x) => itemRow(x, 'recent', state.recent.indexOf(x))).join('');
  }

  function applyItem(item) {
    state.total = item.total;
    state.parts = structuredClone(item.parts);
    save();
    renderPicker();
    renderAll();
  }

  function rememberRecent() {
    const entry = { total: state.total, parts: structuredClone(state.parts) };
    state.recent = [entry, ...state.recent.filter((r) => !(r.total === entry.total && sig(r.parts) === sig(entry.parts)))].slice(0, MAX_RECENT);
    save();
  }

  document.querySelector('.lists').addEventListener('click', (e) => {
    if (isRunning()) return;
    const li = e.target.closest('li.item');
    const btn = e.target.closest('[data-act]');
    if (!li || !btn) return;
    const list = li.dataset.kind === 'saved' ? state.saved : state.recent;
    const item = list[Number(li.dataset.i)];
    if (!item) return;
    switch (btn.dataset.act) {
      case 'use': applyItem(item); break;
      case 'del': state.saved.splice(Number(li.dataset.i), 1); save(); renderLists(); break;
      case 'star': openSave(item); break;
    }
  });

  // ---------- save dialog ----------
  let toSave = null;
  function openSave(item) {
    toSave = item || { total: state.total, parts: structuredClone(state.parts) };
    els.saveInfo.textContent = `${fmtLong(toSave.total)} · ${plural(toSave.parts.length, 'part')} · ${plural(totalGongs(toSave.parts), 'gong')}`;
    els.saveName.value = '';
    openSheet('save');
    setTimeout(() => els.saveName.focus(), 250);
  }
  els.addSaved.addEventListener('click', () => { if (!isRunning()) openSave(null); });
  els.saveConfirm.addEventListener('click', () => {
    if (!toSave) return;
    const name = els.saveName.value.trim() || `Session ${state.saved.length + 1}`;
    state.saved.unshift({ id: Date.now(), name, total: toSave.total, parts: structuredClone(toSave.parts) });
    state.saved = state.saved.slice(0, MAX_SAVED);
    toSave = null;
    save();
    closeAll();
    renderLists();
  });

  // ---------- menu, sheet ----------
  function showScrim(on) { els.scrim.hidden = !on; }
  function openDrawer() { closeSheet(); els.drawer.hidden = false; showScrim(true); }
  function closeDrawer() { els.drawer.hidden = true; }
  function openSheet(name) {
    closeDrawer();
    els.sheet.querySelectorAll('[data-panel]').forEach((p) => { p.hidden = p.dataset.panel !== name; });
    if (name === 'parts') { renderPartChips(); renderParts(); }
    els.sheet.hidden = false;
    showScrim(true);
  }
  function closeSheet() { els.sheet.hidden = true; }
  function closeAll() { closeDrawer(); closeSheet(); showScrim(false); }

  els.menuBtn.addEventListener('click', openDrawer);
  els.scrim.addEventListener('click', closeAll);
  els.partsBtn.addEventListener('click', () => { if (!isRunning()) openSheet('parts'); });
  document.addEventListener('click', (e) => {
    const open = e.target.closest('[data-open]');
    if (open) openSheet(open.dataset.open);
    if (e.target.closest('[data-close]')) closeAll();
  });

  // ---------- settings ----------
  function renderSound() {
    els.volume.value = state.volume;
    els.volOut.textContent = `${state.volume}%`;
    els.gap.value = state.gap;
    els.gapOut.textContent = `${state.gap} s`;
    els.repeat.value = state.repeat;
    els.repOut.textContent = `${state.repeat}×`;
    els.screenOpts.querySelectorAll('button').forEach((b) => {
      const on = (b.dataset.screen === 'on') === state.keepScreen;
      b.classList.toggle('on', on);
      b.setAttribute('aria-checked', String(on));
    });
  }

  els.volume.addEventListener('input', () => {
    state.volume = Number(els.volume.value);
    els.volOut.textContent = `${state.volume}%`;
    if (audio) audio.master.gain.setTargetAtTime(state.volume / 100, audio.ctx.currentTime, 0.02);
    if (native) native.setVolume({ volume: state.volume }).catch(() => {});
    save();
  });
  els.gap.addEventListener('input', () => {
    state.gap = Number(els.gap.value);
    els.gapOut.textContent = `${state.gap} s`;
    save();
    renderSummary();
  });
  els.repeat.addEventListener('input', () => {
    state.repeat = Number(els.repeat.value);
    els.repOut.textContent = `${state.repeat}×`;
    save();
    renderSummary();
  });
  els.screenOpts.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-screen]');
    if (!b) return;
    state.keepScreen = b.dataset.screen === 'on';
    save();
    renderSound();
    if (isRunning()) keepAwake(true);
  });
  els.test.addEventListener('click', testGong);

  // ---------- updates ----------
  function setUpdateUi(text, available) {
    els.updateState.textContent = text;
    els.menuDot.hidden = !available;
    els.updateDownload.hidden = !available;
  }

  async function checkUpdate(manual) {
    if (manual) setUpdateUi('Checking…', false);
    try {
      const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, { cache: 'no-store' });
      if (!res.ok) throw new Error(String(res.status));
      const j = await res.json();
      const build = parseInt(String(j.tag_name).replace(/\D/g, ''), 10);
      const asset = (j.assets || []).find((a) => /\.apk$/i.test(a.name));
      latest = { build, url: asset ? asset.browser_download_url : j.html_url };
      if (BUILD > 0 && build > BUILD) setUpdateUi(`v${build} available`, true);
      else setUpdateUi(manual ? 'Up to date' : '', false);
    } catch (_) {
      if (manual) setUpdateUi('Could not check', false);
    }
  }
  els.updateItem.addEventListener('click', () => checkUpdate(true));
  els.updateDownload.addEventListener('click', () => { if (latest) window.location.href = latest.url; });
  els.versionText.textContent = BUILD ? `Version ${BUILD}` : 'Web version';

  // ---------- fab ----------
  const ICON_PLAY = '<svg viewBox="0 0 24 24" width="30" height="30" aria-hidden="true"><path d="M8 5.5v13l11-6.5z" fill="currentColor"/></svg>';
  const ICON_STOP = '<svg viewBox="0 0 24 24" width="28" height="28" aria-hidden="true"><rect x="6.5" y="6.5" width="11" height="11" rx="2" fill="currentColor"/></svg>';
  function renderFab() {
    const running = isRunning();
    els.fab.innerHTML = running ? ICON_STOP : ICON_PLAY;
    els.fab.setAttribute('aria-label', running ? 'Stop' : 'Start');
    els.fab.classList.toggle('stop', running);
    els.fab.disabled = !running && state.total === 0;
  }
  els.fab.addEventListener('click', () => { if (isRunning()) stop(); else start(); });

  // tap the finished dial to get the wheels back right away
  els.dial.addEventListener('click', () => { if (!isRunning()) { clearTimeout(doneTimer); setMode(false); } });

  function renderAll() {
    renderSummary();
    renderFab();
    if (!els.sheet.hidden) { renderPartChips(); renderParts(); }
  }

  // ---------- boot ----------
  renderSound();
  getAudio();            // start loading the gong right away
  renderPicker();
  renderAll();
  setMode(false);
  checkUpdate(false);

  if ('serviceWorker' in navigator && !native) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js').catch(() => {});
    });
  }
})();
