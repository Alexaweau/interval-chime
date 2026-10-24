/* Interval Chime: plain JS, no dependencies, no tracking.
   Two alternating intervals (work, rest), or a pasted workout.
   A chime marks the end of each interval. A pasted plan is a sequence of
   steps: chime and speak at each step, and a chime each minute inside a
   long step. A triple chime marks the end of the session. */
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

  // ---------- pasted workout ----------
  var MAX_BLOCK_S = 6 * 3600;
  var DUR_SRC = '(\\d+:\\d{1,2}(?::\\d{2})?|\\d+(?:\\.\\d+)?\\s*(?:hours?|hrs?|hr|h|minutes?|mins?|min|m|seconds?|secs?|sec|s))';
  var NAME_DUR_RE = new RegExp('^(.+?)\\s*[,\\-]\\s*' + DUR_SRC + '\\s*$', 'i');
  var REST_PATTERNS = [
    /rest(?:ing)?\s+(.+?)\s+after\s+(?:each|every)\s+(.+?)(?=[.]|$)/i,
    /(.+?)\s+rest\s+after\s+(?:each|every)\s+(.+?)(?=[.]|$)/i
  ];
  var workoutPlan = { ok: false, blocks: [], steps: [], errors: [], totalSeconds: 0 };
  var activeUtterance = null;
  var speechPulse = 0;

  function parseDurationToken(raw) {
    if (raw == null) return null;
    var str = String(raw).trim().toLowerCase().replace(/\.\s*$/, '').replace(/\s+/g, ' ');
    if (!str) return null;
    var m = str.match(/^(\d+):(\d{1,2})(?::(\d{2}))?$/);
    if (m) {
      var a = +m[1], b = +m[2], c = m[3] != null ? +m[3] : null;
      if (b > 59 || (c != null && c > 59)) return null;
      var sec = c == null ? a * 60 + b : a * 3600 + b * 60 + c;
      return sec > 0 ? sec : null;
    }
    m = str.match(/^(\d+(?:\.\d+)?)\s*(hours?|hrs?|hr|h|minutes?|mins?|min|m|seconds?|secs?|sec|s)$/);
    if (!m) return null;
    var n = parseFloat(m[1]);
    if (!(n > 0) || !isFinite(n)) return null;
    var unit = m[2];
    var mult = /^h/.test(unit) ? 3600 : (/^m/.test(unit) ? 60 : 1);
    var out = Math.round(n * mult);
    return out > 0 ? out : null;
  }
  function parseDurationLoose(raw) {
    var exact = parseDurationToken(raw);
    if (exact) return exact;
    var re = new RegExp(DUR_SRC + '\\s*$', 'i');
    var m = String(raw || '').trim().match(re);
    return m ? parseDurationToken(m[1]) : null;
  }
  function cleanLine(raw) {
    var line = String(raw || '').replace(/\u00A0/g, ' ').replace(/[\u2018\u2019]/g, "'").replace(/[\u201C\u201D]/g, '"').replace(/[\u2013\u2014]/g, '-').trim();
    if (!line) return '';
    line = line.replace(/^#+\s*/, '');
    line = line.replace(/^\d+\s*[.)]\s*/, '');
    line = line.replace(/^[•·‣∙]\s*/, '');
    line = line.replace(/^[-*]\s+/, '');
    line = line.replace(/\*\*|__/g, '').replace(/\*/g, '').trim();
    return line;
  }
  function indexOfCueColon(s, from) {
    for (var k = from; k < s.length; k++) {
      if (s.charAt(k) !== ':') continue;
      var prev = k > 0 ? s.charAt(k - 1) : '';
      var next = k + 1 < s.length ? s.charAt(k + 1) : '';
      if (/[0-9]/.test(prev) && /[0-9]/.test(next)) continue;
      return k;
    }
    return -1;
  }
  function splitHeaderCue(line) {
    var i = indexOfCueColon(line, 0);
    if (i < 0) return { header: line.trim(), cue: '' };
    return { header: line.slice(0, i).trim(), cue: line.slice(i + 1).trim() };
  }
  function headerHasDuration(header) {
    var h = String(header || '').replace(/[.]+$/g, '').trim();
    if (!h) return false;
    var split = stripTrailingParen(h);
    if (takeRounds(split.main, split.paren)) return true;
    if (parseSimple(split.main)) return true;
    var parenDur = split.paren ? parseDurationToken(split.paren) : null;
    var parenName = cleanName(split.main);
    return !!(parenDur && parenName && nameOk(parenName));
  }
  function splitDashCue(line) {
    var start = 0;
    var idx;
    while ((idx = line.indexOf(' - ', start)) !== -1) {
      var left = line.slice(0, idx).trim();
      var right = line.slice(idx + 3).trim();
      if (right && headerHasDuration(left)) return { header: left, cue: right };
      start = idx + 3;
    }
    return null;
  }
  function stripTrailingParen(s) {
    var m = s.match(/^(.*\S)\s*\(([^()]*)\)\s*$/);
    if (!m) return { main: s.trim(), paren: '' };
    return { main: m[1].trim(), paren: m[2].trim() };
  }
  function cleanName(name) {
    return String(name || '').replace(/[\s,;:-]+$/g, '').replace(/^\s*[-]\s*/, '').replace(/^["']+|["']+$/g, '').replace(/\s+for$/i, '').trim();
  }
  function nameOk(name) {
    var n = String(name || '').trim();
    if (!n) return false;
    if (/[.!?]/.test(n)) return false;
    if (n.length > 48) return false;
    if (n.split(/\s+/).length > 6) return false;
    return true;
  }
  function parseRounds(header) {
    var re = new RegExp(
      '^(.*?)(?:[,\\-]\\s*|\\s+)?(\\d+)\\s+rounds?(?:\\s+of)?\\s+' + DUR_SRC +
      '\\s+(?:on|work)(?:\\s*(?:/|,|and)\\s*|\\s+)' + DUR_SRC + '\\s+(?:off|rest)\\s*$',
      'i'
    );
    var m = header.match(re);
    if (!m) return null;
    var name = cleanName(m[1]);
    var n = parseInt(m[2], 10);
    var onSec = parseDurationToken(m[3]);
    var offSec = parseDurationToken(m[4]);
    if (!(n > 0) || n > 300 || !onSec || !offSec) return null;
    if (name && !nameOk(name)) return null;
    if (n * (onSec + offSec) > MAX_BLOCK_S) return null;
    return { name: name || 'Work', rounds: n, onSec: onSec, offSec: offSec };
  }
  function parseRepeat(header) {
    var re = new RegExp(
      '^(.*?)(?:[,\\-]\\s*|\\s+)?(\\d+)\\s*[x×]\\s*' + DUR_SRC +
      '\\s*(?:on|work)?\\s*(?:/|,|and)\\s*' + DUR_SRC + '\\s*(?:off|rest)?\\s*$',
      'i'
    );
    var m = header.match(re);
    if (!m) return null;
    var name = cleanName(m[1]);
    var n = parseInt(m[2], 10);
    var onSec = parseDurationToken(m[3]);
    var offSec = parseDurationToken(m[4]);
    if (!(n > 0) || n > 300 || !onSec || !offSec) return null;
    if (name && !nameOk(name)) return null;
    if (n * (onSec + offSec) > MAX_BLOCK_S) return null;
    return { name: name || 'Work', rounds: n, onSec: onSec, offSec: offSec };
  }
  function parseOnOffFor(header) {
    var re = new RegExp(
      '^(.*?)(?:[,\\-]\\s*|\\s+)?' + DUR_SRC +
      '\\s*(?:on|work)(?:\\s*(?:/|,|and)\\s*|\\s+)' + DUR_SRC +
      '\\s*(?:off|rest)?\\s+for\\s+' + DUR_SRC + '\\s*$',
      'i'
    );
    var m = header.match(re);
    if (!m) return null;
    var name = cleanName(m[1]);
    var onSec = parseDurationToken(m[2]);
    var offSec = parseDurationToken(m[3]);
    var total = parseDurationToken(m[4]);
    if (!onSec || !offSec || !total) return null;
    if (name && !nameOk(name)) return null;
    if (total > MAX_BLOCK_S) return null;
    return { name: name || 'Work', seconds: total, workSec: onSec, restSec: offSec };
  }
  function parseSimple(header) {
    var re = new RegExp('^(.*\\S)\\s+' + DUR_SRC + '\\s*$', 'i');
    var m = header.match(re);
    if (!m) return null;
    var name = cleanName(m[1]);
    var seconds = parseDurationToken(m[2]);
    if (!name || !nameOk(name) || !seconds) return null;
    if (seconds > MAX_BLOCK_S) return null;
    return { name: name, seconds: seconds };
  }
  function roundList(raw) {
    var text = String(raw || '').toLowerCase().replace(/\band\b/g, ',').replace(/\bto\b/g, '-');
    var bits = text.split(',');
    var nums = [];
    var i, bit, range, a, b, n, one, tmp;
    for (i = 0; i < bits.length; i++) {
      bit = bits[i];
      range = bit.match(/(\d+)\s*-\s*(\d+)/);
      if (range) {
        a = parseInt(range[1], 10);
        b = parseInt(range[2], 10);
        if (a > b) { tmp = a; a = b; b = tmp; }
        if (b - a > 40) continue;
        for (n = a; n <= b; n++) nums.push(n);
      } else {
        one = bit.match(/(\d+)/);
        if (one) nums.push(parseInt(one[1], 10));
      }
    }
    return nums;
  }
  function roundNotes(cue) {
    var notes = {};
    var re = /(?:^|[.]\s*)(?:in\s+)?rounds?\s+([0-9][0-9,\s\-toand]*)[,:]?\s*([^.]*)/gi;
    var m, nums, note, i;
    while ((m = re.exec(String(cue || '')))) {
      nums = roundList(m[1]);
      note = tidyCue(m[2]).replace(/^[,\s]+|[.\s]+$/g, '');
      if (!note) continue;
      for (i = 0; i < nums.length; i++) notes[nums[i]] = note;
    }
    return notes;
  }
  function findOnOffPattern(text) {
    var re = new RegExp(
      DUR_SRC + '\\s*(?:on|work)(?:\\s*(?:/|,|and)\\s*|\\s+)' + DUR_SRC + '\\s*(?:off|rest)?',
      'i'
    );
    var m = String(text || '').match(re);
    if (!m) return null;
    var onSec = parseDurationToken(m[1]);
    var offSec = parseDurationToken(m[2]);
    if (!onSec || !offSec) return null;
    return { match: m[0], onSec: onSec, offSec: offSec };
  }
  function findRestPattern(text) {
    for (var i = 0; i < REST_PATTERNS.length; i++) {
      var m = text.match(REST_PATTERNS[i]);
      if (m) return { match: m[0], restRaw: m[1], everyRaw: m[2] };
    }
    return null;
  }
  function expandOnOff(total, work, rest) {
    var out = [];
    var left = total;
    var guard = 0;
    while (left > 0 && guard++ < 500) {
      var w = Math.min(work, left);
      if (!(w > 0)) break;
      out.push({ kind: 'work', seconds: w });
      left -= w;
      if (!(left > 0)) break;
      var r = Math.min(rest, left);
      if (!(r > 0)) break;
      out.push({ kind: 'rest', seconds: r });
      left -= r;
    }
    return out;
  }
  function clipSpeech(text, seconds) {
    var maxChars = Math.max(24, Math.floor((seconds || 1) * 14));
    if (!text || text.length <= maxChars) return text;
    var cut = text.slice(0, maxChars);
    var sp = cut.lastIndexOf(' ');
    if (sp > 20) cut = cut.slice(0, sp);
    return cut.replace(/[.,;:\s]+$/g, '') + '.';
  }
  function speakFor(step) {
    if (step.kind === 'rest') return 'Rest';
    var head = step.name;
    if (step.block && step.block !== step.name && step.name.indexOf(step.block) !== 0) head = step.block + '. ' + step.name;
    var text = step.cue ? head + '. ' + step.cue : head;
    return clipSpeech(text, step.seconds);
  }
  function makeStep(block, name, cue, seconds, kind) {
    var step = { block: block, name: name, cue: cue || '', seconds: seconds, kind: kind };
    step.speak = speakFor(step);
    return step;
  }
  function tidyCue(cue) {
    return String(cue || '').replace(/\s+/g, ' ').replace(/\s+([.])/g, '$1').replace(/(?:[.] ?){2,}/g, '. ').replace(/^[\s.,;:-]+/, '').trim();
  }
  function takeRounds(header, paren) {
    var rounds = parseRounds(header);
    if (!rounds) rounds = parseRepeat(header);
    if (!rounds) return null;
    var noted = paren ? parseDurationToken(paren) : null;
    var sum = rounds.rounds * (rounds.onSec + rounds.offSec);
    var warning = '';
    if (noted && Math.abs(noted - sum) > 1) warning = 'Adds up to ' + fmt(sum) + ', the note says ' + fmt(noted) + '.';
    return {
      name: rounds.name, rounds: rounds.rounds,
      onSec: rounds.onSec, offSec: rounds.offSec, warning: warning
    };
  }
  function parseWorkoutLine(raw) {
    var line = cleanLine(raw);
    if (!line) return null;
    var parts = splitHeaderCue(line);
    if (!parts.cue) {
      var dashed = splitDashCue(line);
      if (dashed) parts = dashed;
    }
    var header = parts.header.replace(/[.]+$/g, '').trim();
    var cue = parts.cue;
    if (!header) return null;
    var split = stripTrailingParen(header);
    var rounds = takeRounds(split.main, split.paren);
    if (!rounds && !split.paren) rounds = takeRounds(header, '');
    if (rounds) {
      rounds.cue = tidyCue(cue);
      return rounds;
    }
    var timed = parseOnOffFor(split.main);
    if (!timed && !split.paren) timed = parseOnOffFor(header);
    if (timed) {
      timed.cue = tidyCue(cue);
      return timed;
    }
    if (/\d+\s+rounds?\b/i.test(header)) return null;
    var simple = parseSimple(split.main);
    var parenDur = split.paren ? parseDurationToken(split.paren) : null;
    var parenName = cleanName(split.main);
    if (!simple && parenDur && parenName && nameOk(parenName)) simple = { name: parenName, seconds: parenDur };
    if (!simple) return null;
    var restHit = findRestPattern(cue) || findRestPattern(header);
    var restSec = 0, everySec = 0;
    if (restHit) {
      restSec = parseDurationLoose(restHit.restRaw);
      everySec = parseDurationLoose(restHit.everyRaw);
      if (!restSec || !everySec) restHit = null;
    }
    if (restHit) {
      return {
        name: simple.name, cue: tidyCue(cue.replace(restHit.match, '')), seconds: simple.seconds,
        workSec: everySec, restSec: restSec
      };
    }
    var onOff = findOnOffPattern(cue);
    if (!onOff) onOff = findOnOffPattern(header);
    if (onOff) {
      var leftCue = cue.replace(onOff.match, '').replace(/^[\s.,;:-]+/, '');
      return {
        name: simple.name, cue: tidyCue(leftCue), seconds: simple.seconds,
        workSec: onOff.onSec, restSec: onOff.offSec
      };
    }
    return { name: simple.name, cue: tidyCue(cue), seconds: simple.seconds };
  }
  function expandParsed(parsed) {
    var steps = [];
    var i, j, seg, step, notes;
    if (parsed.rounds) {
      notes = roundNotes(parsed.cue);
      for (i = 1; i <= parsed.rounds; i++) {
        step = makeStep(parsed.name, 'Round ' + i + ' of ' + parsed.rounds + ', work', parsed.cue, parsed.onSec, 'work');
        step.speak = notes[i] ? ('Round ' + i + ', ' + notes[i]) : ('Round ' + i);
        steps.push(step);
        steps.push(makeStep(parsed.name, 'Rest', '', parsed.offSec, 'rest'));
      }
    } else if (parsed.workSec) {
      var segs = expandOnOff(parsed.seconds, parsed.workSec, parsed.restSec);
      for (j = 0; j < segs.length; j++) {
        seg = segs[j];
        if (seg.kind === 'rest') steps.push(makeStep(parsed.name, 'Rest', '', seg.seconds, 'rest'));
        else steps.push(makeStep(parsed.name, parsed.name, parsed.cue, seg.seconds, 'work'));
      }
    } else {
      steps.push(makeStep(parsed.name, parsed.name, parsed.cue, parsed.seconds, 'work'));
    }
    var seconds = 0;
    for (i = 0; i < steps.length; i++) seconds += steps[i].seconds;
    return { name: parsed.name, cue: parsed.cue, seconds: seconds, warning: parsed.warning || '', steps: steps };
  }
  function cleanedHeader(raw) {
    return cleanLine(raw).replace(/[.]+$/g, '').trim();
  }
  function hasSentencePunct(header) {
    return /[.!?]/.test(String(header || '').replace(/\d+\.\d+/g, ''));
  }
  function commaOrDashDuration(header) {
    var m = String(header || '').match(NAME_DUR_RE);
    if (!m) return false;
    var name = cleanName(m[1]);
    return !!(name && nameOk(name) && parseDurationToken(m[2]));
  }
  // A header we can see even in the middle of a sentence: "Name, 5 min",
  // "Name (5 min)", rounds, Nx, or on/off-for. Space-only "Name 5 min" is
  // included when it is already at a line start or right after .!? so a
  // collapsed paste still splits, without treating a duration inside a cue
  // ("20s on/10s off", "rest 10 seconds after each") as the next step.
  function strongStepHeader(header) {
    var split = stripTrailingParen(header);
    if (takeRounds(split.main, split.paren)) return true;
    if (!split.paren && takeRounds(header, '')) return true;
    if (parseOnOffFor(split.main)) return true;
    if (!split.paren && parseOnOffFor(header)) return true;
    if (split.paren && parseDurationToken(split.paren)) {
      var parenName = cleanName(split.main);
      if (parenName && nameOk(parenName)) return true;
    }
    return commaOrDashDuration(header);
  }
  function atWordStart(s, i) {
    if (i < 0 || i >= s.length) return false;
    var c = s.charAt(i);
    if (c === ' ' || c === '\t' || c === '\n') return false;
    if (i === 0) return true;
    return !/[A-Za-z0-9]/.test(s.charAt(i - 1));
  }
  function isAtLineStart(s, i) {
    var j = i;
    while (j > 0 && (s.charAt(j - 1) === ' ' || s.charAt(j - 1) === '\t')) j--;
    return j === 0 || s.charAt(j - 1) === '\n';
  }
  function followsSentenceEnd(s, i) {
    var j = i - 1;
    while (j >= 0 && (s.charAt(j) === ' ' || s.charAt(j) === '\t')) j--;
    if (j < 0) return false;
    var c = s.charAt(j);
    return c === '.' || c === '!' || c === '?';
  }
  function acceptsStepHeader(raw, s, i) {
    var header = cleanedHeader(raw);
    if (!header || header.length > 120 || hasSentencePunct(header)) return false;
    if (strongStepHeader(header)) return true;
    if (!(followsSentenceEnd(s, i) || isAtLineStart(s, i))) return false;
    return headerHasDuration(header);
  }
  function findStepHeader(s, from) {
    for (var i = from; i < s.length; i++) {
      if (!atWordStart(s, i)) continue;
      var colon = indexOfCueColon(s, i);
      if (colon < 0) return null;
      var raw = s.slice(i, colon);
      if (raw.indexOf('\n') !== -1 || raw.length > 160) continue;
      if (acceptsStepHeader(raw, s, i)) return { start: i, colon: colon };
    }
    return null;
  }
  // Pasted chat messages sometimes lose line breaks, including the space after
  // a period ("worse.Rings, 3 min:"). Break before each step header so the
  // next line's duration is not parsed as part of this step's cue.
  function breakBeforeStepHeaders(s) {
    var cuts = [];
    var i = 0;
    var guard = 0;
    var found, next, n, at;
    while (i < s.length && guard++ < 400) {
      found = findStepHeader(s, i);
      if (!found || found.start < i || found.colon < found.start) break;
      if (!isAtLineStart(s, found.start)) cuts.push(found.start);
      next = found.colon + 1;
      if (next <= i) break;
      i = next;
    }
    for (n = cuts.length - 1; n >= 0; n--) {
      at = cuts[n];
      s = s.slice(0, at) + '\n' + s.slice(at);
    }
    return s;
  }
  function prepareWorkoutText(text) {
    var s = String(text || '').replace(/^\uFEFF/, '');
    s = s.replace(/\u2028/g, '\n').replace(/\u2029/g, '\n');
    s = s.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    s = s.replace(/\u00A0/g, ' ');
    return breakBeforeStepHeaders(s);
  }
  function parseWorkout(text) {
    var blocks = [], steps = [], errors = [];
    var lines = prepareWorkoutText(text).split('\n');
    for (var i = 0; i < lines.length; i++) {
      if (!String(lines[i] || '').trim()) continue;
      if (blocks.length >= 200) break;
      var parsed = parseWorkoutLine(lines[i]);
      if (!parsed || parsed.error) continue;
      var block = expandParsed(parsed);
      blocks.push(block);
      for (var s = 0; s < block.steps.length; s++) steps.push(block.steps[s]);
    }
    var total = 0;
    for (var t = 0; t < steps.length; t++) total += steps[t].seconds;
    return { ok: steps.length > 0, blocks: blocks, steps: steps, errors: errors, totalSeconds: total };
  }
  function clearNode(node) { while (node.firstChild) node.removeChild(node.firstChild); }
  function workoutSummaryText(plan) {
    var n = plan.steps.length;
    var parts = [n + (n === 1 ? ' step' : ' steps'), fmt(plan.totalSeconds || 0)];
    if (plan.errors.length) {
      var k = plan.errors.length;
      parts.push(k + (k === 1 ? ' line needs a fix' : ' lines need a fix'));
    }
    return parts.join(' · ');
  }
  function renderBlock(b) {
    var box = document.createElement('div');
    box.className = 'wk-block' + (b.error ? ' bad' : '');
    if (b.error) {
      var why = document.createElement('div');
      why.className = 'why';
      why.textContent = 'Line ' + b.line + ': ' + b.reason;
      var raw = document.createElement('div');
      raw.className = 'wk-cue';
      raw.textContent = b.text;
      box.appendChild(why);
      box.appendChild(raw);
      return box;
    }
    var head = document.createElement('div');
    head.className = 'wk-head';
    var nm = document.createElement('span');
    nm.textContent = b.name;
    var tm = document.createElement('span');
    tm.className = 'tm';
    tm.textContent = fmt(b.seconds);
    head.appendChild(nm);
    head.appendChild(tm);
    box.appendChild(head);
    if (b.steps.length > 1) {
      var ul = document.createElement('ul');
      ul.className = 'wk-sub';
      b.steps.forEach(function (s) {
        var li = document.createElement('li');
        var a = document.createElement('span');
        a.textContent = s.name;
        var c = document.createElement('span');
        c.className = 'tm';
        c.textContent = fmt(s.seconds);
        li.appendChild(a);
        li.appendChild(c);
        ul.appendChild(li);
      });
      box.appendChild(ul);
    }
    if (b.cue) {
      var cue = document.createElement('div');
      cue.className = 'wk-cue';
      cue.textContent = b.cue;
      box.appendChild(cue);
    }
    if (b.warning) {
      var w = document.createElement('div');
      w.className = 'wk-warn';
      w.textContent = b.warning;
      box.appendChild(w);
    }
    return box;
  }
  function renderWorkoutPreview() {
    if (!ui.workoutPreview || !ui.workoutText || !ui.workoutStart) return;
    clearNode(ui.workoutPreview);
    ui.workoutStart.hidden = false;
    ui.workoutStart.textContent = 'Start';
    var plan = workoutPlan;
    if (!plan.steps.length) {
      ui.workoutPreview.hidden = true;
      ui.workoutStart.disabled = true;
      return;
    }
    ui.workoutPreview.hidden = false;
    ui.workoutStart.disabled = false;
    var totalLine = document.createElement('p');
    totalLine.className = 'summary workout-total';
    totalLine.textContent = workoutSummaryText(plan);
    ui.workoutPreview.appendChild(totalLine);
    plan.blocks.forEach(function (b) { ui.workoutPreview.appendChild(renderBlock(b)); });
  }
  function onWorkoutInput() {
    workoutPlan = parseWorkout(ui.workoutText.value);
    renderWorkoutPreview();
  }

  function ensureSpeechPulse() {
    if (speechPulse || !window.speechSynthesis) return;
    speechPulse = setInterval(function () {
      try {
        if (window.speechSynthesis && (speechSynthesis.speaking || speechSynthesis.pending)) speechSynthesis.resume();
      } catch (e) { /* ignore */ }
    }, 5000);
  }
  function unlockSpeech() {
    if (!window.speechSynthesis) return;
    try { window.speechSynthesis.getVoices(); } catch (e) { /* ignore */ }
    try { window.speechSynthesis.resume(); } catch (e) { /* ignore */ }
    ensureSpeechPulse();
  }
  function stopSpeech() {
    activeUtterance = null;
    try {
      if (window.speechSynthesis && (speechSynthesis.speaking || speechSynthesis.pending)) speechSynthesis.cancel();
    } catch (e) { /* ignore */ }
  }
  function speak(text) {
    var synth = window.speechSynthesis;
    if (!synth || !window.SpeechSynthesisUtterance || !text) return;
    var u;
    try { u = new SpeechSynthesisUtterance(text); } catch (e) { log({ type: 'speech-error', msg: String(e) }); return; }
    u.lang = 'en-US';
    u.rate = 1;
    var vol = Number(settings.volume);
    if (!isFinite(vol)) vol = 0.9;
    u.volume = Math.min(1, Math.max(0.5, vol));
    activeUtterance = u;
    ensureSpeechPulse();
    try { synth.resume(); } catch (e) { /* ignore */ }
    try {
      if (synth.speaking || synth.pending) {
        try { synth.cancel(); } catch (e) { /* ignore */ }
        setTimeout(function () {
          if (activeUtterance !== u) return;
          try { synth.resume(); synth.speak(u); } catch (err) { log({ type: 'speech-error', msg: String(err) }); }
        }, 60);
      } else {
        synth.speak(u);
      }
      log({ type: 'speak', text: text });
    } catch (err) {
      log({ type: 'speech-error', msg: String(err) });
    }
  }

  // ---------- session engine ----------
  var run = {
    state: 'idle', mode: 'intervals', workMs: 60000, restMs: 30000, totalMs: 900000, leadIn: false,
    startPerf: 0, pausedElapsed: 0, firedIdx: 0, schedIdx: 0, cues: [], steps: [], announcedStep: -1,
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
      var silent = cue.kind === 'warn' || cue.noChime;
      if (!silent) leadIns(cue.t, prev);
      var a = at(cue.t);
      if (a === null) continue;
      if (cue.kind === 'end') {
        playEnd(a);
        log({ type: 'sched-end', t: cue.t, audio: +a.toFixed(3) });
      } else if (!silent) {
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
    run.mode = 'intervals';
    run.steps = [];
    run.announcedStep = -1;
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
    stopSpeech();
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
    run.mode = 'intervals';
    cancelSounds(false);
    stopSpeech();
    stopKeepAlive();
    releaseWakeLock();
    clearMediaSession();
    showSetup();
  }
  function finishSession() {
    var workout = run.mode === 'workout';
    run.pausedElapsed = run.totalMs;
    run.state = 'done';
    log({ type: 'end', elapsed: Math.round(run.totalMs) });
    flash(true);
    if (workout) speak('Done');
    releaseWakeLock();
    setTimeout(function () { if (run.state === 'done' || run.state === 'idle') stopKeepAlive(); }, 7000);
    clearMediaSession();
    render();
  }

  function cueRank(kind) {
    if (kind === 'step') return 0;
    if (kind === 'warn') return 2;
    if (kind === 'end') return 3;
    return 1;
  }
  function buildWorkoutCues() {
    run.cues = [];
    var t = 0;
    for (var i = 0; i < run.steps.length; i++) {
      var dur = run.steps[i].seconds * 1000;
      run.cues.push({ t: t, kind: 'step', step: i, phase: run.steps[i].kind, noChime: i === 0 });
      var m = 60000;
      while (m < dur - 250) {
        run.cues.push({ t: t + m, kind: 'minute', step: i, phase: 'minute' });
        m += 60000;
      }
      if (dur >= 20000) {
        var warnAt = dur - 10000;
        if (warnAt >= 8000) run.cues.push({ t: t + warnAt, kind: 'warn', step: i, phase: 'warn' });
      }
      t += dur;
    }
    run.cues.push({ t: t, kind: 'end', phase: 'end' });
    run.cues.sort(function (a, b) {
      if (a.t !== b.t) return a.t - b.t;
      return cueRank(a.kind) - cueRank(b.kind);
    });
  }
  function workoutAt(el) {
    var steps = run.steps || [];
    var t = 0;
    var clamped = Math.max(0, el);
    for (var i = 0; i < steps.length; i++) {
      var dur = steps[i].seconds * 1000;
      if (clamped < t + dur || i === steps.length - 1) {
        return { index: i, stepStart: t, stepEnd: t + dur, step: steps[i] };
      }
      t += dur;
    }
    return { index: 0, stepStart: 0, stepEnd: 0, step: null };
  }
  function fireWorkoutCues(el) {
    var flashed = false;
    while (run.firedIdx < run.cues.length) {
      var cue = run.cues[run.firedIdx];
      if (!cue || cue.kind === 'end' || cue.t > el) break;
      run.firedIdx++;
      if (cue.kind === 'step') {
        cue.noChime = true;
        flashed = true;
        if (run.announcedStep !== cue.step) {
          run.announcedStep = cue.step;
          speak(run.steps[cue.step].speak);
        }
        log({ type: 'chime', k: cue.step + 1, expected: cue.t, elapsed: Math.round(el), missed: 0, phase: run.steps[cue.step].kind });
      } else if (cue.kind === 'minute') {
        flashed = true;
        log({ type: 'chime', k: cue.step + 1, expected: cue.t, elapsed: Math.round(el), missed: 0, phase: 'minute' });
      } else if (cue.kind === 'warn') {
        speak('10 seconds');
        log({ type: 'warn', t: cue.t, elapsed: Math.round(el), text: '10 seconds' });
      }
    }
    if (flashed) {
      flash(false);
      if (navigator.vibrate) { try { navigator.vibrate(200); } catch (e) {} }
      updateMediaSession();
    }
  }
  function copyWorkoutSteps(source) {
    var steps = [];
    var totalSec = 0;
    for (var i = 0; i < source.length; i++) {
      var src = source[i];
      if (!(src.seconds > 0)) return null;
      steps.push({ block: src.block, name: src.name, cue: src.cue, seconds: src.seconds, kind: src.kind, speak: src.speak });
      totalSec += src.seconds;
    }
    if (!(totalSec > 0)) return null;
    return { steps: steps, totalSec: totalSec };
  }
  function startWorkout(again) {
    var source = again ? run.steps : (workoutPlan && workoutPlan.steps);
    if (!source || !source.length) return;
    if (!again && (!workoutPlan || !workoutPlan.ok)) return;
    if (run.state === 'running' || run.state === 'paused') return;
    var copied = copyWorkoutSteps(source);
    if (!copied) return;
    ensureAudio();
    startKeepAlive();
    unlockSpeech();
    run.mode = 'workout';
    run.steps = copied.steps;
    run.workMs = copied.steps[0].seconds * 1000;
    run.restMs = 0;
    run.totalMs = copied.totalSec * 1000;
    run.leadIn = !!settings.leadIn;
    run.announcedStep = 0;
    buildWorkoutCues();
    run.firedIdx = 0;
    run.schedIdx = 0;
    run.pausedElapsed = 0;
    run.startPerf = now() + 60;
    run.lastTickPerf = now();
    run.lastTickWall = Date.now();
    run.state = 'running';
    cancelSounds(false);
    if (ctx) playChime(ctx.currentTime + 0.03);
    speak(copied.steps[0].speak);
    scheduleAhead();
    log({ type: 'start-workout', steps: copied.steps.length, totalMs: run.totalMs });
    showRun();
    requestWakeLock();
    updateMediaSession();
    loop();
  }
  function consumeCuesThrough(t) {
    while (run.firedIdx < run.cues.length) {
      var cue = run.cues[run.firedIdx];
      if (!cue || cue.kind === 'end' || cue.t > t) break;
      if (cue.kind === 'step') cue.noChime = true;
      run.firedIdx++;
    }
  }
  function endWorkoutNow() {
    if (run.mode !== 'workout' || run.state === 'done' || run.state === 'idle') return;
    cancelSounds(false);
    ensureAudio();
    if (ctx) playEnd(ctx.currentTime + 0.03);
    run.pausedElapsed = run.totalMs;
    run.startPerf = now() - run.totalMs;
    finishSession();
  }
  function skipStep() {
    if (run.mode !== 'workout') return;
    if (run.state !== 'running' && run.state !== 'paused') return;
    var info = workoutAt(elapsedMs());
    if (!info.step) return;
    if (info.index >= run.steps.length - 1 || info.stepEnd >= run.totalMs - 1) {
      endWorkoutNow();
      return;
    }
    var nextStart = info.stepEnd;
    var nextIndex = info.index + 1;
    if (run.state === 'running') run.startPerf = now() - nextStart;
    else run.pausedElapsed = nextStart;
    cancelSounds(false);
    consumeCuesThrough(nextStart);
    run.announcedStep = nextIndex;
    ensureAudio();
    if (run.state === 'running') startKeepAlive();
    if (ctx) playChime(ctx.currentTime + 0.03);
    speak(run.steps[nextIndex].speak);
    if (run.state === 'running') {
      rewindSched(nextStart);
      scheduleAhead();
    }
    flash(false);
    if (navigator.vibrate) { try { navigator.vibrate(120); } catch (e) {} }
    log({ type: 'skip', step: nextIndex, elapsed: Math.round(nextStart) });
    render();
    updateMediaSession();
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
    if (run.mode === 'workout') {
      fireWorkoutCues(el);
    } else {
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

  function workoutKind(el) {
    var info = workoutAt(el);
    return info.step ? info.step.kind : 'work';
  }
  function renderWorkout(el, done) {
    ui.run.classList.toggle('paused', run.state === 'paused');
    ui.run.classList.toggle('done', done);
    ui.run.classList.toggle('phase-work', !done && workoutKind(el) !== 'rest');
    ui.run.classList.toggle('phase-rest', !done && workoutKind(el) === 'rest');
    ui.controls.hidden = done;
    ui.doneControls.hidden = !done;
    if (done) {
      setText(ui.interval, 'int', 'Workout complete');
      setText(ui.label, 'lbl', run.steps.length + (run.steps.length === 1 ? ' step' : ' steps'));
      setText(ui.every, 'every', fmt(run.totalMs / 1000));
      setText(ui.count, 'cnt', 'Done');
      setText(ui.elapsed, 'el', fmt(run.totalMs / 1000));
      setText(ui.remaining, 'rem', '0:00');
      setWidth(ui.ibar, 'ib', 100);
      setWidth(ui.tbar, 'tb', 100);
      ui.tbarWrap.hidden = false;
      document.title = 'Done · Interval Chime';
      return;
    }
    var info = workoutAt(Math.min(el, Math.max(0, run.totalMs - 1)));
    var step = info.step;
    if (!step) return;
    var toNext = Math.max(0, info.stepEnd - el);
    var cdTxt = fmt(Math.ceil(toNext / 1000 - 1e-6));
    var sub = '';
    if (step.cue && step.block && step.block !== step.name) sub = step.block + ' · ' + step.cue;
    else if (step.cue) sub = step.cue;
    else if (step.block && step.block !== step.name) sub = step.block;
    setText(ui.interval, 'int', step.name);
    setText(ui.label, 'lbl', run.state === 'paused' ? 'Paused' : ('Step ' + (info.index + 1) + ' of ' + run.steps.length));
    setText(ui.every, 'every', sub);
    setText(ui.count, 'cnt', cdTxt);
    setText(ui.elapsed, 'el', fmt(el / 1000));
    setText(ui.remaining, 'rem', fmt(Math.ceil(Math.max(0, run.totalMs - el) / 1000 - 1e-6)));
    var segLen = info.stepEnd - info.stepStart;
    setWidth(ui.ibar, 'ib', segLen > 0 ? Math.min(100, Math.max(0, (el - info.stepStart) / segLen * 100)) : 0);
    ui.tbarWrap.hidden = false;
    setWidth(ui.tbar, 'tb', run.totalMs > 0 ? Math.min(100, el / run.totalMs * 100) : 0);
    setText(ui.pause, 'pause', run.state === 'paused' ? 'Resume' : 'Pause');
    document.title = cdTxt + ' · ' + step.name;
  }
  function render() {
    if (ui.run.hidden) return;
    var el = Math.max(0, elapsedMs());
    var done = run.state === 'done';
    var isWorkout = run.mode === 'workout';
    ui.run.classList.toggle('workout', isWorkout);
    if (ui.skip) {
      ui.skip.hidden = !(isWorkout && !done);
      ui.controls.classList.toggle('has-skip', isWorkout && !done);
    }
    if (isWorkout) { renderWorkout(el, done); return; }
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
      var title, artist;
      if (run.mode === 'workout' && run.steps && run.steps.length) {
        var w = workoutAt(elapsedMs());
        title = w.step ? w.step.name : 'Workout';
        artist = (w.step && (w.step.cue || w.step.block)) || 'Interval Chime';
        if (artist.length > 120) artist = artist.slice(0, 117) + '...';
      } else {
        var info = phaseAt(elapsedMs());
        title = info.inWork ? 'Work' : 'Rest';
        artist = 'Round ' + info.roundNum + (isFinite(info.rounds) ? ' of ' + info.rounds : '') + ' · ' + fmt(run.workMs / 1000) + ' / ' + fmt(run.restMs / 1000);
      }
      navigator.mediaSession.metadata = new MediaMetadata({
        title: title,
        artist: artist,
        artwork: [{ src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' }]
      });
      navigator.mediaSession.playbackState = run.state === 'running' ? 'playing' : 'paused';
      navigator.mediaSession.setActionHandler('play', function () { resumeSession(); });
      navigator.mediaSession.setActionHandler('pause', function () { pauseSession(); });
      try {
        navigator.mediaSession.setActionHandler('nexttrack', run.mode === 'workout' ? function () { skipStep(); } : null);
      } catch (e2) { /* ignore */ }
    } catch (e) { /* ignore */ }
  }
  function clearMediaSession() {
    if (!('mediaSession' in navigator)) return;
    try {
      navigator.mediaSession.metadata = null;
      navigator.mediaSession.playbackState = 'none';
      navigator.mediaSession.setActionHandler('nexttrack', null);
    } catch (e) {}
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
    ui.pause = $('btn-pause'); ui.skip = $('btn-skip'); ui.stop = $('btn-stop'); ui.controls = ui.pause.parentNode;
    ui.doneControls = $('done-controls'); ui.wake = $('r-wake'); ui.audioBanner = $('audio-banner');
    ui.workoutText = $('workout-text'); ui.workoutPreview = $('workout-preview'); ui.workoutStart = $('btn-start-workout');
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
    $('btn-again').addEventListener('click', function () {
      var againWorkout = run.mode === 'workout' && run.steps && run.steps.length;
      run.state = 'idle';
      if (againWorkout) startWorkout(true);
      else startSession();
    });
    $('btn-back').addEventListener('click', function () { run.state = 'done'; stopSession(); });
    ui.workoutText.addEventListener('input', onWorkoutInput);
    ui.workoutStart.addEventListener('click', function () { startWorkout(false); });
    ui.skip.addEventListener('click', skipStep);
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
      var el = elapsedMs();
      var info = run.mode === 'workout' ? null : phaseAt(el);
      var winfo = run.mode === 'workout' ? workoutAt(el) : null;
      return {
        state: run.state, elapsed: Math.round(el), firedIdx: run.firedIdx, schedIdx: run.schedIdx,
        workMs: run.workMs, restMs: run.restMs, totalMs: isFinite(run.totalMs) ? run.totalMs : null,
        phase: run.state === 'done' ? 'done' : (run.mode === 'workout'
          ? (winfo && winfo.step ? winfo.step.kind : 'work')
          : (info.inWork ? 'work' : 'rest')),
        mode: run.mode || 'intervals',
        stepIndex: winfo ? winfo.index : null,
        stepName: winfo && winfo.step ? winfo.step.name : null,
        stepCount: run.mode === 'workout' && run.steps ? run.steps.length : null,
        ctxState: ctx && ctx.state, ctxTime: ctx && ctx.currentTime, pendingEvents: events.length, wakeLock: !!wakeLock
      };
    },
    settings: function () { return JSON.parse(JSON.stringify(settings)); },
    parseWorkout: parseWorkout,
    workoutCues: function () {
      return (run.cues || []).map(function (c) {
        return { t: c.t, kind: c.kind, step: c.step == null ? null : c.step, noChime: !!c.noChime };
      });
    }
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
