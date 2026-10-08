"""Headless verification for Interval Chime. Run: python3 tools/test_app.py [base_url]"""
import json, sys, time
from playwright.sync_api import sync_playwright

BASE = sys.argv[1] if len(sys.argv) > 1 else 'http://127.0.0.1:8765/'
SCREENS = '/workspace/interval-chime/screens'
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

with sync_playwright() as p:
    browser = p.chromium.launch(executable_path='/usr/bin/google-chrome', headless=True,
                                args=['--autoplay-policy=no-user-gesture-required'])
    ctx = browser.new_context(viewport={'width': 390, 'height': 844}, device_scale_factor=3, is_mobile=True, has_touch=True,
                              user_agent='Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1')
    page = ctx.new_page()
    errors = []
    page.on('console', lambda m: errors.append('console.' + m.type + ': ' + m.text) if m.type in ('error', 'warning') else None)
    page.on('pageerror', lambda e: errors.append('pageerror: ' + str(e)))
    failed_req = []
    page.on('requestfailed', lambda r: failed_req.append(r.url))
    ext_req = []
    page.on('request', lambda r: ext_req.append(r.url) if not r.url.startswith(BASE.rstrip('/')) and not r.url.startswith('data:') else None)

    # ---------- 1. load, manifest, SW ----------
    page.goto(BASE, wait_until='load')
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
    controlled = page.evaluate("!!navigator.serviceWorker.controller")
    check('page controlled by SW after reload', controlled)

    # setup screenshot (defaults: 30 s / 30 min)
    s = page.evaluate('window.__chime.settings()')
    check('defaults 30s interval / 30 min / lead-in off', s['interval'] == '30' and s['session'] == '1800' and s['leadIn'] is False, s)
    page.screenshot(path=SCREENS + '/setup.png')

    # running screenshot (real 30 s interval)
    page.click('#btn-start')
    page.wait_for_timeout(3300)
    st = page.evaluate('window.__chime.state()')
    check('real 30s run: running, ctx running', st['state'] == 'running' and st['ctxState'] == 'running', st)
    cnt = page.inner_text('#r-count'); iv = page.inner_text('#r-interval')
    check('running screen shows countdown + interval N of M', cnt in ('0:26', '0:27') and iv == 'Interval 1 of 60', cnt + ' | ' + iv)
    sched = logs(page, ['sched-chime', 'sched-end'])
    byk = {}
    for e in sched:
        if e['type'] == 'sched-chime': byk[e['k']] = e['audio']   # latest (post-resync) wins
    check('30s/30min: 10 min of chimes pre-scheduled (k=1..20)', sorted(byk) == list(range(1, 21)) and st['pendingEvents'] <= 21, (sorted(byk)[:3], len(byk), st['pendingEvents']))
    ad = [byk[k] for k in sorted(byk)]
    diffs = [round(b - a, 3) for a, b in zip(ad, ad[1:])]
    check('scheduled audio spacing = 30.000 s (±5 ms)', all(abs(d - 30) < 0.005 for d in diffs), diffs[:5])
    page.screenshot(path=SCREENS + '/running.png')
    stop(page)
    page.wait_for_timeout(200)

    # ---------- 2. test mode: 2 s interval, 10 s session ----------
    page.goto(BASE + '?test=1', wait_until='load')
    page.click('#interval-buttons [data-v="2"]'); page.click('#session-buttons [data-v="10"]')
    clear_log(page)
    page.click('#btn-start')
    page.wait_for_timeout(11800)
    L = logs(page)
    chimes = [e for e in L if e['type'] == 'chime']
    ends = [e for e in L if e['type'] == 'end']
    onsets = [e for e in L if e['type'] == 'onset']
    check('2s/10s: 4 interval chime events (k=1..4)', [c['k'] for c in chimes] == [1, 2, 3, 4], [c['k'] for c in chimes])
    errs = [c['elapsed'] - c['expected'] for c in chimes]
    check('chime events fire within 60 ms of 2/4/6/8 s', all(0 <= e < 60 for e in errs), errs)
    check('end event at 10 s', len(ends) == 1 and ends[0]['elapsed'] == 10000, ends)
    on_el = [o['elapsed'] for o in onsets if o['elapsed'] is not None]
    # expected audible onsets: start cue (~0), 2000,4000,6000,8000, end 10000 (end onset may be logged after state=done -> None)
    exp = [2000, 4000, 6000, 8000]
    matched = [min(on_el, key=lambda x: abs(x - t)) if on_el else None for t in exp]
    oerr = [m - t if m is not None else None for m, t in zip(matched, exp)]
    check('measured audio onsets (analyser) within 60 ms of 2/4/6/8 s', all(e is not None and -20 <= e <= 60 for e in oerr), {'onsets': on_el, 'err_ms': oerr})
    end_onsets = [o for o in onsets if o['perf'] >= ends[0]['perf'] - 100] if ends else []
    rel = [o['perf'] - ends[0]['perf'] for o in end_onsets] if ends else None
    check('end triple chime audible (3 strikes ~0 / 0.6 / 1.2 s after end)', rel is not None and len(rel) >= 3 and all(any(abs(r - x) < 80 for r in rel) for x in (0, 600, 1200)), rel)
    check('done screen shown', page.inner_text('#r-count') == 'Done' and page.is_visible('#btn-again'))
    page.screenshot(path=SCREENS + '/done.png')
    page.click('#btn-back')

    # ---------- 3. pause / resume / stop ----------
    page.click('#interval-buttons [data-v="2"]'); page.click('#session-buttons [data-v="20"]')
    clear_log(page)
    page.click('#btn-start')
    page.wait_for_timeout(3000)
    page.click('#btn-pause')
    e1 = page.evaluate('window.__chime.state()')
    check('pause -> state paused, button says Resume', e1['state'] == 'paused' and page.inner_text('#btn-pause') == 'Resume', e1)
    check('pause cancels scheduled audio', e1['pendingEvents'] <= 2, e1['pendingEvents'])
    page.screenshot(path=SCREENS + '/paused.png')
    n_on_before = len(logs(page, ['onset']))
    page.wait_for_timeout(3000)
    e2 = page.evaluate('window.__chime.state()')
    n_on_during = len(logs(page, ['onset'])) - n_on_before
    check('elapsed frozen while paused', e1['elapsed'] == e2['elapsed'], (e1['elapsed'], e2['elapsed']))
    check('no chimes while paused', n_on_during == 0 and not [c for c in logs(page, ['chime']) if c['k'] > 1], n_on_during)
    clear_log(page)
    page.click('#btn-pause')  # resume
    page.wait_for_timeout(4500)
    L = logs(page)
    ch = [c for c in L if c['type'] == 'chime']
    check('resume continues on the same grid (chimes at 4 s, 6 s)', [c['expected'] for c in ch] == [4000, 6000] and all(0 <= c['elapsed'] - c['expected'] < 60 for c in ch), [(c['expected'], c['elapsed']) for c in ch])
    pe = e1['elapsed']
    on2 = [o['elapsed'] for o in L if o['type'] == 'onset']
    check('audio onsets after resume at 4 s / 6 s', any(abs(o - 4000) < 60 for o in on2) and any(abs(o - 6000) < 60 for o in on2), on2)
    page.click('#btn-stop')
    check('first Stop tap only arms (Tap to stop)', page.inner_text('#btn-stop') == 'Tap to stop' and page.evaluate('window.__chime.state().state') == 'running')
    page.click('#btn-stop')
    check('second tap stops -> setup screen', page.is_visible('#setup') and page.evaluate('window.__chime.state().state') == 'idle')
    clear_log(page)
    page.wait_for_timeout(2500)
    check('no chimes after stop', len(logs(page, ['onset', 'chime'])) == 0, logs(page))

    # ---------- 4. lead-in beeps ----------
    page.click('#interval-buttons [data-v="5"]'); page.click('#session-buttons [data-v="10"]')
    page.click('label:has(#opt-leadin)')
    clear_log(page)
    page.click('#btn-start')
    page.wait_for_timeout(11500)
    L = logs(page)
    beeps = sorted(e['t'] for e in L if e['type'] == 'sched-beep')
    check('lead-in beeps scheduled at 2,3,4 and 7,8,9 s', beeps == [2000, 3000, 4000, 7000, 8000, 9000], beeps)
    on3 = [o['elapsed'] for o in L if o['type'] == 'onset' and o['elapsed'] is not None]
    check('lead-in beeps audible', all(any(abs(o - t) < 60 for o in on3) for t in [2000, 3000, 4000, 5000, 7000, 8000, 9000]), on3)
    page.click('#btn-back')

    # ---------- 5. custom + persistence ----------
    page.click('#interval-buttons [data-v="custom"]')
    page.fill('#ci-min', '1'); page.fill('#ci-sec', '15')
    page.click('#session-buttons [data-v="open"]')
    summ = page.inner_text('#summary')
    page.reload(wait_until='load')
    s = page.evaluate('window.__chime.settings()')
    check('settings persisted (custom 1:15, open-ended, lead-in on)', s['interval'] == 'custom' and s['ciMin'] == 1 and s['ciSec'] == 15 and s['session'] == 'open' and s['leadIn'] is True, s)
    check('custom inputs restored', page.input_value('#ci-min') == '1' and page.input_value('#ci-sec') == '15' and page.is_visible('#custom-interval'))
    page.click('#btn-start'); page.wait_for_timeout(1200)
    check('open-ended run shows "Interval 1" and ∞ remaining', page.inner_text('#r-interval') == 'Interval 1' and page.inner_text('#r-remaining') == '∞', page.inner_text('#r-interval'))
    page.screenshot(path=SCREENS + '/running-open-ended.png')
    stop(page)
    page.fill('#ci-min', '0'); page.fill('#ci-sec', '0')
    page.goto(BASE, wait_until='load')
    page.click('#interval-buttons [data-v="custom"]'); page.fill('#ci-min', '0'); page.fill('#ci-sec', '3')
    check('custom < 5 s rejected (Start disabled) outside test mode', page.is_disabled('#btn-start'), page.inner_text('#summary'))
    page.click('#interval-buttons [data-v="30"]'); page.click('#session-buttons [data-v="1800"]')
    page.click('label:has(#opt-leadin)')
    check('lead-in toggled back off', page.evaluate('window.__chime.settings().leadIn') is False)

    # ---------- 6. offline ----------
    ctx.set_offline(True)
    page.reload(wait_until='load')
    check('loads offline from SW cache', page.is_visible('#btn-start') and page.title() == 'Interval Chime')
    ctx.set_offline(False)

    real_errors = [e for e in errors]
    check('no console errors / page errors', not real_errors, real_errors)
    check('no failed requests', not failed_req, failed_req)
    check('no external (non-origin) requests', not ext_req, ext_req)
    browser.close()

print('\nSUMMARY: %d/%d passed' % (sum(r[1] for r in results), len(results)))
sys.exit(0 if all(r[1] for r in results) else 1)
