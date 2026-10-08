# Interval Chime

A tiny, dependency-free interval chime timer for workouts. It's an installable PWA (works offline, no tracking).

- Interval presets: 30 s / 1 / 2 / 3 min, or a custom min:sec value.
- Session length: 10 / 15 / 20 / 30 / 45 / 60 min, a custom length, or "Until I stop" (default 30 min).
- A bell chime every interval, and a distinct triple chime at the end. Optional 3-2-1 lead-in beeps.
- Big countdown, "Interval N of M", elapsed and remaining time, Pause / Resume / Stop (tap Stop twice to confirm).
- Timing is computed from `performance.now()` (with a wall-clock correction after device sleep). All chimes are
  pre-scheduled on the Web Audio clock up to 10 minutes ahead, so they don't depend on JS timer ticks.
- Screen Wake Lock while running, re-acquired when the app becomes visible again.
- Settings are saved in localStorage.

## Files
`index.html`, `styles.css`, `app.js`, `sw.js`, `manifest.webmanifest`, `icons/` hold the whole app. No build step.
`tools/` has the icon generator, the headless test (`python3 tools/test_app.py http://127.0.0.1:8765/`) and the deploy script.
`?test=1` adds 2 s / 5 s intervals and 10 to 30 s sessions for quick testing.

## iPhone notes
- **Silent switch:** with "Ring with silent switch on" enabled (default), Start sets `navigator.audioSession.type = 'playback'`
  (Safari 17+) and loops a near-silent audio clip. This puts iOS into its media-playback audio mode, so Web Audio ignores the ringer
  switch. Side effect: iOS treats the app like a music player, so it **pauses music or podcasts from other apps**. Turn the
  option off to mix with your music; chimes then follow the silent switch.
- **Screen lock / app switching:** iOS may suspend web apps in the background. Keep the app open on screen. The wake lock keeps
  the screen on (iOS 16.4+ in Safari; Home Screen apps need roughly iOS 18.4+). If the screen still sleeps, set
  Settings > Display & Brightness > Auto-Lock to a longer time during workouts.
