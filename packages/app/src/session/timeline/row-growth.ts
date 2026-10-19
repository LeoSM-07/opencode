import { frameLoop, Spring } from "@opencode/ui/motion"
import { motionTuning } from "@opencode/ui/motion-tuning"

const group = "Timeline"

// Like the iOS transcript: while the timeline follows its end, a row's displayed height springs to its measured height.
const spring = motionTuning.spring("timeline.growth", {
  label: "Row growth",
  group,
  presets: {
    snappy: { duration: 0.32, bounce: 0 },
    smooth: { duration: 0.42, bounce: 0 },
    calm: { duration: 0.55, bounce: 0 },
  },
})

const softEdge = motionTuning.number("timeline.growth.softEdge", {
  label: "Soft edge",
  group,
  value: 28,
  min: 0,
  max: 64,
  step: 2,
  unit: "px",
})

type Growth = { spring: Spring; start: number }

/**
 * Rows whose displayed height eases toward their measured height. `resize` commits a displayed height to the list and
 * returns the row's clipping wrapper, or false once the row has left the list.
 */
export function createRowGrowth(resize: (key: string, size: number) => HTMLElement | false | undefined) {
  const growths = new Map<string, Growth>()
  let stop: (() => void) | undefined

  const step = (dt: number) => {
    growths.forEach((growth, key) => {
      const value = growth.spring.step(dt)
      const target = growth.spring.target
      const resting = growth.spring.resting
      // Whole pixels, like the scroll offset that rides them, so the end never shimmers between two of them.
      const wrapper = resize(key, resting ? target : Math.round(value))

      if (wrapper === false) return growths.delete(key)

      if (resting) growths.delete(key)

      if (wrapper) paintEdge(wrapper, resting ? 0 : Math.min(softEdge(), target - value, value - growth.start))
    })

    if (growths.size === 0) stop = undefined

    return growths.size > 0
  }

  return {
    /** The height a growing row is heading for. */
    target: (key: string) => growths.get(key)?.spring.target,
    /** Starts a row at `from`, or bends a running growth toward `to` from its current height and speed. */
    grow(key: string, from: number, to: number) {
      const growth = growths.get(key) ?? { spring: Spring.fromDuration(from, spring()), start: from }
      growth.spring.set(to)
      growths.set(key, growth)
      stop ??= frameLoop.add(step)
    },
    /** Lands one row on `size` at once. */
    land(key: string, size: number) {
      growths.delete(key)
      const wrapper = resize(key, size)

      if (wrapper) paintEdge(wrapper, 0)
    },
    /** Lands every growing row on its measured height at once. */
    finish() {
      stop?.()
      stop = undefined
      growths.forEach((growth, key) => {
        const wrapper = resize(key, growth.spring.target)

        if (wrapper) paintEdge(wrapper, 0)
      })
      growths.clear()
    },
  }
}

// The growing row's bottom fades out instead of a hard clip. The fade narrows as the row lands and never covers what
// was already shown when the growth began.
function paintEdge(wrapper: HTMLElement, fade: number) {
  if (fade < 0.5) return wrapper.style.removeProperty("mask-image")
  wrapper.style.setProperty("mask-image", `linear-gradient(to bottom, #000 calc(100% - ${fade.toFixed(2)}px), transparent)`)
}
