import type { OpenCodeClient, OpenCodeEvent } from "@opencode/client"
import { createClientConnection, createPersistentPtyClient } from "@opencode/client/solid"
import { createGlobalEmitter } from "@solid-primitives/event-bus"
import { batch, createSignal, onCleanup } from "solid-js"
import { createSimpleContext } from "./helper"
import { useLog } from "./log"

type ManagedService = {
  reconnect: (signal: AbortSignal) => Promise<{ api: OpenCodeClient; url?: string }>
  restart: () => Promise<void>
}

type ClientEventMap = { [Type in OpenCodeEvent["type"]]: Extract<OpenCodeEvent, { type: Type }> }

export const { use: useClient, provider: ClientProvider } = createSimpleContext({
  name: "Client",
  init: (props: { api: OpenCodeClient; url?: string; service?: ManagedService }) => {
    const log = useLog({ component: "client" })
    const service = props.service
    const [external, setExternal] = createSignal(false)
    const [switching, setSwitching] = createSignal(false)
    const events = createGlobalEmitter<ClientEventMap>()
    let api = props.api
    let url = props.url
    let persistentPty = url ? createPersistentPtyClient(api, { url }) : undefined

    const connection = createClientConnection(api, {
      reconnect: service
        ? async (signal) => {
            if (external()) return api
            const next = await service.reconnect(signal)
            api = next.api
            if (next.url) url = next.url
            if (url) persistentPty = createPersistentPtyClient(api, { url })
            return api
          }
        : undefined,
      onEvent(event) {
        events.emit(event.type, event)
      },
      log,
    })

    onCleanup(() => {
      events.clear()
    })

    return {
      external: () => external() || switching(),
      suspend() {
        setSwitching(true)
        connection.suspend()
      },
      target: () => ({ api, url }),
      replace(next: { api: OpenCodeClient; url?: string; external?: boolean }) {
        batch(() => {
          api = next.api
          url = next.url
          setExternal(next.external ?? false)
          persistentPty = url && !external() ? createPersistentPtyClient(api, { url }) : undefined
          connection.replace(api)
          setSwitching(false)
        })
      },
      get api() {
        return api
      },
      get persistentPty() {
        if (!persistentPty) throw new Error("Persistent terminal server endpoint is unavailable")
        return persistentPty
      },
      event: {
        on: events.on,
        listen: events.listen,
      },
      connection,
      get restart() {
        return external() ? undefined : service?.restart
      },
    }
  },
})
