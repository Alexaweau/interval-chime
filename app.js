/* Interval Chime: plain JS, no dependencies, no tracking. */
(function () {
  'use strict';

  var params = new URLSearchParams(location.search);
  var TEST = params.get('test') === '1';

  // ---------- config ----------
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
  var MIN_INTERVAL_S = TEST ? 1 : 5;
  var LOOKAHEAD_MS = 10 * 60 * 1000;   // pre-schedule audio up to 10 min ahead
  var STORE_KEY = 'intervalChime.v1';

  var DEFAULTS = {
    interval: '30', ciMin: 1, ciSec: 30,
    session: '1800', csMin: 25,
    leadIn: false, override: true, volume: 0.9
  };

  // ---------- helpers ----------
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
  function fmtDur(sec) {
    if (sec < 60) return sec + ' s';
    var m = Math.floor(sec / 60), s = sec % 60;
    return s ? m + ' min ' + s + ' s' : m + ' min';
  }
  function now() { return performance.now(); }

  var testLog = [];
  function log(ev) {
    ev.perf = Math.round(now());
    testLog.push(ev);
    if (testLog.length > 5000) testLog.shift();
  }

  // ---------- settings ----------
  var settings = load();
  function load() {
    var s = {};
    try { s = JSON.parse(localStorage.getItem(STORE_KEY) || '{}') || {}; } catch (e) { s = {}; }
    var out = {};
    for (var k in DEFAULTS) out[k] = (k in s) ? s[k] : DEFAULTS[k];
    if (out.interval !== 'custom' && !INTERVALS.some(function (i) { return i.v === out.interval; })) out.interval = DEFAULTS.interval;
    if (['custom', 'open'].indexOf(out.session) < 0 && !SESSIONS.some(function (i) { return i.v === out.session; })) out.session = DEFAULTS.session;
    out.ciMin = clampInt(out.ciMin, 0, 180, DEFAULTS.ciMin);
    out.ciSec = clampInt(out.ciSec, 0, 59, DEFAULTS.ciSec);
    out.csMin = clampInt(out.csMin, 1, 600, DEFAULTS.csMin);
    out.volume = Math.min(1, Math.max(0.1, Number(out.volume) || DEFAULTS.volume));
    out.leadIn = !!out.leadIn; out.override = !!out.override;
    return out;
  }
  function save() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(settings)); } catch (e) { /* private mode */ }
  }
  function intervalSec() {
    if (settings.interval === 'custom') return settings.ciMin * 60 + settings.ciSec;
    return Number(settings.interval);
  }
  function sessionSec() {
    if (settings.session === 'open') return Infinity;
    if (settings.session === 'custom') return settings.csMin * 60;
    return Number(settings.session);
  }

  // ---------- audio ----------
  var ctx = null, master = null, comp = null, analyser = null;
  var events = [];          // scheduled sound events {start, gain, nodes[]}
  var keepAlive = null;     // looping near-silent <audio> for iOS silent-switch override

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
    // iOS unlock: play a 1-sample silent buffer inside the user gesture.
    try {
      var b = ctx.createBuffer(1, 1, ctx.sampleRate);
      var src = ctx.createBufferSource(); src.buffer = b; src.connect(ctx.destination); src.start(0);
    } catch (e) { /* ignore */ }
    if (ctx.state !== 'running') { ctx.resume().catch(function () {}); }
    return ctx;
  }

  // Build a ~1 s, 8 kHz, near-silent (±1 LSB dither, about -90 dBFS) WAV as a data: URI.
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

  // Must be called from inside a tap handler.
  function startKeepAlive() {
    if (!settings.override) { setAudioSessionType('ambient'); stopKeepAlive(); return; }
    setAudioSessionType('playback'); // Safari 17+: Web Audio ignores the ringer switch
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
  // Bell partials: [ratio, amplitude, decay factor]
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

  // Cancel scheduled sounds. onlyFuture: keep anything already ringing.
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

  // Map an elapsed-session time (ms) to AudioContext time (s).
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

  // Test-only: detect actual audio onsets from the output to verify timing.
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
    state: 'idle', intervalMs: 30000, totalMs: 1800000, leadIn: false,
    startPerf: 0, pausedElapsed: 0, firedIdx: 0, schedIdx: 0, endScheduled: false,
    lastTickPerf: 0, lastTickWall: 0
  };
  function elapsedMs() { return run.state === 'running' ? now() - run.startPerf : run.pausedElapsed; }
  function totalIntervals() { return isFinite(run.totalMs) ? Math.ceil(run.totalMs / run.intervalMs - 1e-9) : Infinity; }

  function scheduleAhead() {
    if (!ctx || run.state !== 'running') return;
    var el = elapsedMs(), horizon = el + LOOKAHEAD_MS, I = run.intervalMs;
    var tnow = ctx.currentTime;
    function at(tMs) {
      var a = audioTimeFor(tMs);
      if (a < tnow - 0.25) return null;  // missed by >250 ms: skip
      return Math.max(a, tnow + 0.005);
    }
    function leadIns(tMs) {
      if (!run.leadIn) return;
      var prev = tMs - I;
      if (isFinite(run.totalMs) && tMs === run.totalMs) prev = Math.floor((run.totalMs - 1) / I) * I;
      for (var b = 3; b >= 1; b--) {
        var tb = tMs - b * 1000;
        if (tb <= prev + 150 || tb < el - 50) continue;
        var ab = at(tb); if (ab !== null) { playBeep(ab); log({ type: 'sched-beep', t: tb, audio: +ab.toFixed(3) }); }
      }
    }
    while (true) {
      var k = run.schedIdx + 1, t = k * I;
      if (isFinite(run.totalMs) && t >= run.totalMs - 0.5) break;
      if (t > horizon) break;
      run.schedIdx = k;
      if (t < el - 250) continue;
      leadIns(t);
      var a = at(t);
      if (a !== null) { playChime(a); log({ type: 'sched-chime', k: k, t: t, audio: +a.toFixed(3) }); }
    }
    if (isFinite(run.totalMs) && !run.endScheduled && run.totalMs <= horizon) {
      run.endScheduled = true;
      leadIns(run.totalMs);
      var ae = at(run.totalMs);
      if (ae !== null) { playEnd(ae); log({ type: 'sched-end', t: run.totalMs, audio: +ae.toFixed(3) }); }
    }
  }
  function resync() {
    if (run.state !== 'running' || !ctx) return;
    cancelSounds(true);
    run.schedIdx = Math.floor(elapsedMs() / run.intervalMs);
    run.endScheduled = false;
    scheduleAhead();
    log({ type: 'resync' });
  }

  function startSession() {
    var I = intervalSec(), T = sessionSec();
    if (!(I >= MIN_INTERVAL_S)) return;
    ensureAudio();
    startKeepAlive();
    run.intervalMs = I * 1000;
    run.totalMs = isFinite(T) ? T * 1000 : Infinity;
    run.leadIn = settings.leadIn;
    run.firedIdx = 0; run.schedIdx = 0; run.endScheduled = false;
    run.pausedElapsed = 0;
    run.startPerf = now() + 60;   // small offset so audio is ready
    run.lastTickPerf = now(); run.lastTickWall = Date.now();
    run.state = 'running';
    cancelSounds(false);
    if (ctx) { playStartCue(ctx.currentTime + 0.03); }
    scheduleAhead();
    log({ type: 'start', intervalMs: run.intervalMs, totalMs: isFinite(run.totalMs) ? run.totalMs : null });
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
    run.schedIdx = Math.floor(run.pausedElapsed / run.intervalMs);
    run.endScheduled = false;
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
    // let the end chime ring out before dropping the media audio session
    setTimeout(function () { if (run.state === 'done' || run.state === 'idle') stopKeepAlive(); }, 7000);
    clearMediaSession();
    render();
  }

  // ---------- tick ----------
  var rafId = 0, timerId = 0;
  function loop() {
    cancelAnimationFrame(rafId);
    if (!timerId) timerId = setInterval(tick, 200);
    (function f() { tick(); if (run.state === 'running') rafId = requestAnimationFrame(f); })();
  }
  function tick() {
    if (run.state !== 'running') { if (timerId) { clearInterval(timerId); timerId = 0; } return; }
    // If the device slept, performance.now() may lag wall time; trust wall time for the gap.
    var p = now(), w = Date.now();
    var gap = (w - run.lastTickWall) - (p - run.lastTickPerf);
    if (gap > 1500) { run.startPerf -= gap; log({ type: 'sleep-gap', ms: Math.round(gap) }); resync(); }
    run.lastTickPerf = p; run.lastTickWall = w;

    var el = elapsedMs();
    if (isFinite(run.totalMs) && el >= run.totalMs) { finishSession(); return; }
    var fired = Math.floor(el / run.intervalMs);
    if (fired > run.firedIdx) {
      var missed = fired - run.firedIdx - 1;
      run.firedIdx = fired;
      log({ type: 'chime', k: fired, expected: fired * run.intervalMs, elapsed: Math.round(el), missed: missed });
      flash(false);
      if (navigator.vibrate) { try { navigator.vibrate(200); } catch (e) {} }
      updateMediaSession();
    }
    scheduleAhead();
    if (Math.random() < 0.02) pruneEvents();
    render();
  }

  // ---------- UI ----------
  var ui = {};
  function buildButtons(container, items, key, extra) {
    container.innerHTML = '';
    items.concat(extra).forEach(function (it) {
      var b = document.createElement('button');
      b.type = 'button'; b.className = 'btn opt' + (it.cls ? ' ' + it.cls : '');
      b.dataset.v = it.v; b.innerHTML = it.label;
      b.addEventListener('click', function () {
        settings[key] = it.v; save(); renderSetup();
        if (it.v === 'custom') {
          var inp = key === 'interval' ? ui.ciMin : ui.csMin;
          setTimeout(function () { inp.focus(); inp.select && inp.select(); }, 30);
        }
      });
      container.appendChild(b);
    });
  }
  function renderSetup() {
    [].forEach.call(ui.intBtns.children, function (b) { b.setAttribute('aria-pressed', String(b.dataset.v === settings.interval)); });
    [].forEach.call(ui.sesBtns.children, function (b) { b.setAttribute('aria-pressed', String(b.dataset.v === settings.session)); });
    ui.customInt.hidden = settings.interval !== 'custom';
    ui.customSes.hidden = settings.session !== 'custom';
    if (document.activeElement !== ui.ciMin) ui.ciMin.value = settings.ciMin;
    if (document.activeElement !== ui.ciSec) ui.ciSec.value = settings.ciSec;
    if (document.activeElement !== ui.csMin) ui.csMin.value = settings.csMin;
    ui.leadIn.checked = settings.leadIn; ui.override.checked = settings.override;
    ui.volume.value = settings.volume;

    var I = intervalSec(), T = sessionSec(), msg, ok = I >= MIN_INTERVAL_S;
    if (!ok) msg = 'Interval must be at least ' + MIN_INTERVAL_S + ' seconds.';
    else if (!isFinite(T)) msg = 'Chime every <b>' + fmtDur(I) + '</b> until you press Stop.';
    else if (I >= T) msg = 'Interval is as long as the session, so you get one end chime at <b>' + fmt(T) + '</b>.';
    else {
      var M = Math.ceil(T / I - 1e-9), rem = T - (M - 1) * I;
      msg = 'Chime every <b>' + fmtDur(I) + '</b>, <b>' + M + '</b> intervals, triple chime at <b>' + fmt(T) + '</b>.';
      if (rem !== I) msg += ' The last interval is ' + fmtDur(rem) + '.';
    }
    ui.summary.innerHTML = msg;
    ui.summary.classList.toggle('err', !ok);
    ui.start.disabled = !ok;
  }

  function showSetup() {
    cancelAnimationFrame(rafId);
    ui.run.hidden = true; ui.setup.hidden = false;
    document.title = 'Interval Chime';
    renderSetup();
  }
  function showRun() {
    ui.setup.hidden = true; ui.run.hidden = false;
    ui.stop.classList.remove('confirm'); ui.stop.textContent = 'Stop';
    window.scrollTo(0, 0);
    render();
  }

  var lastText = {};
  function setText(el, key, txt) { if (lastText[key] !== txt) { el.textContent = txt; lastText[key] = txt; } }
  function setWidth(el, key, pct) { var v = pct.toFixed(1) + '%'; if (lastText[key] !== v) { el.style.width = v; lastText[key] = v; } }

  function render() {
    if (ui.run.hidden) return;
    var I = run.intervalMs, T = run.totalMs, el = Math.max(0, elapsedMs()), M = totalIntervals();
    var done = run.state === 'done';
    ui.run.classList.toggle('paused', run.state === 'paused');
    ui.run.classList.toggle('done', done);
    ui.controls.hidden = done; ui.doneControls.hidden = !done;
    setText(ui.every, 'every', 'every ' + fmt(I / 1000) + (isFinite(T) ? ' · ' + fmt(T / 1000) + ' total' : ' · open-ended'));
    if (done) {
      setText(ui.interval, 'int', 'Session complete');
      setText(ui.label, 'lbl', M + ' interval' + (M === 1 ? '' : 's'));
      setText(ui.count, 'cnt', 'Done');
      setText(ui.elapsed, 'el', fmt(T / 1000));
      setText(ui.remaining, 'rem', '0:00');
      setWidth(ui.ibar, 'ib', 100); setWidth(ui.tbar, 'tb', 100);
      document.title = 'Done · Interval Chime';
      return;
    }
    var n = Math.floor(el / I) + 1;
    if (isFinite(M)) n = Math.min(n, M);
    var nextT = n * I; if (isFinite(T)) nextT = Math.min(nextT, T);
    var toNext = Math.max(0, nextT - el);
    var cdTxt = fmt(Math.ceil(toNext / 1000 - 1e-6));
    setText(ui.interval, 'int', isFinite(M) ? 'Interval ' + n + ' of ' + M : 'Interval ' + n);
    setText(ui.label, 'lbl', run.state === 'paused' ? 'Paused' : (isFinite(T) && nextT === T ? 'Session ends in' : 'Next chime in'));
    setText(ui.count, 'cnt', cdTxt);
    setText(ui.elapsed, 'el', fmt(el / 1000));
    setText(ui.remaining, 'rem', isFinite(T) ? fmt(Math.ceil((T - el) / 1000 - 1e-6)) : '∞');
    var segStart = (n - 1) * I, segLen = nextT - segStart;
    setWidth(ui.ibar, 'ib', segLen > 0 ? Math.min(100, (el - segStart) / segLen * 100) : 0);
    ui.tbarWrap.hidden = !isFinite(T);
    if (isFinite(T)) setWidth(ui.tbar, 'tb', Math.min(100, el / T * 100));
    setText(ui.pause, 'pause', run.state === 'paused' ? 'Resume' : 'Pause');
    document.title = cdTxt + ' · Interval Chime';
  }

  var flashTimer = 0;
  function flash(end) {
    ui.flash.classList.toggle('end', !!end);
    ui.flash.classList.add('on');
    clearTimeout(flashTimer);
    flashTimer = setTimeout(function () { ui.flash.classList.remove('on'); }, 120);
  }

  // ---------- wake lock ----------
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

  // ---------- media session (lock screen / Control Center) ----------
  function updateMediaSession() {
    if (!('mediaSession' in navigator) || !settings.override) return;
    try {
      var M = totalIntervals(), n = Math.min(run.firedIdx + 1, M);
      navigator.mediaSession.metadata = new MediaMetadata({
        title: 'Interval Chime',
        artist: 'Every ' + fmtDur(run.intervalMs / 1000) + ' · interval ' + n + (isFinite(M) ? ' of ' + M : ''),
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

  // ---------- init ----------
  function init() {
    ['setup', 'run', 'summary', 'flash'].forEach(function (id) { ui[id] = $(id); });
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

    buildButtons(ui.intBtns, INTERVALS, 'interval', [{ v: 'custom', label: 'Custom', cls: 'wide' }]);
    var sesExtra = [{ v: 'custom', label: 'Custom', cls: 'wide-half' }, { v: 'open', label: 'Until I stop', cls: 'wide-two' }];
    buildButtons(ui.sesBtns, SESSIONS, 'session', sesExtra);

    function onNum() {
      settings.ciMin = clampInt(ui.ciMin.value, 0, 180, 0);
      settings.ciSec = clampInt(ui.ciSec.value, 0, 59, 0);
      settings.csMin = clampInt(ui.csMin.value, 1, 600, 1);
      save(); renderSetup();
    }
    [ui.ciMin, ui.ciSec, ui.csMin].forEach(function (inp) {
      inp.addEventListener('input', onNum);
      inp.addEventListener('blur', function () { onNum(); inp.value = inp === ui.ciMin ? settings.ciMin : inp === ui.ciSec ? settings.ciSec : settings.csMin; });
      inp.addEventListener('keydown', function (e) { if (e.key === 'Enter') inp.blur(); });
    });
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

    renderSetup();

    if ('serviceWorker' in navigator && location.protocol !== 'file:') {
      navigator.serviceWorker.register('sw.js').then(function (reg) {
        log({ type: 'sw-registered', scope: reg.scope });
      }).catch(function (e) { log({ type: 'sw-error', msg: String(e) }); });
    }
  }

  // Test hook (harmless in production; no data leaves the device).
  window.__chime = {
    log: testLog,
    state: function () {
      return { state: run.state, elapsed: Math.round(elapsedMs()), firedIdx: run.firedIdx, schedIdx: run.schedIdx,
        intervalMs: run.intervalMs, totalMs: isFinite(run.totalMs) ? run.totalMs : null,
        ctxState: ctx && ctx.state, ctxTime: ctx && ctx.currentTime, pendingEvents: events.length, wakeLock: !!wakeLock };
    },
    settings: function () { return JSON.parse(JSON.stringify(settings)); }
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
