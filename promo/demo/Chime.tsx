import { Collapse, Icon, Phone, Row, Stage, States, type Act } from '../kit'
import './chime.css'

// Started from examples/phone-touch: same stage (400×520, compact 358×520),
// the phone pinned one gutter from the top and running off the bottom, touch
// cursor, and a loop that leaves by the product's own gesture.
//
// Interval Chime, on an iPhone. The screen is the real app: dark canvas,
// amber Start, a paste field, then the running countdown. Story, five beats:
// 1. A coach's note pastes in, one line at a time.
// 2. The plan reads Rope 5:00, Rings 3:00, Bag 18:00, Cool-down 4:00, 30:00.
// 3. Start is tapped. Rope counts, and the chime speaks.
// 4. The chime walks the plan: Rings, Bag 2:00 on, Rest 1:00 off.
// 5. Cool-down holds, then Stop (twice, as the app does) returns to a fresh field.
//
// The paste is the generic sample, and it adds up: 5:00 + 3:00 + 6×(2:00+1:00)
// + 4:00 = 30:00, 15 steps. Real words live on that plan and on the countdown.
// The poster is Bag's first round, with the spoken cue settled on screen.

const LINES = [
  'Rope, 5:00: Easy pace.',
  'Rings, 3:00: Smooth swings.',
  'Bag, 6 rounds of 2:00 on, 1:00 off: Jab, cross, hook.',
  'Cool-down, 4:00: Walk it out.',
]

const PLAN = [
  { name: 'Rope', time: '5:00' },
  { name: 'Rings', time: '3:00' },
  { name: 'Bag', time: '18:00' },
  { name: 'Cool-down', time: '4:00' },
]

type Phase = 'work' | 'rest'
type Step = {
  name: string
  sub: string
  label: string
  base: number
  elapsed: number
  left: number
  voice: string
  phase: Phase
  seg: number
}

const STEPS: Step[] = [
  { name: 'Rope', sub: 'Easy pace.', label: 'Step 1 of 15', base: 300, elapsed: 0, left: 1800, voice: 'Rope. Easy pace.', phase: 'work', seg: 300 },
  { name: 'Rings', sub: 'Smooth swings.', label: 'Step 2 of 15', base: 180, elapsed: 300, left: 1500, voice: 'Rings. Smooth swings.', phase: 'work', seg: 180 },
  { name: 'Round 1 of 6, work', sub: 'Bag · Jab, cross, hook.', label: 'Step 3 of 15', base: 120, elapsed: 480, left: 1320, voice: 'Round 1', phase: 'work', seg: 120 },
  { name: 'Rest', sub: 'Bag', label: 'Step 4 of 15', base: 60, elapsed: 600, left: 1200, voice: 'Rest', phase: 'rest', seg: 60 },
  { name: 'Cool-down', sub: 'Walk it out.', label: 'Step 15 of 15', base: 240, elapsed: 1560, left: 240, voice: 'Cool-down. Walk it out.', phase: 'work', seg: 240 },
]

type Screen = 'paste' | 'run'
type S = { lines: number; screen: Screen; step: number; tick: number; flash: boolean; armed: boolean }

const START: S = { lines: 0, screen: 'paste', step: 0, tick: 0, flash: false, armed: false }
// The frame that has to work alone: the round is running, the voice has landed.
const POSTER: S = { lines: 4, screen: 'run', step: 2, tick: 0, flash: false, armed: false }

const REST = { x: 188, y: 168 }

const clock = (sec: number) => {
  const s = Math.max(0, sec)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

const shown = (s: S) => {
  const step = STEPS[s.step]!
  const tick = s.step === 0 ? s.tick : 0
  return {
    ...step,
    time: clock(step.base - tick),
    elapsed: clock(step.elapsed + tick),
    left: clock(step.left - tick),
    segPct: Math.min(100, Math.max(8, (tick / step.seg) * 100)),
    totalPct: Math.min(100, ((step.elapsed + tick) / 1800) * 100),
  }
}

const script = async (a: Act<S>) => {
  await a.wait(520)
  a.mark('paste')
  for (let i = 1; i <= LINES.length; i++) {
    a.put({ lines: i })
    await a.wait(i === LINES.length ? 380 : 300)
  }
  a.mark('plan')
  await a.wait(900)
  a.mark('start')
  await a.click({ at: 'start', x: 0.62, y: 0.78 })
  a.put({ screen: 'run', step: 0, tick: 0, flash: true })
  a.mark('rope')
  await a.wait(160)
  a.put({ flash: false })
  await a.wait(520)
  a.put({ tick: 1 })
  await a.wait(640)
  a.put({ tick: 2 })
  await a.wait(420)
  a.mark('rings')
  a.put({ step: 1, tick: 0, flash: true })
  await a.wait(150)
  a.put({ flash: false })
  await a.wait(780)
  a.mark('bag')
  a.put({ step: 2, tick: 0, flash: true })
  await a.wait(150)
  a.put({ flash: false })
  await a.wait(2000)
  a.mark('rest')
  a.put({ step: 3, tick: 0, flash: true })
  await a.wait(150)
  a.put({ flash: false })
  await a.wait(680)
  a.mark('cooldown')
  a.put({ step: 4, tick: 0, flash: true })
  await a.wait(150)
  a.put({ flash: false })
  await a.wait(1700)
  a.mark('stop')
  await a.click({ at: 'stop', x: 0.5, y: 0.78 })
  a.put({ armed: true })
  await a.wait(460)
  await a.click({ at: 'stop', x: 0.5, y: 0.78 })
  // The field clears while the run screen still covers it, then Stop reveals it.
  a.put({ lines: 0 })
  await a.wait(460)
  a.put({ screen: 'paste', armed: false })
  await a.wait(320)
  a.put({ step: 0, tick: 0, flash: false })
  await a.move(REST)
  await a.wait(240)
}

export default function Chime() {
  return (
    <Stage<S>
      width={400}
      height={520}
      compact={{ below: 400, width: 358, height: 520 }}
      initial={START}
      poster={POSTER}
      script={script}
      cursor={{ at: REST, style: 'touch' }}
      accent="#ffb020"
      fidelity="realistic"
      className="ic"
    >
      {(s, _rect, layout) => {
        const now = shown(s)
        return (
          <>
            <div className="ic-wash" />
            <Phone
              width={layout === 'compact' ? 326 : 300}
              dark
              wallpaper="#0b0d12"
              className="ic-phone"
            >
              <div className="ic-app">
                <div className="ic-screens">
                  <div className="ic-paste" data-on={s.screen === 'paste' || undefined}>
                    <div className="ic-col">
                      <div className="ic-field" data-on={s.lines > 0 || undefined}>
                        <div className="ic-placeholder">Paste the workout as written.</div>
                        <div className="ic-lines">
                          {LINES.map((line, i) => (
                            <span key={line} className="ic-line" data-on={i < s.lines || undefined}>{line}</span>
                          ))}
                        </div>
                      </div>
                      <div className="ic-plan" data-on={s.lines > 0 || undefined}>
                        <Collapse open={s.lines === LINES.length}>
                          <div className="ic-total">15 steps · 30:00</div>
                        </Collapse>
                        {PLAN.map((row, i) => (
                          <Collapse key={row.name} open={i < s.lines}>
                            <Row title={row.name} meta={row.time} />
                          </Collapse>
                        ))}
                      </div>
                      <span className="ic-start" data-target="start" data-on={s.lines === LINES.length || undefined}>Start</span>
                    </div>
                  </div>

                  <div className="ic-run" data-on={s.screen === 'run' || undefined} data-phase={now.phase}>
                    <div className="ic-col ic-col--run">
                      <div className="ic-name">{now.name}</div>
                      <div className="ic-sub">{now.sub}</div>
                      <div className="ic-step">{now.label}</div>
                      <div className="ic-count">{now.time}</div>
                      <div className="ic-bar"><span className="ic-bar__fill" style={{ width: `${now.segPct}%` }} /></div>
                      <div className="ic-voice">
                        <Icon name="bell" size={16} filled />
                        <span className="ic-voice__text">{now.voice}</span>
                      </div>
                      <div className="ic-stats">
                        <div className="ic-stat">
                          <span className="ic-stat__k">Elapsed</span>
                          <span className="ic-stat__v">{now.elapsed}</span>
                        </div>
                        <div className="ic-stat">
                          <span className="ic-stat__k">Remaining</span>
                          <span className="ic-stat__v">{now.left}</span>
                        </div>
                      </div>
                      <div className="ic-bar ic-bar--thin"><span className="ic-bar__fill ic-bar__fill--alt" style={{ width: `${now.totalPct}%` }} /></div>
                      <div className="ic-controls">
                        <span className="ic-btn">Pause</span>
                        <span className="ic-btn">Skip</span>
                        <span className="ic-btn ic-stop" data-target="stop" data-armed={s.armed || undefined}>
                          <States value={s.armed ? 'arm' : 'idle'} states={{ idle: 'Stop', arm: 'Tap to stop' }} />
                        </span>
                      </div>
                    </div>
                    <div className="ic-flash" data-on={s.flash || undefined} />
                  </div>
                </div>
              </div>
            </Phone>
          </>
        )
      }}
    </Stage>
  )
}
