import { createSimpleContext } from "./helper"
import type { PromptRef } from "../component/prompt"

export const { use: usePromptRef, provider: PromptRefProvider } = createSimpleContext({
  name: "PromptRef",
  init: () => {
    let current: PromptRef | undefined
    const listeners = new Set<(input: { sessionID?: string; text: string }) => void>()

    return {
      changed(input: { sessionID?: string; text: string }) {
        listeners.forEach((listener) => listener(input))
      },
      onChange(listener: (input: { sessionID?: string; text: string }) => void) {
        listeners.add(listener)
        return () => {
          listeners.delete(listener)
        }
      },
      get current() {
        return current
      },
      set(ref: PromptRef | undefined) {
        current = ref
      },
    }
  },
})
