/* Interval Chime: plain JS, no dependencies, no tracking.
   Two alternating intervals (work, rest). A chime marks the end of each,
   and a triple chime marks the end of the session. */
(function () {
  'use strict';

  var params = new URLSearchParams(location.search);
  var TEST = params.get('test') === '1';

  var ITEM = 48;
  var FIFTEEN = 15 * 60;
  var WHEEL_MAX = 60 * 60;
  var ABS_MAX = 600 * 60;
  var LOOKAHEAD_MS = 10 * 60 * 1000;
  var STORE_KEY = 'intervalChime.v2';
  var MIN_INTERVAL_S = TEST ? 1 : 5;

  var INTERVALS = [
    { v: '30', s: 30, label: '30<small>sec</small>' },
    { v: '60', s: 60, label: '1<small>min</small>' },
    { v: '120', s: 120, label: '2<small>min</small>' },
    { v: '180', s: 180, label: '3<small>min</small>' }
  ];
  var SESSIONS = [10, 15, 20, 30, 45, 60].map(function (m) {
    return { v: String(m * 60), s: m * 60, label: m + '<small>min</small>' };
  });
  if (TEST) {
    INTERVALS.unshift({ v: '2', s: 2, label: '2<small>sec (test)</small>' }, { v: '5', s: 5, label: '5<small>sec (test)</small>' });
    SESSIONS.unshift({ v: '10', s: 10, label: '10<small>sec (test)</small>' }, { v: '20', s: 20, label: '20<small>sec (test)</small>' }, { v: '30', s: 30, label: '30<small>sec (test)</small>' });
  }

  var DEFAULTS = {
    work: 60, rest: 30, total: 900, totalTouched: false, open: false,
    forceCustom: false, forceSessionCustom: false,
    ciMin: 1, ciSec: 0, csMin: 15,
    leadIn: false, override: true, volume: 0.9
  };

  function $(id) { return document.getElementById(id); }
  function clampInt(v, lo, hi, dflt) {
    var n = parseInt(v, 10);
    if (!isFinite(n)) return dflt;
    return Math.min(hi, Math.max(lo, n));
  }
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function fmt(totalSec) {
    totalSec = Math.max(0, Math.floor(totalSec));
    var h = Math.floor(totalSec / 3600), m = Math.floor((totalSec % 3600) / 60), s = totalSec % 60;
    return h ? h + ':' + pad(m) + ':' + pad(s) : m + ':' + pad(s);
  }
  function fmtWheel(totalSec) {
    totalSec = Math.max(0, Math.round(totalSec));
    return Math.floor(totalSec / 60) + ':' + pad(totalSec % 60);
  }
  function now() { return performance.now(); }
  function workPresets() { return INTERVALS.filter(function (i) { return i.v !== 'custom'; }).map(function (i) { return i.s; }); }
  function sessionPresets() { return SESSIONS.map(function (i) { return i.s; }); }

  // Nearest whole-round length to target. Ties go to the shorter session.
  function nearestRounds(round, target) {
    round = Math.max(1, round | 0);
    target = Math.max(round, target | 0);
    var lowerN = Math.floor(target / round);
    if (lowerN < 1) lowerN = 1;
    var upperN = lowerN + 1;
    var maxN = Math.max(1, Math.floor(ABS_MAX / round));
    if (lowerN >= maxN) return maxN * round;
    var lowerT = lowerN * round, upperT = upperN * round;
    if (Math.abs(target - lowerT) <= Math.abs(target - upperT)) return lowerT;
    return upperT;
  }

  var testLog = [];
  function log(ev) {
    ev.perf = Math.round(now());
    testLog.push(ev);
    if (testLog.length > 5000) testLog.shift();
  }

  var settings = load();
  function load() {
    var s = {};
    try { s = JSON.parse(localStorage.getItem(STORE_KEY) || '{}') || {}; } catch (e) { s = {}; }
    var out = {};
    for (var k in DEFAULTS) {
      if (Object.prototype.hasOwnProperty.call(DEFAULTS, k)) {
        out[k] = (s && Object.prototype.hasOwnProperty.call(s, k)) ? s[k] : DEFAULTS[k];
      }
    }
    out.work = clampInt(out.work, 0, 180 * 60, DEFAULTS.work);
    out.rest = clampInt(out.rest, 0, 180 * 60, DEFAULTS.rest);
    out.totalTouched = !!out.totalTouched;
    out.open = !!out.open;
    out.forceCustom = !!out.forceCustom;
    out.forceSessionCustom = !!out.forceSessionCustom;
    out.leadIn = !!out.leadIn;
    out.override = !!out.override;
    out.volume = Math.min(1, Math.max(0.1, Number(out.volume) || DEFAULTS.volume));
    out.ciMin = clampInt(out.ciMin, 0, 180, DEFAULTS.ciMin);
    out.ciSec = clampInt(out.ciSec, 0, 59, DEFAULTS.ciSec);
    out.csMin = clampInt(out.csMin, 1, 600, DEFAULTS.csMin);
    var round = out.work + out.rest;
    if (round > 0) {
      var target = out.totalTouched ? clampInt(out.total, round, ABS_MAX, FIFTEEN) : FIFTEEN;
      out.total = nearestRounds(round, target);
    } else {
      out.total = FIFTEEN;
    }
    return out;
  }
  function save() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(settings)); } catch (e) { /* private mode */ }
  }
  function retargetTotal() {
    if (settings.open) return;
    var round = settings.work + settings.rest;
    if (!(round > 0)) return;
    var target = settings.totalTouched ? settings.total : FIFTEEN;
    settings.total = nearestRounds(round, target);
    settings.csMin = clampInt(Math.round(settings.total / 60), 1, 600, 15);
  }

  // ---------- audio (unchanged engine: Web Audio clock, silent-switch keepalive) ----------
  var ctx = null, master = null, comp = null, analyser = null;
  var events = [];
  var keepAlive = null;

  function ensureAudio() {
    if (!ctx) {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      try { ctx = new AC({ latencyHint: 'interactive' }); } catch (e) { ctx = new AC(); }
      comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -14; comp.knee.value = 8; comp.ratio.value = 4;
      comp.attack.value = 0.003; comp.release.value = 0.25;
      master = ctx.createGain();
      master.gain.value = settings.volume;
      master.connect(comp); comp.connect(ctx.destination);
      if (TEST) {
        analyser = ctx.createAnalyser(); analyser.fftSize = 512;
        comp.connect(analyser);
        startOnsetDetector();
      }
      ctx.onstatechange = onCtxState;
    }
    try {
      var b = ctx.createBuffer(1, 1, ctx.sampleRate);
      var src = ctx.createBufferSource(); src.buffer = b; src.connect(ctx.destination); src.start(0);
    } catch (e) { /* ignore */ }
    if (ctx.state !== 'running') { ctx.resume().catch(function () {}); }
    return ctx;
  }

  function silentWavURI() {
    var rate = 8000, n = rate, bytes = 44 + n * 2, buf = new ArrayBuffer(bytes), dv = new DataView(buf);
    function str(o, s) { for (var i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)); }
    str(0, 'RIFF'); dv.setUint32(4, bytes - 8, true); str(8, 'WAVE'); str(12, 'fmt ');
    dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
    dv.setUint32(24, rate, true); dv.setUint32(28, rate * 2, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true);
    str(36, 'data'); dv.setUint32(40, n * 2, true);
    for (var i = 0; i < n; i++) dv.setInt16(44 + i * 2, (i % 2 ? 1 : -1), true);
    var bin = '', u8 = new Uint8Array(buf);
    for (var j = 0; j < u8.length; j += 0x8000) bin += String.fromCharCode.apply(null, u8.subarray(j, j + 0x8000));
    return 'data:audio/wav;base64,' + btoa(bin);
  }

  function setAudioSessionType(t) {
    try { if (navigator.audioSession) navigator.audioSession.type = t; } catch (e) { /* ignore */ }
  }

  function startKeepAlive() {
    if (!settings.override) { setAudioSessionType('ambient'); stopKeepAlive(); return; }
    setAudioSessionType('playback');
    if (!keepAlive) {
      keepAlive = document.createElement('audio');
      keepAlive.setAttribute('playsinline', '');
      keepAlive.setAttribute('x-webkit-airplay', 'deny');
      keepAlive.loop = true; keepAlive.preload = 'auto';
      keepAlive.src = silentWavURI();
    }
    var p = keepAlive.play();
    if (p && p.catch) p.catch(function (e) { log({ type: 'keepalive-error', msg: String(e) }); });
  }
  function stopKeepAlive() { if (keepAlive) { try { keepAlive.pause(); } catch (e) {} } }

  function newEvent(t) {
    var g = ctx.createGain(); g.gain.value = 1; g.connect(master);
    var ev = { start: t, end: t, gain: g, nodes: [] };
    events.push(ev);
    return ev;
  }
  function addOsc(ev, type, freq, t, peak, attack, decay) {
    var o = ctx.createOscillator(), g = ctx.createGain();
    o.type = type; o.frequency.value = freq;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
    o.connect(g); g.connect(ev.gain);
    o.start(t); o.stop(t + attack + decay + 0.05);
    ev.nodes.push(o);
    ev.end = Math.max(ev.end, t + attack + decay + 0.05);
  }
  var PARTIALS = [[0.5, 0.10, 1.3], [1, 1, 1], [1.0025, 0.35, 0.9], [2, 0.45, 0.62], [2.76, 0.26, 0.45], [4.07, 0.14, 0.3], [5.43, 0.07, 0.2]];
  function bell(ev, t, freq, decay, level) {
    for (var i = 0; i < PARTIALS.length; i++) {
      var p = PARTIALS[i];
      addOsc(ev, 'sine', freq * p[0], t, Math.max(0.0002, level * p[1] * 0.32), 0.004, decay * p[2]);
    }
  }
  function playChime(t) { var ev = newEvent(t); bell(ev, t, 880, 2.4, 1); return ev; }
  function playEnd(t) {
    var ev = newEvent(t);
    bell(ev, t, 659.25, 3.2, 1);
    bell(ev, t + 0.6, 830.61, 3.2, 1);
    bell(ev, t + 1.2, 987.77, 5.0, 1.05);
    return ev;
  }
  function playBeep(t) { var ev = newEvent(t); addOsc(ev, 'triangle', 1318.5, t, 0.32, 0.005, 0.14); return ev; }
  function playStartCue(t) { var ev = newEvent(t); bell(ev, t, 1318.5, 0.6, 0.45); return ev; }

  function cancelSounds(onlyFuture) {
    if (!ctx) return;
    var tnow = ctx.currentTime, keep = [];
    for (var i = 0; i < events.length; i++) {
      var ev = events[i];
      if (ev.end < tnow) { try { ev.gain.disconnect(); } catch (e) {} continue; }
      var started = ev.start <= tnow + 0.02;
      if (onlyFuture && started) { keep.push(ev); continue; }
      try {
        if (started) {
          ev.gain.gain.cancelScheduledValues(tnow);
          ev.gain.gain.setValueAtTime(ev.gain.gain.value, tnow);
          ev.gain.gain.setTargetAtTime(0, tnow, 0.03);
          ev.nodes.forEach(function (o) { try { o.stop(tnow + 0.25); } catch (e) {} });
        } else {
          ev.nodes.forEach(function (o) { try { o.stop(); } catch (e) {} });
          ev.gain.disconnect();
        }
      } catch (e) { /* ignore */ }
    }
    events = keep;
  }
  function pruneEvents() {
    if (!ctx) return;
    var tnow = ctx.currentTime;
    events = events.filter(function (ev) {
      if (ev.end < tnow) { try { ev.gain.disconnect(); } catch (e) {} return false; }
      return true;
    });
  }

  function audioTimeFor(tElapsedMs) {
    var targetPerf = run.startPerf + tElapsedMs;
    if (ctx.getOutputTimestamp) {
      var ts = ctx.getOutputTimestamp();
      if (ts && ts.performanceTime > 0 && ts.contextTime > 0) {
        return ts.contextTime + (targetPerf - ts.performanceTime) / 1000;
      }
    }
    return ctx.currentTime + (targetPerf - now()) / 1000;
  }

  function startOnsetDetector() {
    var data = new Float32Array(analyser.fftSize), hist = [], lastOn = -1e9;
    setInterval(function () {
      if (!analyser) return;
      analyser.getFloatTimeDomainData(data);
      var sum = 0; for (var i = 0; i < data.length; i++) sum += data[i] * data[i];
      var rms = Math.sqrt(sum / data.length);
      hist.push(rms); if (hist.length > 8) hist.shift();
      var ago = hist[0];
      if (rms > 0.05 && rms > ago * 1.6 + 0.01 && now() - lastOn > 250) {
        lastOn = now();
        log({ type: 'onset', elapsed: run.state === 'running' ? Math.round(elapsedMs()) : null, rms: +rms.toFixed(3) });
      }
    }, 5);
  }

  // ---------- session engine ----------
  var run = {
    state: 'idle', workMs: 60000, restMs: 30000, totalMs: 900000, leadIn: false,
    startPerf: 0, pausedElapsed: 0, firedIdx: 0, schedIdx: 0, cues: [],
    lastTickPerf: 0, lastTickWall: 0
  };
  function elapsedMs() { return run.state === 'running' ? now() - run.startPerf : run.pausedElapsed; }

  function cueFromIndex(i) {
    var w = run.workMs, r = run.restMs, round = w + r;
    var pair = Math.floor(i / 2);
    if (i % 2 === 0) return { t: pair * round + w, kind: 'chime', phase: 'work' };
    return { t: (pair + 1) * round, kind: 'chime', phase: 'rest' };
  }
  function buildCues() {
    run.cues = [];
    if (!isFinite(run.totalMs)) return;
    var w = run.workMs, r = run.restMs, round = w + r, T = run.totalMs;
    if (!(w > 0) || !(r > 0) || !(round > 0)) {
      run.cues.push({ t: T, kind: 'end', phase: 'end' });
      return;
    }
    var t = 0, guard = 0;
    while (t + w < T && guard++ < 100000) {
      run.cues.push({ t: t + w, kind: 'chime', phase: 'work' });
      if (t + round >= T) break;
      run.cues.push({ t: t + round, kind: 'chime', phase: 'rest' });
      t += round;
    }
    run.cues.push({ t: T, kind: 'end', phase: 'end' });
  }
  function extendCues(untilMs) {
    if (isFinite(run.totalMs)) return;
    var guard = 0;
    while (guard++ < 8000) {
      var cue = cueFromIndex(run.cues.length);
      if (cue.t > untilMs) break;
      run.cues.push(cue);
    }
  }

  function scheduleAhead() {
    if (!ctx || run.state !== 'running') return;
    var el = elapsedMs(), horizon = el + LOOKAHEAD_MS;
    extendCues(horizon);
    var tnow = ctx.currentTime;
    function at(tMs) {
      var a = audioTimeFor(tMs);
      if (a < tnow - 0.25) return null;
      return Math.max(a, tnow + 0.005);
    }
    function leadIns(tMs, prev) {
      if (!run.leadIn) return;
      for (var b = 3; b >= 1; b--) {
        var tb = tMs - b * 1000;
        if (tb <= prev + 150 || tb < el - 50) continue;
        var ab = at(tb);
        if (ab !== null) { playBeep(ab); log({ type: 'sched-beep', t: tb, audio: +ab.toFixed(3) }); }
      }
    }
    while (run.schedIdx < run.cues.length) {
      var cue = run.cues[run.schedIdx];
      if (cue.t > horizon) break;
      var idx = run.schedIdx;
      run.schedIdx++;
      if (cue.t < el - 250) continue;
      var prev = idx > 0 ? run.cues[idx - 1].t : 0;
      leadIns(cue.t, prev);
      var a = at(cue.t);
      if (a === null) continue;
      if (cue.kind === 'end') {
        playEnd(a);
        log({ type: 'sched-end', t: cue.t, audio: +a.toFixed(3) });
      } else {
        playChime(a);
        log({ type: 'sched-chime', k: idx + 1, t: cue.t, phase: cue.phase, audio: +a.toFixed(3) });
      }
    }
  }
  function rewindSched(el) {
    extendCues(el + LOOKAHEAD_MS);
    run.schedIdx = 0;
    while (run.schedIdx < run.cues.length && run.cues[run.schedIdx].t < el - 250) run.schedIdx++;
  }
  function resync() {
    if (run.state !== 'running' || !ctx) return;
    cancelSounds(true);
    rewindSched(elapsedMs());
    scheduleAhead();
    log({ type: 'resync' });
  }

  function phaseAt(el) {
    var w = run.workMs, r = run.restMs, round = w + r;
    var T = run.totalMs;
    var capped = isFinite(T) ? Math.min(Math.max(0, el), T) : Math.max(0, el);
    var idx = round > 0 ? Math.floor(capped / round) : 0;
    var into = round > 0 ? capped - idx * round : 0;
    var inWork = into < w || !(r > 0);
    var segStart = inWork ? idx * round : idx * round + w;
    var phaseEnd = inWork ? idx * round + w : idx * round + round;
    if (isFinite(T) && phaseEnd > T) phaseEnd = T;
    var n = idx + 1;
    var M = (isFinite(T) && round > 0) ? Math.max(1, Math.round(T / round)) : Infinity;
    if (isFinite(M) && n > M) n = M;
    return { inWork: inWork, segStart: segStart, phaseEnd: phaseEnd, roundNum: n, rounds: M };
  }

  function startSession() {
    var W = settings.work, R = settings.rest;
    var T = settings.open ? Infinity : settings.total;
    if (!(W >= MIN_INTERVAL_S && R >= MIN_INTERVAL_S)) return;
    if (!settings.open && !(T >= W + R && T % (W + R) === 0)) return;
    ensureAudio();
    startKeepAlive();
    run.workMs = W * 1000;
    run.restMs = R * 1000;
    run.totalMs = isFinite(T) ? T * 1000 : Infinity;
    run.leadIn = settings.leadIn;
    run.cues = [];
    buildCues();
    run.firedIdx = 0;
    run.schedIdx = 0;
    run.pausedElapsed = 0;
    run.startPerf = now() + 60;
    run.lastTickPerf = now();
    run.lastTickWall = Date.now();
    run.state = 'running';
    cancelSounds(false);
    if (ctx) playStartCue(ctx.currentTime + 0.03);
    scheduleAhead();
    log({ type: 'start', workMs: run.workMs, restMs: run.restMs, totalMs: isFinite(run.totalMs) ? run.totalMs : null });
    showRun();
    requestWakeLock();
    updateMediaSession();
    loop();
  }
  function pauseSession() {
    if (run.state !== 'running') return;
    run.pausedElapsed = elapsedMs();
    run.state = 'paused';
    cancelSounds(false);
    log({ type: 'pause', elapsed: Math.round(run.pausedElapsed) });
    render(); updateMediaSession();
  }
  function resumeSession() {
    if (run.state !== 'paused') return;
    ensureAudio(); startKeepAlive();
    run.startPerf = now() - run.pausedElapsed;
    run.lastTickPerf = now(); run.lastTickWall = Date.now();
    run.state = 'running';
    rewindSched(run.pausedElapsed);
    scheduleAhead();
    log({ type: 'resume', elapsed: Math.round(run.pausedElapsed) });
    requestWakeLock();
    render(); updateMediaSession(); loop();
  }
  function stopSession() {
    if (run.state === 'idle') return;
    log({ type: 'stop', elapsed: Math.round(elapsedMs()) });
    run.state = 'idle';
    cancelSounds(false);
    stopKeepAlive();
    releaseWakeLock();
    clearMediaSession();
    showSetup();
  }
  function finishSession() {
    run.pausedElapsed = run.totalMs;
    run.state = 'done';
    log({ type: 'end', elapsed: Math.round(run.totalMs) });
    flash(true);
    releaseWakeLock();
    setTimeout(function () { if (run.state === 'done' || run.state === 'idle') stopKeepAlive(); }, 7000);
    clearMediaSession();
    render();
  }

  var rafId = 0, timerId = 0;
  function loop() {
    cancelAnimationFrame(rafId);
    if (!timerId) timerId = setInterval(tick, 200);
    (function f() { tick(); if (run.state === 'running') rafId = requestAnimationFrame(f); })();
  }
  function tick() {
    if (run.state !== 'running') { if (timerId) { clearInterval(timerId); timerId = 0; } return; }
    var p = now(), w = Date.now();
    var gap = (w - run.lastTickWall) - (p - run.lastTickPerf);
    if (gap > 1500) { run.startPerf -= gap; log({ type: 'sleep-gap', ms: Math.round(gap) }); resync(); }
    run.lastTickPerf = p; run.lastTickWall = w;

    var el = elapsedMs();
    extendCues(el + 1000);
    var newly = 0, lastT = 0, lastPhase = '';
    while (run.firedIdx < run.cues.length) {
      var cue = run.cues[run.firedIdx];
      if (!cue || cue.kind === 'end' || cue.t > el) break;
      lastT = cue.t; lastPhase = cue.phase;
      run.firedIdx++;
      newly++;
    }
    if (newly) {
      log({ type: 'chime', k: run.firedIdx, expected: lastT, elapsed: Math.round(el), missed: newly - 1, phase: lastPhase });
      flash(false);
      if (navigator.vibrate) { try { navigator.vibrate(200); } catch (e) {} }
      updateMediaSession();
    }
    scheduleAhead();
    if (isFinite(run.totalMs) && el >= run.totalMs) { finishSession(); return; }
    if (Math.random() < 0.02) pruneEvents();
    render();
  }

  // ---------- wheel ----------
  function rangeChoices(current) {
    var vals = [], max = 15 * 60, s;
    if (TEST) {
      for (s = 1; s <= 90; s++) vals.push(s);
      for (s = 95; s <= max; s += 5) vals.push(s);
    } else {
      for (s = MIN_INTERVAL_S; s <= max; s += 5) vals.push(s);
    }
    current = current | 0;
    if (current >= 0 && current <= 180 * 60 && vals.indexOf(current) < 0) {
      vals.push(current);
      vals.sort(function (a, b) { return a - b; });
    }
    return vals;
  }
  function totalChoices() {
    var round = Math.max(1, (settings.work | 0) + (settings.rest | 0));
    var limit = Math.max(WHEEL_MAX, settings.total || 0, round);
    var vals = [];
    for (var t = round; t <= limit + 0.001 && vals.length < 2000; t += round) vals.push(Math.round(t));
    if (!vals.length) vals.push(round);
    var cur = Math.round(settings.total);
    if (cur > 0 && vals.indexOf(cur) < 0) {
      vals.push(cur);
      vals.sort(function (a, b) { return a - b; });
    }
    return vals;
  }

  function sizePads(col) {
    var h = Math.max(0, (col.clientHeight - ITEM) / 2);
    var pads = col.querySelectorAll('.w-pad');
    for (var i = 0; i < pads.length; i++) pads[i].style.height = h + 'px';
  }
  function markItem(col, el) {
    var items = col.querySelectorAll('.w-item');
    var idx = 0;
    for (var i = 0; i < items.length; i++) if (items[i] === el) idx = i;
    for (var j = 0; j < items.length; j++) {
      var d = Math.abs(j - idx);
      items[j].classList.toggle('sel', d === 0);
      items[j].classList.toggle('near', d === 1);
      items[j].setAttribute('aria-selected', d === 0 ? 'true' : 'false');
    }
  }
  function nearestItem(col) {
    var items = col.querySelectorAll('.w-item');
    if (!items.length) return null;
    var mid = col.scrollTop + col.clientHeight / 2;
    var best = items[0], bestD = Infinity;
    for (var i = 0; i < items.length; i++) {
      var c = items[i].offsetTop + items[i].offsetHeight / 2;
      var d = Math.abs(c - mid);
      if (d < bestD) { bestD = d; best = items[i]; }
    }
    return best;
  }
  function layoutColumn(col, values, selectedSec) {
    var sig = values.join(',');
    if (col._sig !== sig) {
      col._sig = sig;
      var html = '<div class="w-pad"></div>';
      for (var i = 0; i < values.length; i++) {
        html += '<div class="w-item" role="option" data-sec="' + values[i] + '">' + fmtWheel(values[i]) + '</div>';
      }
      html += '<div class="w-pad"></div>';
      col._prog = (col._prog || 0) + 1;
      col.innerHTML = html;
      setTimeout(function () { col._prog = Math.max(0, col._prog - 1); }, 60);
    }
    sizePads(col);
    var el = col.querySelector('.w-item[data-sec="' + (selectedSec | 0) + '"]') || col.querySelector('.w-item');
    if (!el || !col.clientHeight) return;
    var top = el.offsetTop - (col.clientHeight - el.offsetHeight) / 2;
    if (Math.abs(col.scrollTop - top) > 1) {
      col._prog = (col._prog || 0) + 1;
      col.scrollTop = top;
      setTimeout(function () { col._prog = Math.max(0, col._prog - 1); }, 60);
    }
    markItem(col, el);
  }

  function momentum(col, v) {
    var id = (col._mom = (col._mom || 0) + 1);
    var prev = now();
    function frame(t) {
      if (col._mom !== id) return;
      var dt = Math.min(34, t - prev);
      prev = t;
      v *= Math.pow(0.94, dt / 16);
      if (Math.abs(v) < 0.03) { settleColumn(col); return; }
      var max = Math.max(0, col.scrollHeight - col.clientHeight);
      var next = col.scrollTop + v * dt;
      if (next <= 0 || next >= max) {
        col.scrollTop = Math.max(0, Math.min(max, next));
        settleColumn(col);
        return;
      }
      col.scrollTop = next;
      col._raf = requestAnimationFrame(frame);
    }
    col._raf = requestAnimationFrame(frame);
  }
  function settleColumn(col) {
    var el = nearestItem(col);
    if (!el) return;
    var top = el.offsetTop - (col.clientHeight - el.offsetHeight) / 2;
    var reduce = false;
    try { reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) { reduce = false; }
    col._prog = (col._prog || 0) + 1;
    if (Math.abs(col.scrollTop - top) > 1) col.scrollTo({ top: top, behavior: reduce ? 'auto' : 'smooth' });
    setTimeout(function () { col._prog = Math.max(0, (col._prog || 1) - 1); }, 260);
    commitColumn(col, Number(el.dataset.sec));
  }
  function commitColumn(col, sec) {
    if (col.dataset.col === 'work') setWork(sec, { wheel: true });
    else if (col.dataset.col === 'rest') setRest(sec);
    else setTotal(sec, { touched: true });
  }
  function stepColumn(col, dir) {
    var items = col.querySelectorAll('.w-item');
    var el = nearestItem(col);
    var idx = 0;
    for (var i = 0; i < items.length; i++) if (items[i] === el) idx = i;
    var n = Math.max(0, Math.min(items.length - 1, idx + dir));
    commitColumn(col, Number(items[n].dataset.sec));
  }
  function bindWheel(col) {
    var drag = null;
    col._prog = 0;
    col.addEventListener('pointerdown', function (e) {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      col._mom = (col._mom || 0) + 1;
      if (col._raf) cancelAnimationFrame(col._raf);
      drag = { id: e.pointerId, y: e.clientY, scroll: col.scrollTop, lastY: e.clientY, lastT: now(), vel: 0, moved: false };
      if (col === ui.totalCol && settings.open) {
        ui.totalOpen.hidden = true;
        col.classList.remove('is-open');
      }
      try { col.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    });
    col.addEventListener('pointermove', function (e) {
      if (!drag || e.pointerId !== drag.id) return;
      var t = now();
      var dy = e.clientY - drag.lastY;
      var dt = Math.max(8, t - drag.lastT);
      drag.vel = dy / dt;
      drag.lastY = e.clientY;
      drag.lastT = t;
      if (Math.abs(e.clientY - drag.y) > 6) drag.moved = true;
      col.scrollTop = drag.scroll - (e.clientY - drag.y);
      if (drag.moved && e.cancelable) e.preventDefault();
    });
    function endDrag(e) {
      if (!drag || (e && e.pointerId !== drag.id)) return;
      var moved = drag.moved;
      var vel = drag.vel;
      drag = null;
      if (!moved) return;
      col._suppressClick = true;
      momentum(col, -vel);
    }
    col.addEventListener('pointerup', endDrag);
    col.addEventListener('pointercancel', endDrag);
    col.addEventListener('wheel', function (e) {
      e.preventDefault();
      col._mom = (col._mom || 0) + 1;
      col.scrollTop += e.deltaY;
      clearTimeout(col._wheelT);
      col._wheelT = setTimeout(function () { settleColumn(col); }, 140);
    }, { passive: false });
    col.addEventListener('touchmove', function (e) { if (e.cancelable) e.preventDefault(); }, { passive: false });
    col.addEventListener('scroll', function () {
      if (col._prog) return;
      var el = nearestItem(col);
      if (el) markItem(col, el);
    }, { passive: true });
    col.addEventListener('keydown', function (e) {
      if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
      e.preventDefault();
      stepColumn(col, e.key === 'ArrowDown' ? 1 : -1);
    });
    col.addEventListener('click', function (e) {
      if (col._suppressClick) { col._suppressClick = false; return; }
      var item = e.target.closest ? e.target.closest('.w-item') : null;
      if (!item || !col.contains(item)) return;
      commitColumn(col, Number(item.dataset.sec));
    });
  }

  // ---------- settings mutations ----------
  function setWork(sec, opts) {
    opts = opts || {};
    sec = Math.max(0, sec | 0);
    var changed = sec !== settings.work;
    settings.work = sec;
    settings.ciMin = Math.floor(sec / 60);
    settings.ciSec = sec % 60;
    if (opts.forceCustom != null) settings.forceCustom = !!opts.forceCustom;
    else if (opts.wheel) settings.forceCustom = workPresets().indexOf(sec) < 0;
    if (changed) retargetTotal();
    save();
    renderSetup();
  }
  function setRest(sec) {
    sec = Math.max(0, sec | 0);
    var changed = sec !== settings.rest;
    settings.rest = sec;
    if (changed) retargetTotal();
    save();
    renderSetup();
  }
  function setTotal(sec, opts) {
    opts = opts || {};
    var round = Math.max(1, (settings.work | 0) + (settings.rest | 0));
    var next = nearestRounds(round, sec | 0);
    settings.open = false;
    if (opts.touched !== false) settings.totalTouched = true;
    settings.total = next;
    settings.csMin = clampInt(Math.round(next / 60), 1, 600, 15);
    if (opts.forceSessionCustom != null) settings.forceSessionCustom = !!opts.forceSessionCustom;
    else settings.forceSessionCustom = sessionPresets().indexOf(next) < 0;
    save();
    renderSetup();
  }

  // ---------- UI ----------
  var ui = {};
  var lastText = {};
  function setText(el, key, txt) { if (lastText[key] !== txt) { el.textContent = txt; lastText[key] = txt; } }
  function setWidth(el, key, pct) { var v = pct.toFixed(1) + '%'; if (lastText[key] !== v) { el.style.width = v; lastText[key] = v; } }

  function buildButtons(container, items, key, extra) {
    container.innerHTML = '';
    items.concat(extra).forEach(function (it) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'btn opt' + (it.cls ? ' ' + it.cls : '');
      b.dataset.v = it.v;
      b.innerHTML = it.label;
      b.addEventListener('click', function () {
        if (key === 'interval') {
          if (it.v === 'custom') {
            setWork(settings.ciMin * 60 + settings.ciSec, { forceCustom: true });
            setTimeout(function () { ui.ciMin.focus(); if (ui.ciMin.select) ui.ciMin.select(); }, 30);
          } else {
            setWork(Number(it.v), { forceCustom: false });
          }
        } else if (it.v === 'open') {
          settings.open = true;
          settings.forceSessionCustom = false;
          save();
          renderSetup();
        } else if (it.v === 'custom') {
          setTotal(settings.csMin * 60, { touched: true, forceSessionCustom: true });
          setTimeout(function () { ui.csMin.focus(); if (ui.csMin.select) ui.csMin.select(); }, 30);
        } else {
          setTotal(Number(it.v), { touched: true, forceSessionCustom: false });
        }
      });
      container.appendChild(b);
    });
  }

  function renderWheels() {
    if (ui.setup.hidden) return;
    layoutColumn(ui.workCol, rangeChoices(settings.work), settings.work);
    layoutColumn(ui.restCol, rangeChoices(settings.rest), settings.rest);
    layoutColumn(ui.totalCol, totalChoices(), settings.total);
    ui.totalCol.classList.toggle('is-open', !!settings.open);
    ui.totalOpen.hidden = !settings.open;
  }

  function renderSetup() {
    var workCustom = settings.forceCustom || workPresets().indexOf(settings.work) < 0;
    var sessionCustom = !settings.open && (settings.forceSessionCustom || sessionPresets().indexOf(settings.total) < 0);
    [].forEach.call(ui.intBtns.children, function (b) {
      var pressed = b.dataset.v === 'custom' ? workCustom : (!settings.forceCustom && settings.work === Number(b.dataset.v));
      b.setAttribute('aria-pressed', String(pressed));
    });
    [].forEach.call(ui.sesBtns.children, function (b) {
      var pressed = false;
      if (b.dataset.v === 'open') pressed = !!settings.open;
      else if (b.dataset.v === 'custom') pressed = sessionCustom;
      else pressed = !settings.open && !settings.forceSessionCustom && settings.total === Number(b.dataset.v);
      b.setAttribute('aria-pressed', String(pressed));
    });
    ui.customInt.hidden = !workCustom;
    ui.customSes.hidden = !sessionCustom;
    if (document.activeElement !== ui.ciMin) ui.ciMin.value = settings.ciMin;
    if (document.activeElement !== ui.ciSec) ui.ciSec.value = settings.ciSec;
    if (document.activeElement !== ui.csMin) ui.csMin.value = settings.csMin;
    ui.leadIn.checked = settings.leadIn;
    ui.override.checked = settings.override;
    ui.volume.value = settings.volume;

    var w = settings.work, r = settings.rest, t = settings.total, round = w + r;
    var ok = w >= MIN_INTERVAL_S && r >= MIN_INTERVAL_S && (settings.open || (round > 0 && t >= round && t % round === 0));
    var msg;
    if (w < MIN_INTERVAL_S || r < MIN_INTERVAL_S) msg = 'Each interval must be at least ' + MIN_INTERVAL_S + ' seconds.';
    else if (settings.open) msg = fmtWheel(w) + ' / ' + fmtWheel(r) + ' until you stop.';
    else {
      var rounds = round > 0 ? Math.max(1, Math.round(t / round)) : 0;
      msg = fmtWheel(w) + ' / ' + fmtWheel(r) + ' · ' + rounds + ' rounds · ' + fmtWheel(t);
    }
    ui.summary.textContent = msg;
    ui.summary.classList.toggle('err', !ok);
    ui.start.disabled = !ok;
    renderWheels();
  }

  function showSetup() {
    cancelAnimationFrame(rafId);
    ui.run.hidden = true;
    ui.setup.hidden = false;
    document.title = 'Interval Chime';
    renderSetup();
    window.scrollTo(0, 0);
    requestAnimationFrame(renderWheels);
  }
  function showRun() {
    ui.setup.hidden = true;
    ui.run.hidden = false;
    ui.stop.classList.remove('confirm');
    ui.stop.textContent = 'Stop';
    lastText = {};
    window.scrollTo(0, 0);
    render();
  }

  function render() {
    if (ui.run.hidden) return;
    var el = Math.max(0, elapsedMs());
    var done = run.state === 'done';
    var info = phaseAt(done ? run.totalMs : el);
    ui.run.classList.toggle('paused', run.state === 'paused');
    ui.run.classList.toggle('done', done);
    ui.run.classList.toggle('phase-work', !done && info.inWork);
    ui.run.classList.toggle('phase-rest', !done && !info.inWork);
    ui.controls.hidden = done;
    ui.doneControls.hidden = !done;
    var pair = fmt(run.workMs / 1000) + ' · ' + fmt(run.restMs / 1000);
    setText(ui.every, 'every', pair);
    if (done) {
      var roundsDone = isFinite(info.rounds) ? info.rounds : info.roundNum;
      setText(ui.interval, 'int', 'Session complete');
      setText(ui.label, 'lbl', roundsDone + ' round' + (roundsDone === 1 ? '' : 's'));
      setText(ui.count, 'cnt', 'Done');
      setText(ui.elapsed, 'el', fmt(run.totalMs / 1000));
      setText(ui.remaining, 'rem', '0:00');
      setWidth(ui.ibar, 'ib', 100);
      setWidth(ui.tbar, 'tb', 100);
      document.title = 'Done · Interval Chime';
      return;
    }
    var roundTxt = isFinite(info.rounds) ? ('Round ' + info.roundNum + ' of ' + info.rounds) : ('Round ' + info.roundNum);
    var toNext = Math.max(0, info.phaseEnd - el);
    var cdTxt = fmt(Math.ceil(toNext / 1000 - 1e-6));
    setText(ui.interval, 'int', roundTxt);
    setText(ui.label, 'lbl', run.state === 'paused' ? 'Paused' : (info.inWork ? 'Work' : 'Rest'));
    setText(ui.count, 'cnt', cdTxt);
    setText(ui.elapsed, 'el', fmt(el / 1000));
    setText(ui.remaining, 'rem', isFinite(run.totalMs) ? fmt(Math.ceil((run.totalMs - el) / 1000 - 1e-6)) : '∞');
    var segLen = info.phaseEnd - info.segStart;
    setWidth(ui.ibar, 'ib', segLen > 0 ? Math.min(100, (el - info.segStart) / segLen * 100) : 0);
    ui.tbarWrap.hidden = !isFinite(run.totalMs);
    if (isFinite(run.totalMs)) setWidth(ui.tbar, 'tb', Math.min(100, el / run.totalMs * 100));
    setText(ui.pause, 'pause', run.state === 'paused' ? 'Resume' : 'Pause');
    document.title = cdTxt + ' · ' + (info.inWork ? 'Work' : 'Rest');
  }

  var flashTimer = 0;
  function flash(end) {
    ui.flash.classList.toggle('end', !!end);
    ui.flash.classList.add('on');
    clearTimeout(flashTimer);
    flashTimer = setTimeout(function () { ui.flash.classList.remove('on'); }, 120);
  }

  var wakeLock = null;
  function setWake(txt) { ui.wake.textContent = 'Screen: ' + txt; }
  function requestWakeLock() {
    if (!('wakeLock' in navigator)) { setWake('auto-lock may turn it off (Wake Lock not supported)'); return; }
    if (wakeLock || document.visibilityState !== 'visible') return;
    navigator.wakeLock.request('screen').then(function (wl) {
      wakeLock = wl; setWake('kept awake ✓'); log({ type: 'wakelock', on: true });
      wl.addEventListener('release', function () {
        wakeLock = null; log({ type: 'wakelock', on: false });
        if (run.state === 'running' || run.state === 'paused') setWake('may sleep (will re-lock when visible)');
      });
    }).catch(function (e) { setWake('could not keep awake (' + (e && e.name || 'error') + ')'); log({ type: 'wakelock-error', msg: String(e) }); });
  }
  function releaseWakeLock() { if (wakeLock) { try { wakeLock.release(); } catch (e) {} wakeLock = null; } }

  document.addEventListener('visibilitychange', function () {
    log({ type: 'visibility', state: document.visibilityState });
    if (document.visibilityState === 'visible') {
      if (run.state === 'running' || run.state === 'paused') requestWakeLock();
      if (run.state === 'running') { tick(); resync(); loop(); }
      checkAudioBanner();
    }
  });

  function onCtxState() {
    log({ type: 'ctx-state', state: ctx.state });
    if (ctx.state === 'running') resync();
    checkAudioBanner();
  }
  function checkAudioBanner() {
    ui.audioBanner.hidden = !(ctx && ctx.state !== 'running' && (run.state === 'running' || run.state === 'paused'));
  }

  function updateMediaSession() {
    if (!('mediaSession' in navigator) || !settings.override) return;
    try {
      var info = phaseAt(elapsedMs());
      navigator.mediaSession.metadata = new MediaMetadata({
        title: info.inWork ? 'Work' : 'Rest',
        artist: 'Round ' + info.roundNum + (isFinite(info.rounds) ? ' of ' + info.rounds : '') + ' · ' + fmt(run.workMs / 1000) + ' / ' + fmt(run.restMs / 1000),
        artwork: [{ src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' }]
      });
      navigator.mediaSession.playbackState = run.state === 'running' ? 'playing' : 'paused';
      navigator.mediaSession.setActionHandler('play', function () { resumeSession(); });
      navigator.mediaSession.setActionHandler('pause', function () { pauseSession(); });
    } catch (e) { /* ignore */ }
  }
  function clearMediaSession() {
    if (!('mediaSession' in navigator)) return;
    try { navigator.mediaSession.metadata = null; navigator.mediaSession.playbackState = 'none'; } catch (e) {}
  }

  function init() {
    ['setup', 'run', 'summary', 'flash'].forEach(function (id) { ui[id] = $(id); });
    ui.workCol = $('col-work'); ui.restCol = $('col-rest'); ui.totalCol = $('col-total');
    ui.totalOpen = $('total-open');
    ui.intBtns = $('interval-buttons'); ui.sesBtns = $('session-buttons');
    ui.customInt = $('custom-interval'); ui.customSes = $('custom-session');
    ui.ciMin = $('ci-min'); ui.ciSec = $('ci-sec'); ui.csMin = $('cs-min');
    ui.leadIn = $('opt-leadin'); ui.override = $('opt-override'); ui.volume = $('opt-volume');
    ui.start = $('btn-start'); ui.test = $('btn-test');
    ui.interval = $('r-interval'); ui.every = $('r-every'); ui.label = $('r-label'); ui.count = $('r-count');
    ui.ibar = $('r-ibar'); ui.tbar = $('r-tbar'); ui.tbarWrap = $('r-tbar-wrap');
    ui.elapsed = $('r-elapsed'); ui.remaining = $('r-remaining');
    ui.pause = $('btn-pause'); ui.stop = $('btn-stop'); ui.controls = ui.pause.parentNode;
    ui.doneControls = $('done-controls'); ui.wake = $('r-wake'); ui.audioBanner = $('audio-banner');
    if (TEST) $('test-badge').hidden = false;

    bindWheel(ui.workCol); bindWheel(ui.restCol); bindWheel(ui.totalCol);
    buildButtons(ui.intBtns, INTERVALS, 'interval', [{ v: 'custom', label: 'Custom', cls: 'wide' }]);
    buildButtons(ui.sesBtns, SESSIONS, 'session', [{ v: 'custom', label: 'Custom', cls: 'wide-half' }, { v: 'open', label: 'Until I stop', cls: 'wide-two' }]);

    function onWorkInputs() {
      if (ui.ciMin.value !== '') settings.ciMin = clampInt(ui.ciMin.value, 0, 180, settings.ciMin);
      if (ui.ciSec.value !== '') settings.ciSec = clampInt(ui.ciSec.value, 0, 59, settings.ciSec);
      setWork(settings.ciMin * 60 + settings.ciSec, { forceCustom: true });
    }
    function onSessionInput() {
      if (ui.csMin.value === '') return;
      settings.csMin = clampInt(ui.csMin.value, 1, 600, settings.csMin);
      setTotal(settings.csMin * 60, { touched: true, forceSessionCustom: true });
    }
    [ui.ciMin, ui.ciSec].forEach(function (inp) {
      inp.addEventListener('input', onWorkInputs);
      inp.addEventListener('blur', function () { onWorkInputs(); inp.value = inp === ui.ciMin ? settings.ciMin : settings.ciSec; });
      inp.addEventListener('keydown', function (e) { if (e.key === 'Enter') inp.blur(); });
    });
    ui.csMin.addEventListener('input', onSessionInput);
    ui.csMin.addEventListener('blur', function () { onSessionInput(); ui.csMin.value = settings.csMin; });
    ui.csMin.addEventListener('keydown', function (e) { if (e.key === 'Enter') ui.csMin.blur(); });

    ui.leadIn.addEventListener('change', function () { settings.leadIn = ui.leadIn.checked; save(); });
    ui.override.addEventListener('change', function () { settings.override = ui.override.checked; save(); });
    ui.volume.addEventListener('input', function () {
      settings.volume = Number(ui.volume.value); save();
      if (master) master.gain.setTargetAtTime(settings.volume, ctx.currentTime, 0.02);
    });
    ui.test.addEventListener('click', function () {
      if (!ensureAudio()) return;
      startKeepAlive();
      playChime(ctx.currentTime + 0.05);
      log({ type: 'test-chime' });
      setTimeout(function () { if (run.state === 'idle') stopKeepAlive(); }, 3500);
    });
    ui.start.addEventListener('click', startSession);
    ui.pause.addEventListener('click', function () { run.state === 'paused' ? resumeSession() : pauseSession(); });
    var stopArm = 0;
    ui.stop.addEventListener('click', function () {
      if (ui.stop.classList.contains('confirm')) { clearTimeout(stopArm); ui.stop.classList.remove('confirm'); stopSession(); return; }
      ui.stop.classList.add('confirm'); ui.stop.textContent = 'Tap to stop';
      stopArm = setTimeout(function () { ui.stop.classList.remove('confirm'); ui.stop.textContent = 'Stop'; }, 3000);
    });
    $('btn-again').addEventListener('click', function () { run.state = 'idle'; startSession(); });
    $('btn-back').addEventListener('click', function () { run.state = 'done'; stopSession(); });
    $('btn-audio-fix').addEventListener('click', function () { ensureAudio(); startKeepAlive(); setTimeout(checkAudioBanner, 300); });

    window.addEventListener('resize', function () { if (!ui.setup.hidden) renderWheels(); });
    renderSetup();
    requestAnimationFrame(renderWheels);

    if ('serviceWorker' in navigator && location.protocol !== 'file:') {
      navigator.serviceWorker.register('sw.js').then(function (reg) {
        log({ type: 'sw-registered', scope: reg.scope });
      }).catch(function (e) { log({ type: 'sw-error', msg: String(e) }); });
    }
  }

  window.__chime = {
    log: testLog,
    state: function () {
      var info = phaseAt(elapsedMs());
      return {
        state: run.state, elapsed: Math.round(elapsedMs()), firedIdx: run.firedIdx, schedIdx: run.schedIdx,
        workMs: run.workMs, restMs: run.restMs, totalMs: isFinite(run.totalMs) ? run.totalMs : null,
        phase: run.state === 'done' ? 'done' : (info.inWork ? 'work' : 'rest'),
        ctxState: ctx && ctx.state, ctxTime: ctx && ctx.currentTime, pendingEvents: events.length, wakeLock: !!wakeLock
      };
    },
    settings: function () { return JSON.parse(JSON.stringify(settings)); }
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
