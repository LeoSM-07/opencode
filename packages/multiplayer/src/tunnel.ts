import { OpenTunnelClient } from "@opentunnel/client/effect"
import { Effect } from "effect"
import { randomBytes } from "node:crypto"

export const tunnel = Effect.fn("Multiplayer.tunnel")(function* (target: string) {
  const client = yield* OpenTunnelClient
  yield* client.tunnel.ensure()
  const route = `room-${randomBytes(10).toString("hex")}`
  const connection = yield* client.tunnel.connect({ routes: { [route]: new URL(target).host } })
  return `https://${route}.${connection.tunnel.hostname}`
})
