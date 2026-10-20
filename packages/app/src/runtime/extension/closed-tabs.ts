import { createEventListener } from "@solid-primitives/event-listener"

/** Side tabs the user closed in this window, newest last, each with how its panel brings it back. */
export function createClosedTabs(limit = 25) {
  const stack: { session: string; reopen: () => void }[] = []

  return {
    push(session: string, reopen: () => void) {
      stack.push({ session, reopen })

      if (stack.length > limit) stack.shift()
    },
    reopen(session: string) {
      const index = stack.findLastIndex((entry) => entry.session === session)

      if (index !== -1) stack.splice(index, 1)[0]?.reopen()
    },
  }
}

/** Whether the user's last focus, click or key was in the side panel; closing the focused tab leaves this set. */
export function createSideFocus() {
  let inside = false
  createEventListener(
    document,
    ["focusin", "pointerdown", "keydown"],
    (event) => {
      if (event.target instanceof Element && event.target !== document.body && event.target.isConnected)
        inside = !!event.target.closest("#review-panel")
    },
    { capture: true },
  )

  return () => inside
}
