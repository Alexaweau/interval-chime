# Rehearsal: Interval Chime

Gold: `phone-touch` (kept the 400×520 stage, the 358×520 compact, the phone pinned one gutter from the top and run off the bottom, the touch cursor, and a loop that leaves by a real gesture). Changed the screen to Interval Chime's own dark canvas, amber Start, paste field, and running countdown. The hero is the gold's size, not a 720×340 window, because the story is a phone.

Beats: 1 paste the coach note, 2 the plan reads 15 steps · 30:00, 3 tap Start and Rope counts with a chime, 4 Rings then Bag 2:00 on then Rest 1:00 off, 5 Cool-down holds, then Stop twice returns to an empty field. Loop 12s.

Captured: widths 800 (stage at 1:1, 400×520) and 390 (compact 358×520), reduced-motion posters, states sheet, one 12fps capture of the loop. Look: the app's own dark UI on the kit's iPhone, light stage ground.

Film: `film.mjs --gate` on the wide loop and at `--width 390` ended `rehearsal passed`. Stills of the poster and the plan reported `no-issues-detected`. Sampling gaps (largest about 40ms) left the motion scan `inconclusive`; nothing in those gaps showed up on the 12fps contact. `same-box content change` on the countdown, the step name, and the voice line is the app's own tick: the digits swap when the second or the step changes, and the chime flash marks the step. A rolling digit was tried and snapped its box, so the clock ticks. The voice line is the spoken cue made visible; the real app only speaks it.

Review: poster, compact poster, plan frame, opening frame, Rope frame, and the one-second index of the loop, set beside the phone-touch still. The eye lands on the amber time and the spoken line. The phone leads; nothing else is in the frame. The plan sits above Start so the four steps and the button all stay whole in the crop (the app stacks the plan under Start). Stats are left-aligned so the card's padding is even. No sparkle, no invented mark.

Assumptions: the pasted lines are the generic sample and add up to 30:00 (5:00 + 3:00 + 6×(2:00+1:00) + 4:00, 15 steps). Bag's first round is the poster because that frame shows the round, the 2:00, and the voice together.

Unresolved: none that failed the gate.

Not checked: a physical iPhone, toggling reduced motion during playback, pause/resume in a viewer, live rAF pacing, or the GitHub README render. The promo page was checked locally after the build, not on a phone browser. Typecheck passed (`tsc --noEmit`).
