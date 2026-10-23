"""Headless verification for Interval Chime. Run: python3 tools/test_app.py [base_url]"""
import os, sys, time
from playwright.sync_api import sync_playwright

BASE = sys.argv[1] if len(sys.argv) > 1 else 'http://127.0.0.1:8765/'
SCREENS = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'screens')
os.makedirs(SCREENS, exist_ok=True)
CHROME = next(p for p in ('/usr/local/bin/google-chrome', '/usr/bin/google-chrome') if os.path.exists(p))
results = []

def check(name, ok, detail=''):
    results.append((name, bool(ok), detail))
    print(('PASS ' if ok else 'FAIL ') + name + (('  -- ' + str(detail)) if detail else ''), flush=True)

def logs(page, types=None):
    L = page.evaluate('window.__chime.log.slice()')
    return [e for e in L if types is None or e['type'] in types]

def clear_log(page):
    page.evaluate('window.__chime.log.length = 0')

def stop(page):
    page.click('#btn-stop'); page.click('#btn-stop')

def pick(page, col, sec):
    ok = page.evaluate("""([col, sec]) => {
      const el = document.querySelector('#' + col + ' .w-item[data-sec="' + sec + '"]');
      if (!el) return null;
      el.click();
      return true;
    }""", [col, sec])
    page.wait_for_timeout(40)
    return ok is True

def drag_column(page, sel, dy):
    page.locator(sel).scroll_into_view_if_needed()
    page.wait_for_timeout(40)
    box = page.locator(sel).bounding_box()
    x = box['x'] + box['width'] / 2
    y = box['y'] + box['height'] / 2
    page.mouse.move(x, y)
    page.mouse.down()
    steps = 18
    for i in range(1, steps + 1):
        page.mouse.move(x, y + dy * i / steps)
        page.wait_for_timeout(16)
    page.mouse.up()
    page.wait_for_timeout(700)

with sync_playwright() as p:
    browser = p.chromium.launch(executable_path=CHROME, headless=True,
                                args=['--autoplay-policy=no-user-gesture-required'])
    ctx = browser.new_context(viewport={'width': 390, 'height': 844}, device_scale_factor=2, is_mobile=True, has_touch=True,
                              user_agent='Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1')
    page = ctx.new_page()
    errors = []
    page.on('console', lambda m: errors.append('console.' + m.type + ': ' + m.text) if m.type in ('error', 'warning') else None)
    page.on('pageerror', lambda e: errors.append('pageerror: ' + str(e)))
    failed_req = []
    page.on('requestfailed', lambda r: failed_req.append(r.url))
    ext_req = []
    page.on('request', lambda r: ext_req.append(r.url) if not r.url.startswith(BASE.rstrip('/')) and not r.url.startswith('data:') else None)

    # ---------- 1. load, manifest, SW, main screen ----------
    page.goto(BASE, wait_until='load')
    page.wait_for_timeout(200)
    sw_scope = page.evaluate("navigator.serviceWorker.ready.then(r => r.scope)")
    check('service worker registered + ready', sw_scope.startswith(BASE), sw_scope)
    man = page.evaluate("fetch(document.querySelector('link[rel=manifest]').href).then(r => r.json())")
    check('manifest name/short_name/display', man['name'] == 'Interval Chime' and man['short_name'] == 'Chime' and man['display'] == 'standalone', man['name'] + ' / ' + man['short_name'] + ' / ' + man['display'])
    sizes = sorted(i['sizes'] for i in man['icons'])
    check('manifest icons 192 + 512', '192x192' in sizes and '512x512' in sizes, sizes)
    ati = page.evaluate("""(async () => { const l = document.querySelector('link[rel=apple-touch-icon]');
        const r = await fetch(l.href); const b = await r.blob(); const bm = await createImageBitmap(b); return [r.status, bm.width, bm.height]; })()""")
    check('apple-touch-icon 180x180', ati == [200, 180, 180], ati)
    for ic in man['icons']:
        st = page.evaluate("u => fetch(u).then(r => r.status)", ic['src'])
        check('icon fetch ' + ic['src'], st == 200)
    page.reload(wait_until='load')
    page.wait_for_timeout(150)
    controlled = page.evaluate("!!navigator.serviceWorker.controller")
    check('page controlled by SW after reload', controlled)

    s = page.evaluate('window.__chime.settings()')
    check('defaults work 60 / rest 30 / total 900 untouched',
          s['work'] == 60 and s['rest'] == 30 and s['total'] == 900 and s['totalTouched'] is False and s['open'] is False and s['leadIn'] is False, s)
    hero = page.evaluate("""() => {
      const vh = window.innerHeight;
      const below = document.getElementById('below').getBoundingClientRect();
      const wheel = document.getElementById('wheel').getBoundingClientRect();
      const start = document.getElementById('btn-start').getBoundingClientRect();
      const paste = document.getElementById('workout-text').getBoundingClientRect();
      const go = document.getElementById('btn-start-workout').getBoundingClientRect();
      const text = document.querySelector('.hero').innerText;
      const totals = [...document.querySelectorAll('#col-total .w-item')].map(el => +el.dataset.sec);
      const round = 90;
      return {
        vh, scroll: window.scrollY,
        belowTop: below.top,
        wheelTop: wheel.top, wheelH: wheel.height, wheelW: wheel.width,
        startTop: start.top, startH: start.height, startW: start.width,
        pasteTop: paste.top, pasteH: paste.height, pasteW: paste.width,
        goTop: go.top, goH: go.height, goW: go.width, goBottom: go.bottom,
        goText: document.getElementById('btn-start-workout').textContent,
        gap: start.top - wheel.bottom,
        cols: document.querySelectorAll('#wheel .col').length,
        sel: {
          work: document.querySelector('#col-work .sel') && document.querySelector('#col-work .sel').textContent,
          rest: document.querySelector('#col-rest .sel') && document.querySelector('#col-rest .sel').textContent,
          total: document.querySelector('#col-total .sel') && document.querySelector('#col-total .sel').textContent
        },
        heroText: text,
        totalsOk: totals.length > 0 && totals.every(t => t % round === 0),
        totalCount: totals.length
      };
    }""")
    check('wheel shows 1:00 / 0:30 / 15:00', hero['sel'] == {'work': '1:00', 'rest': '0:30', 'total': '15:00'}, hero['sel'])
    check('one control with three columns', hero['cols'] == 3, hero['cols'])
    check('paste box is the first thing',
          0 <= hero['pasteTop'] < 80 and hero['pasteH'] >= 120 and hero['pasteW'] >= 300 and hero['pasteTop'] < hero['wheelTop'],
          (hero['pasteTop'], hero['pasteH'], hero['pasteW']))
    check('workout Start is a large button on the first screen',
          hero['goText'] == 'Start' and hero['goH'] >= 100 and hero['goW'] >= 300 and hero['goTop'] > hero['pasteTop'] and hero['goBottom'] <= hero['vh'] + 1,
          (hero['goText'], hero['goTop'], hero['goH'], hero['goBottom'], hero['vh']))
    check('interval timer starts below the paste screen', hero['wheelTop'] >= hero['vh'] - 1, (hero['wheelTop'], hero['vh']))
    check('start directly below the picker', 0 <= hero['gap'] <= 40, hero['gap'])
    check('start is a large thumb target', hero['startH'] >= 100 and hero['startW'] >= 300, (hero['startH'], hero['startW']))
    check('settings are below the fold', hero['belowTop'] >= hero['vh'] - 1 and hero['scroll'] == 0, (hero['belowTop'], hero['vh']))
    check('main screen has no headings or instructions',
          all(w not in hero['heroText'].lower() for w in ('chime', 'interval', 'session', 'volume', 'lead', 'silent', 'lock', 'awake', 'preset')),
          hero['heroText'][:240])
    check('total column is whole rounds only', hero['totalsOk'], hero['totalCount'])
    page.screenshot(path=os.path.join(SCREENS, 'setup.png'), full_page=False)

    page.evaluate("document.getElementById('below').scrollIntoView()")
    page.wait_for_timeout(100)
    scrolled = page.evaluate("""() => {
      const below = document.getElementById('below').getBoundingClientRect();
      return { top: below.top, scroll: window.scrollY, start: document.getElementById('btn-start') !== null,
               presets: document.querySelectorAll('#interval-buttons button').length,
               lead: !!document.getElementById('opt-leadin'),
               override: !!document.getElementById('opt-override'),
               volume: !!document.getElementById('opt-volume'),
               test: !!document.getElementById('btn-test') };
    }""")
    check('scrolled settings are on screen and intact',
          scrolled['top'] < 80 and scrolled['scroll'] > 200 and scrolled['presets'] >= 4 and scrolled['lead'] and scrolled['override'] and scrolled['volume'] and scrolled['test'],
          scrolled)
    page.screenshot(path=os.path.join(SCREENS, 'setup-options.png'), full_page=False)
    page.evaluate("window.scrollTo(0, 0)")

    # thumb swipe on the work column (up moves toward longer times)
    before = page.evaluate('window.__chime.settings().work')
    drag_column(page, '#col-work', -192)
    after = page.evaluate('window.__chime.settings()')
    check('thumb swipe changes work and keeps a 5s step',
          after['work'] != before and after['work'] % 5 == 0 and after['work'] >= 70, (before, after['work'], after['total'], after['totalTouched']))
    # untouched total stays near 15:00 (round changed, still a multiple, totalTouched still false)
    check('swipe does not mark the total as touched', after['totalTouched'] is False and after['total'] % (after['work'] + after['rest']) == 0, after)

    # reset to defaults via the 1 min preset (work 60). Rest may no longer be 30 if we didn't touch it.
    page.evaluate("window.scrollTo(0, 0)")
    # restore rest if the swipe only moved work
    page.evaluate("""() => {
      const el = document.querySelector('#col-rest .w-item[data-sec="30"]');
      if (el) el.click();
    }""")
    page.click('#interval-buttons [data-v="60"]')
    s = page.evaluate('window.__chime.settings()')
    check('preset 1:00 restores work, total still near 15:00 and untouched',
          s['work'] == 60 and s['rest'] == 30 and s['total'] == 900 and s['totalTouched'] is False, s)

    # untouched snap: 2:00 work + 0:30 rest = 150s rounds, 900/150 = 6 exactly
    page.click('#interval-buttons [data-v="120"]')
    s = page.evaluate('window.__chime.settings()')
    check('untouched interval change keeps total at 15:00', s['work'] == 120 and s['rest'] == 30 and s['total'] == 900 and s['totalTouched'] is False, s)

    # touch the total via the 30 min preset, then change rest to 0:45
    page.click('#session-buttons [data-v="1800"]')
    s = page.evaluate('window.__chime.settings()')
    check('30 min preset marks total touched (exact with 150s rounds)', s['total'] == 1800 and s['totalTouched'] is True, s)
    check('pick rest 0:45', pick(page, 'col-rest', 45))
    s = page.evaluate('window.__chime.settings()')
    # round = 120+45 = 165; nearest to 1800 is 11*165 = 1815
    check('touched total snaps near the previous total', s['rest'] == 45 and s['total'] == 1815 and s['total'] % 165 == 0 and s['totalTouched'] is True, s)

    # ---------- 2. real run from a clean 1:00 / 0:30 / 15:00 ----------
    page.evaluate("localStorage.clear()")
    page.goto(BASE, wait_until='load')
    page.wait_for_timeout(150)
    s = page.evaluate('window.__chime.settings()')
    check('cleared storage restores defaults', s['work'] == 60 and s['rest'] == 30 and s['total'] == 900, s)
    page.click('#btn-start')
    page.wait_for_timeout(3300)
    st = page.evaluate('window.__chime.state()')
    check('default run: running, work phase, ctx running', st['state'] == 'running' and st['ctxState'] == 'running' and st['phase'] == 'work' and st['workMs'] == 60000 and st['restMs'] == 30000 and st['totalMs'] == 900000, st)
    cnt = page.inner_text('#r-count'); iv = page.inner_text('#r-interval'); lab = page.inner_text('#r-label')
    check('running screen shows work countdown and round 1 of 10', cnt in ('0:56', '0:57') and iv == 'Round 1 of 10' and lab == 'WORK', cnt + ' | ' + iv + ' | ' + lab)
    sched = logs(page, ['sched-chime'])
    times = []
    seen = set()
    for e in sched:
        if e['t'] not in seen:
            seen.add(e['t']); times.append(e['t'])
    times.sort()
    # 10 min lookahead from ~3.3s covers cues at 60,90,150,...,600 seconds
    expect = [60000, 90000, 150000, 180000, 240000, 270000, 330000, 360000, 420000, 450000, 510000, 540000, 600000]
    check('15 min session pre-schedules alternating chimes through 10 min', times == expect, times)
    aud = {}
    for e in sched:
        aud[e['t']] = e['audio']
    diffs = [round(aud[b] - aud[a], 3) for a, b in zip(expect, expect[1:])]
    alt = [30, 60] * 6
    check('scheduled spacing alternates rest 30s then work 60s', len(diffs) == len(alt) and all(abs(d - e) < 0.05 for d, e in zip(diffs, alt)), diffs)
    check('pause and stop buttons present during the session', page.inner_text('#btn-pause') == 'Pause' and page.inner_text('#btn-stop') == 'Stop')
    page.screenshot(path=os.path.join(SCREENS, 'running.png'))
    stop(page)
    page.wait_for_timeout(200)

    # ---------- 3. test mode: 2s work, 3s rest, 10s total ----------
    page.goto(BASE + '?test=1', wait_until='load')
    page.wait_for_timeout(100)
    page.click('#interval-buttons [data-v="2"]')
    check('pick rest 3s', pick(page, 'col-rest', 3))
    page.click('#session-buttons [data-v="10"]')
    s = page.evaluate('window.__chime.settings()')
    check('test selection 2/3/10', s['work'] == 2 and s['rest'] == 3 and s['total'] == 10, s)
    clear_log(page)
    page.click('#btn-start')
    page.wait_for_timeout(11800)
    L = logs(page)
    chimes = [e for e in L if e['type'] == 'chime']
    ends = [e for e in L if e['type'] == 'end']
    onsets = [e for e in L if e['type'] == 'onset']
    check('2/3/10: chimes at end of work, rest, work',
          [c['expected'] for c in chimes] == [2000, 5000, 7000] and [c['phase'] for c in chimes] == ['work', 'rest', 'work'],
          [(c['expected'], c['phase'], c['elapsed']) for c in chimes])
    errs = [c['elapsed'] - c['expected'] for c in chimes]
    check('chime events fire within 80 ms', all(0 <= e < 80 for e in errs), errs)
    check('end event at 10 s', len(ends) == 1 and ends[0]['elapsed'] == 10000, ends)
    on_el = [o['elapsed'] for o in onsets if o['elapsed'] is not None]
    exp = [2000, 5000, 7000]
    matched = [min(on_el, key=lambda x: abs(x - t)) if on_el else None for t in exp]
    oerr = [m - t if m is not None else None for m, t in zip(matched, exp)]
    check('measured audio onsets within 80 ms of 2/5/7 s', all(e is not None and -30 <= e <= 80 for e in oerr), {'onsets': on_el, 'err_ms': oerr})
    end_onsets = [o for o in onsets if o['perf'] >= ends[0]['perf'] - 100] if ends else []
    rel = [o['perf'] - ends[0]['perf'] for o in end_onsets] if ends else None
    check('end triple chime audible (3 strikes ~0 / 0.6 / 1.2 s after end)', rel is not None and len(rel) >= 3 and all(any(abs(r - x) < 80 for r in rel) for x in (0, 600, 1200)), rel)
    check('done screen shown', page.inner_text('#r-count') == 'Done' and page.is_visible('#btn-again'))
    page.screenshot(path=os.path.join(SCREENS, 'done.png'))
    page.click('#btn-back')

    # ---------- 4. pause / resume / stop ----------
    page.click('#interval-buttons [data-v="2"]')
    check('pick rest 2s', pick(page, 'col-rest', 2))
    page.click('#session-buttons [data-v="20"]')
    s = page.evaluate('window.__chime.settings()')
    check('pause setup 2/2/20', s['work'] == 2 and s['rest'] == 2 and s['total'] == 20, s)
    clear_log(page)
    page.click('#btn-start')
    page.wait_for_timeout(3000)
    page.click('#btn-pause')
    e1 = page.evaluate('window.__chime.state()')
    check('pause -> state paused, button says Resume', e1['state'] == 'paused' and page.inner_text('#btn-pause') == 'Resume', e1)
    check('pause cancels scheduled audio', e1['pendingEvents'] <= 2, e1['pendingEvents'])
    page.screenshot(path=os.path.join(SCREENS, 'paused.png'))
    n_on_before = len(logs(page, ['onset']))
    page.wait_for_timeout(3000)
    e2 = page.evaluate('window.__chime.state()')
    n_on_during = len(logs(page, ['onset'])) - n_on_before
    check('elapsed frozen while paused', abs(e1['elapsed'] - e2['elapsed']) <= 1, (e1['elapsed'], e2['elapsed']))
    check('no chimes while paused', n_on_during == 0 and not [c for c in logs(page, ['chime']) if c['expected'] > 2000], n_on_during)
    clear_log(page)
    page.click('#btn-pause')
    page.wait_for_timeout(4500)
    L = logs(page)
    ch = [c for c in L if c['type'] == 'chime']
    check('resume continues on the same grid (chimes at 4 s, 6 s)',
          [c['expected'] for c in ch] == [4000, 6000] and all(0 <= c['elapsed'] - c['expected'] < 80 for c in ch),
          [(c['expected'], c['elapsed'], c['phase']) for c in ch])
    on2 = [o['elapsed'] for o in L if o['type'] == 'onset' and o['elapsed'] is not None]
    check('audio onsets after resume at 4 s / 6 s', any(abs(o - 4000) < 80 for o in on2) and any(abs(o - 6000) < 80 for o in on2), on2)
    page.click('#btn-stop')
    check('first Stop tap only arms (Tap to stop)', page.inner_text('#btn-stop') == 'Tap to stop' and page.evaluate('window.__chime.state().state') == 'running')
    page.click('#btn-stop')
    check('second tap stops -> setup screen', page.is_visible('#setup') and page.evaluate('window.__chime.state().state') == 'idle')
    clear_log(page)
    page.wait_for_timeout(2500)
    check('no chimes after stop', len(logs(page, ['onset', 'chime'])) == 0, logs(page, ['onset', 'chime']))

    # ---------- 5. lead-in beeps: 5s work, 5s rest, 10s total ----------
    page.click('#interval-buttons [data-v="5"]')
    check('pick rest 5s', pick(page, 'col-rest', 5))
    page.click('#session-buttons [data-v="10"]')
    page.click('label:has(#opt-leadin)')
    s = page.evaluate('window.__chime.settings()')
    check('lead-in setup 5/5/10', s['work'] == 5 and s['rest'] == 5 and s['total'] == 10 and s['leadIn'] is True, s)
    clear_log(page)
    page.click('#btn-start')
    page.wait_for_timeout(11500)
    L = logs(page)
    beeps = sorted(set(e['t'] for e in L if e['type'] == 'sched-beep'))
    check('lead-in beeps scheduled at 2,3,4 and 7,8,9 s', beeps == [2000, 3000, 4000, 7000, 8000, 9000], beeps)
    on3 = [o['elapsed'] for o in L if o['type'] == 'onset' and o['elapsed'] is not None]
    check('lead-in beeps audible', all(any(abs(o - t) < 80 for o in on3) for t in [2000, 3000, 4000, 5000, 7000, 8000, 9000]), on3)
    page.click('#btn-back')

    # ---------- 6. custom + open-ended + persistence ----------
    page.click('#interval-buttons [data-v="custom"]')
    page.fill('#ci-min', '1'); page.fill('#ci-sec', '15')
    page.click('#session-buttons [data-v="open"]')
    page.wait_for_timeout(50)
    page.reload(wait_until='load')
    s = page.evaluate('window.__chime.settings()')
    check('settings persisted (custom 1:15, open-ended, lead-in on)',
          s['work'] == 75 and s['ciMin'] == 1 and s['ciSec'] == 15 and s['open'] is True and s['leadIn'] is True, s)
    check('custom inputs restored', page.input_value('#ci-min') == '1' and page.input_value('#ci-sec') == '15' and page.is_visible('#custom-interval'))
    check('open-ended shows infinity on the total column', page.is_visible('#total-open'))
    page.click('#btn-start'); page.wait_for_timeout(1200)
    check('open-ended run shows Round 1 and infinity remaining',
          page.inner_text('#r-interval') == 'Round 1' and page.inner_text('#r-remaining') == '∞',
          page.inner_text('#r-interval') + ' | ' + page.inner_text('#r-remaining'))
    page.screenshot(path=os.path.join(SCREENS, 'running-open-ended.png'))
    stop(page)

    page.goto(BASE, wait_until='load')
    page.click('#interval-buttons [data-v="custom"]')
    page.fill('#ci-min', '0'); page.fill('#ci-sec', '3')
    page.wait_for_timeout(50)
    check('custom < 5 s rejected (Start disabled) outside test mode', page.is_disabled('#btn-start'), page.inner_text('#summary'))
    page.click('#interval-buttons [data-v="30"]')
    # rest may still be 30 or whatever was saved; set a valid session
    page.click('#session-buttons [data-v="1800"]')
    page.click('label:has(#opt-leadin)')
    check('lead-in toggled back off', page.evaluate('window.__chime.settings().leadIn') is False)
    check('valid settings re-enable start', page.is_enabled('#btn-start'))

    # ---------- 6b. pasted workout ----------
    # 2 steady steps + 6x(work, rest) + 4x(20s work, 10s rest) + cool-down = 23 steps, 30:00.
    EXAMPLE = "\n".join([
        "1. **Rope, 3 min:** Keep it light. Stop if the Achilles feels sharp or worse.",
        "2. **Rings, 3 min:** Do the reverse-grip hang with a tennis ball in each hand.",
        "3. **Bag, 6 rounds of 2:00 on, 1:00 off (18 min):** Use jab-cross-hook. In rounds 5 and 6, push the pace.",
        "4. **Finisher, 2 min:** Fast straight punches. Rest 10 seconds after each 20 seconds.",
        "5. **Cool-down, 4 min:** Walk, then stretch your calves and hip flexors. Do not skip the cool-down.",
    ])
    parsed = page.evaluate("(t) => window.__chime.parseWorkout(t)", EXAMPLE)
    steps = parsed["steps"]
    expect_names, expect_secs, expect_kinds = [], [], []
    expect_names += ["Rope", "Rings"]
    expect_secs += [180, 180]
    expect_kinds += ["work", "work"]
    for n in range(1, 7):
        expect_names += ["Round %d of 6, work" % n, "Rest"]
        expect_secs += [120, 60]
        expect_kinds += ["work", "rest"]
    for _ in range(4):
        expect_names += ["Finisher", "Rest"]
        expect_secs += [20, 10]
        expect_kinds += ["work", "rest"]
    expect_names += ["Cool-down"]
    expect_secs += [240]
    expect_kinds += ["work"]
    check("example parses with no leftover lines", parsed["ok"] is True and parsed["errors"] == [], parsed["errors"])
    check("example expands to 23 steps", len(steps) == 23 and [s["name"] for s in steps] == expect_names, [s["name"] for s in steps])
    check("example totals 30:00",
          parsed["totalSeconds"] == 1800 and sum(s["seconds"] for s in steps) == 1800 and [s["seconds"] for s in steps] == expect_secs,
          parsed["totalSeconds"])
    check("example step kinds", [s["kind"] for s in steps] == expect_kinds, [s["kind"] for s in steps])
    check("round 3 is spoken as Round 3, later rounds get the pace note, rest is just Rest",
          steps[6]["name"] == "Round 3 of 6, work" and steps[6]["speak"] == "Round 3" and steps[10]["speak"] == "Round 5, push the pace" and steps[12]["speak"] == "Round 6, push the pace" and steps[7]["speak"] == "Rest" and steps[7]["cue"] == "",
          (steps[6]["speak"], steps[10]["speak"], steps[12]["speak"], steps[7]["speak"]))
    check("finisher rest pattern expands inside the 2:00",
          steps[14]["seconds"] == 20 and steps[15]["seconds"] == 10 and steps[14]["cue"] == "Fast straight punches." and "after each" not in steps[14]["speak"] and steps[14]["speak"] == "Finisher. Fast straight punches.",
          (steps[14]["cue"], steps[14]["speak"], steps[15]["speak"]))
    check("cool-down keeps its cue", steps[22]["cue"].startswith("Walk, then stretch") and steps[22]["seconds"] == 240, steps[22]["cue"])
    variant = "\n".join([
        "Rope - 3 min",
        "**Swing** 90 seconds: easy",
        "3) Bag, 4 rounds of 1:00 on / 0:30 off",
        "Finisher 2:00: Fast. Rest 10s after each 20 seconds",
        "Hang (3 min): easy",
        "just stretch",
    ])
    varied = page.evaluate("(t) => window.__chime.parseWorkout(t)", variant)
    check("a line with no duration is ignored",
          varied["ok"] is True and varied["errors"] == [] and len(varied["steps"]) == 19 and all("stretch" not in s["name"] for s in varied["steps"]),
          varied["errors"])
    check("forgiving durations: 3 min, 90 seconds, 2:00, 10s, 20 seconds",
          varied["steps"][0]["seconds"] == 180 and varied["steps"][1]["seconds"] == 90 and varied["steps"][10]["seconds"] == 20 and varied["steps"][11]["seconds"] == 10 and varied["steps"][-1]["name"] == "Hang",
          [(s["name"], s["seconds"]) for s in varied["steps"]])
    COACH = "\n".join([
        "Good. Do 30 minutes. Set your chime app to 1-minute chimes.",
        "Rope, 3 min: Keep it light. Stop if the Achilles feels sharp or worse.",
        "Rings, 3 min: Do the reverse-grip hang with a tennis ball in each hand.",
        "Bag, 6 rounds of 2:00 on, 1:00 off (18 min): Use jab-cross-hook. In rounds 5 and 6, push the pace.",
        "Finisher, 2 min: Fast straight punches. Rest 10 seconds after each 20 seconds.",
        "Cool-down, 4 min: Walk, then stretch your calves and hip flexors. Do not skip the cool-down.",
        "Tell me when you finish. That makes training day 2 of 3 this week.",
    ])
    coach = page.evaluate("(t) => window.__chime.parseWorkout(t)", COACH)
    coach_steps = coach["steps"]
    coach_speak = [
        "Rope. Keep it light. Stop if the Achilles feels sharp or worse.",
        "Rings. Do the reverse-grip hang with a tennis ball in each hand.",
    ]
    for n in range(1, 7):
        coach_speak.append("Round %d, push the pace" % n if n >= 5 else "Round %d" % n)
        coach_speak.append("Rest")
    for _ in range(4):
        coach_speak.append("Finisher. Fast straight punches.")
        coach_speak.append("Rest")
    coach_speak.append("Cool-down. Walk, then stretch your calves and hip flexors. Do not skip the cool-down.")
    check("coach message ignores the intro and the closing line",
          coach["ok"] is True and coach["errors"] == [] and len(coach_steps) == 23 and coach["totalSeconds"] == 1800
          and [s["name"] for s in coach_steps] == expect_names and [s["seconds"] for s in coach_steps] == expect_secs
          and all("Tell me" not in s["name"] and "Good" not in s["name"] for s in coach_steps),
          [(s["name"], s["seconds"]) for s in coach_steps])
    check("coach message speech is the step name plus the cue",
          [s["speak"] for s in coach_steps] == coach_speak,
          [s["speak"] for s in coach_steps])
    VARIATIONS = "\n".join([
        "",
        "Warm up slowly.",
        "• Rope – 3 minutes: “Keep it light.”",
        "2) Rings, 3:00 — hang",
        "Bag, 6 x 2:00 / 1:00 (18 min): Jab. In rounds 5-6, push the pace.",
        "Finisher, 2 min: Fast. Rest 10s after each 20 seconds.",
        "- Cool-down (4 min): Walk.",
        "Tell me when you finish.",
    ])
    varied2 = page.evaluate("(t) => window.__chime.parseWorkout(t)", VARIATIONS)
    vsteps = varied2["steps"]
    check("variations: dashes, minutes, bullets, smart quotes, Nx, paren time, prose ignored",
          varied2["ok"] is True and varied2["errors"] == [] and varied2["totalSeconds"] == 1800 and len(vsteps) == 23
          and vsteps[0]["name"] == "Rope" and vsteps[0]["seconds"] == 180 and "Keep it light" in vsteps[0]["speak"]
          and vsteps[1]["name"] == "Rings" and vsteps[1]["seconds"] == 180
          and vsteps[2]["speak"] == "Round 1" and vsteps[10]["speak"] == "Round 5, push the pace" and vsteps[12]["speak"] == "Round 6, push the pace"
          and vsteps[13]["name"] == "Rest" and vsteps[13]["seconds"] == 60
          and vsteps[14]["speak"] == "Finisher. Fast." and vsteps[14]["seconds"] == 20 and vsteps[15]["seconds"] == 10
          and vsteps[22]["name"] == "Cool-down" and vsteps[22]["seconds"] == 240
          and all("Warm" not in s["name"] and "Tell" not in s["name"] for s in vsteps),
          [(s["name"], s["seconds"], s["speak"]) for s in vsteps])

    page.fill("#workout-text", EXAMPLE)
    page.wait_for_timeout(60)
    preview = page.inner_text("#workout-preview")
    check("preview shows the parsed plan and 30:00",
          "Rope" in preview and "Round 1 of 6, work" in preview and "Rest" in preview and "Finisher" in preview and "Cool-down" in preview and "23 steps" in preview and "30:00" in preview,
          preview[:500])
    check("start workout enabled for a clean plan", page.is_enabled("#btn-start-workout"))
    page.evaluate("document.getElementById('workout-preview').scrollIntoView()")
    page.wait_for_timeout(80)
    page.screenshot(path=os.path.join(SCREENS, "workout-preview.png"), full_page=False)

    page.evaluate("window.scrollTo(0, 0)")
    clear_log(page)
    page.click("#btn-start")
    page.wait_for_timeout(250)
    st = page.evaluate("window.__chime.state()")
    check("main Start still runs the interval timer", st["mode"] == "intervals" and st["state"] == "running" and st["stepName"] is None, st)
    stop(page)
    page.wait_for_timeout(80)

    page.fill("#workout-text", "1. **Rope, 3 min:** Easy.\njust stretch\n")
    page.wait_for_timeout(40)
    bad_preview = page.inner_text("#workout-preview")
    check("a line with no duration is left out of the preview", "just stretch" not in bad_preview and "No duration" not in bad_preview and "Rope" in bad_preview, bad_preview[:400])
    check("start stays enabled when a line has no duration", page.is_enabled("#btn-start-workout") and page.inner_text("#btn-start-workout") == "Start")

    page.fill("#workout-text", "1. **Rope, 3 min:** Easy pace.")
    page.wait_for_timeout(40)
    clear_log(page)
    page.click("#btn-start-workout")
    page.wait_for_timeout(200)
    cues = page.evaluate("window.__chime.workoutCues()")
    cue_pairs = [(c["t"], c["kind"]) for c in cues]
    check("3 min step chimes each minute and warns at 10 seconds",
          cue_pairs == [(0, "step"), (60000, "minute"), (120000, "minute"), (170000, "warn"), (180000, "end")],
          cue_pairs)
    sched = sorted(set(e["t"] for e in logs(page, ["sched-chime"])))
    check("minute chimes are scheduled on the audio clock", sched == [60000, 120000], sched)
    spoken = [e["text"] for e in logs(page, ["speak"])]
    check("start speaks the step name and cue", any("Rope" in t and "Easy pace" in t for t in spoken), spoken)
    wake = page.inner_text("#r-wake")
    check("workout asks to keep the screen awake", wake.startswith("Screen:") and "…" not in wake, wake)
    check("workout screen shows the step", page.inner_text("#r-interval") == "Rope" and page.is_visible("#btn-skip"))
    page.screenshot(path=os.path.join(SCREENS, "workout-running.png"))
    stop(page)
    page.wait_for_timeout(80)

    page.fill("#workout-text", "1. **Alpha, 8 sec:** First move.\n2. **Beta, 8 sec:** Second move.")
    page.wait_for_timeout(40)
    clear_log(page)
    page.click("#btn-start-workout")
    page.wait_for_timeout(350)
    st = page.evaluate("window.__chime.state()")
    check("short workout is on Alpha", st["state"] == "running" and st["mode"] == "workout" and st["stepName"] == "Alpha" and page.inner_text("#r-interval") == "Alpha", st)
    check("pause and skip are available", page.inner_text("#btn-pause") == "Pause" and page.is_visible("#btn-skip"))
    page.click("#btn-pause")
    e1 = page.evaluate("window.__chime.state()")
    page.wait_for_timeout(700)
    e2 = page.evaluate("window.__chime.state()")
    check("workout pause freezes the clock", e1["state"] == "paused" and page.inner_text("#btn-pause") == "Resume" and abs(e1["elapsed"] - e2["elapsed"]) <= 1, (e1["elapsed"], e2["elapsed"]))
    page.click("#btn-pause")
    page.click("#btn-skip")
    page.wait_for_timeout(200)
    st = page.evaluate("window.__chime.state()")
    skipped_speech = [e["text"] for e in logs(page, ["speak"])]
    check("skip advances to Beta and speaks it", st["stepName"] == "Beta" and page.inner_text("#r-interval") == "Beta" and any(t.startswith("Beta") for t in skipped_speech), (st["stepName"], skipped_speech))
    stop(page)
    check("stop leaves the workout", page.is_visible("#setup") and page.evaluate("window.__chime.state().state") == "idle")

    page.fill("#workout-text", "1. **Beep, 2 sec:** Go.")
    page.wait_for_timeout(40)
    clear_log(page)
    page.click("#btn-start-workout")
    page.wait_for_timeout(3200)
    st = page.evaluate("window.__chime.state()")
    done_speech = [e["text"] for e in logs(page, ["speak"])]
    check("short workout finishes and says Done",
          st["state"] == "done" and page.inner_text("#r-count") == "Done" and "Done" in done_speech and any(e["type"] == "end" for e in logs(page)),
          (st["state"], done_speech))
    page.click("#btn-back")

    # ---------- 6c. any permutation of a pasted plan ----------
    def round_steps(n, on, off):
        rows = []
        for i in range(1, n + 1):
            rows.append(("Round %d of %d, work" % (i, n), on, "work"))
            rows.append(("Rest", off, "rest"))
        return rows

    def interval_steps(name, total, work, rest):
        rows = []
        left = total
        while left > 0:
            w = min(work, left)
            rows.append((name, w, "work"))
            left -= w
            if left <= 0:
                break
            r = min(rest, left)
            rows.append(("Rest", r, "rest"))
            left -= r
        return rows

    def perm_problem(plan, expect):
        steps = plan["steps"]
        total = sum(sec for _, sec, _ in expect)
        if plan["ok"] is not True or plan["errors"] != [] or plan["totalSeconds"] != total:
            return ("plan", plan["ok"], plan["totalSeconds"], total, plan["errors"])
        if sum(s["seconds"] for s in steps) != total or len(steps) != len(expect):
            return ("len", len(steps), len(expect), plan["totalSeconds"])
        for i, (s, exp) in enumerate(zip(steps, expect)):
            name, sec, kind = exp
            if (s["name"], s["seconds"], s["kind"]) != (name, sec, kind):
                return ("step", i, (s["name"], s["seconds"], s["kind"]), exp)
            speak = s["speak"]
            if "after each" in speak.lower() or "off for" in speak.lower():
                return ("speak-pattern", i, speak)
            if kind == "rest":
                if speak != "Rest":
                    return ("speak", i, speak)
            elif name.startswith("Round "):
                if not speak.startswith("Round "):
                    return ("speak", i, speak)
            elif not speak.startswith(name):
                return ("speak", i, speak)
        return None

    perm_cases = [
        ("one step in seconds", "Shadowbox, 90 seconds: stay long.", [("Shadowbox", 90, "work")]),
        ("one step in minutes", "Plank, 2 minutes: tight.", [("Plank", 120, "work")]),
        ("one step in M:SS", "Squats, 1:30: down and up.", [("Squats", 90, "work")]),
        ("paren duration", "Warm-up (45s): easy.", [("Warm-up", 45, "work")]),
        ("bullet, dash, minutes, smart quotes", "• Shadowbox – 3 minutes: “hands up.”", [("Shadowbox", 180, "work")]),
        ("1 round", "Squats, 1 round of 0:45 on, 0:15 off", round_steps(1, 45, 15)),
        ("8 rounds of M:SS", "Shadowbox, 8 rounds of 3:00 on, 0:30 off", round_steps(8, 180, 30)),
        ("10 rounds without of", "Plank, 10 rounds 30 sec on 30 sec off", round_steps(10, 30, 30)),
        ("slash rounds", "Warm-up, 10 rounds of 0:30 on / 0:15 off", round_steps(10, 30, 15)),
        ("4 x seconds", "Squats, 4 x 45s / 15s", round_steps(4, 45, 15)),
        ("nameless 4 x", "4 x 45s / 15s", round_steps(4, 45, 15)),
        ("3 x on off", "Warm-up, 3 x 20s on, 10s off", round_steps(3, 20, 10)),
        ("20 rounds", "Shadowbox, 20 rounds of 0:15 on, 0:15 off", round_steps(20, 15, 15)),
        ("24 rounds", "Plank, 24 rounds of 10 seconds on, 5 seconds off", round_steps(24, 10, 5)),
        ("on/off for minutes", "20s on/10s off for 4 min", interval_steps("Work", 240, 20, 10)),
        ("named on/off for", "Plank, 20 seconds on / 10 seconds off for 3 minutes", interval_steps("Plank", 180, 20, 10)),
        ("on/off inside a short total", "Squats, 70 seconds: 20s on/10s off. Stay tall.", interval_steps("Squats", 70, 20, 10)),
        ("rest after each, not 30 min", "Shadowbox, 6 min: Rest 15 seconds after each 45 seconds.", interval_steps("Shadowbox", 360, 45, 15)),
        ("two steps", "Warm-up, 2 min: loose.\nSquats, 30 seconds: down.", [("Warm-up", 120, "work"), ("Squats", 30, "work")]),
    ]
    six = [
        ("Warm-up, 1 min: loose.", [("Warm-up", 60, "work")]),
        ("Squats, 40 seconds: down.", [("Squats", 40, "work")]),
        ("Plank, 30 sec: tight.", [("Plank", 30, "work")]),
        ("Shadowbox, 2:00: hands.", [("Shadowbox", 120, "work")]),
        ("Squats, 20s: fast.", [("Squats", 20, "work")]),
        ("Warm-up, 90 seconds: shake.", [("Warm-up", 90, "work")]),
    ]
    mixed = [
        ("Warm-up, 90 sec: loose.", [("Warm-up", 90, "work")]),
        ("Squats, 4 x 45s / 15s: down.", round_steps(4, 45, 15)),
        ("Plank, 20s on/10s off for 3 min: tight.", interval_steps("Plank", 180, 20, 10)),
        ("Shadowbox, 8 rounds of 1:00 on, 0:20 off: hands.", round_steps(8, 60, 20)),
    ]

    def plan_text(blocks):
        body = []
        for line, _steps in blocks:
            body.append(line)
        return "\n".join(["Have a good session.", ""] + body + ["", "Tell me when you finish."])

    def plan_steps(blocks):
        rows = []
        for _line, steps in blocks:
            rows.extend(steps)
        return rows

    perm_cases.append(("six steps in written order", plan_text(six), plan_steps(six)))
    perm_cases.append(("six steps reversed", plan_text(list(reversed(six))), plan_steps(list(reversed(six)))))
    perm_cases.append(("mixed formats in written order", plan_text(mixed), plan_steps(mixed)))
    perm_cases.append(("mixed formats reversed", plan_text(list(reversed(mixed))), plan_steps(list(reversed(mixed)))))

    for label, text, expect in perm_cases:
        parsed = page.evaluate("(t) => window.__chime.parseWorkout(t)", text)
        problem = perm_problem(parsed, expect)
        page.fill("#workout-text", text)
        page.wait_for_timeout(20)
        ready = page.is_enabled("#btn-start-workout") and page.inner_text("#btn-start-workout") == "Start"
        total = parsed["totalSeconds"]
        check("permutation starts as written: " + label,
              problem is None and ready and total == sum(sec for _, sec, _ in expect) and total != 1800,
              problem if problem is not None else (total, len(expect), ready))

    page.fill("#workout-text", "Shadowbox, 8 sec: hands up.\nPlank, 6 sec: tight.")
    page.wait_for_timeout(40)
    clear_log(page)
    page.click("#btn-start-workout")
    page.wait_for_timeout(200)
    st = page.evaluate("window.__chime.state()")
    check("runner total is the sum of the steps",
          st["mode"] == "workout" and st["state"] == "running" and st["totalMs"] == 14000 and st["stepCount"] == 2 and st["stepName"] == "Shadowbox",
          st)
    stop(page)
    page.wait_for_timeout(80)

    # ---------- 7. offline ----------
    ctx.set_offline(True)
    page.reload(wait_until='load')
    check('loads offline from SW cache', page.is_visible('#btn-start') and page.title() == 'Interval Chime')
    ctx.set_offline(False)

    real_errors = [e for e in errors if 'was interrupted by a new load request' not in e]
    check('no console errors / page errors', not real_errors, real_errors)
    check('no failed requests', not failed_req, failed_req)
    check('no external (non-origin) requests', not ext_req, ext_req)
    browser.close()

print('\nSUMMARY: %d/%d passed' % (sum(r[1] for r in results), len(results)))
sys.exit(0 if all(r[1] for r in results) else 1)
