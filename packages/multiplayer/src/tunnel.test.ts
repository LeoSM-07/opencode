import { expect } from "bun:test"
import { OpenTunnelClient } from "@opentunnel/client/effect"
import { Effect, Stream } from "effect"
import { it } from "../../core/test/lib/effect.js"
import { tunnel } from "./tunnel.js"

it.effect(
  "passes the gateway authority, not an HTTP URL, to OpenTunnel",
  Effect.gen(function* () {
    const client = yield* OpenTunnelClient
    const identity = {
      id: "test",
      hostname: "test.invalid",
      token: "test",
      privateKey: "test",
      certificate: "test",
      chain: "test",
      certificateExpiry: new Date(0),
    }
    const url = yield* tunnel("http://127.0.0.1:12345").pipe(
      Effect.provideService(OpenTunnelClient, {
        ...client,
        tunnel: {
          ...client.tunnel,
          ensure: () => Effect.succeed(identity),
          connect: (input) =>
            Effect.sync(() => {
              expect(Object.values(input.routes)).toEqual(["127.0.0.1:12345"])
              return {
                tunnel: identity,
                events: Stream.empty,
                status: Effect.die("unused status"),
                setRoutes: () => Effect.void,
                closed: Effect.never,
                close: Effect.void,
              }
            }),
        },
      }),
    )
    expect(url).toMatch(/^https:\/\/room-[a-f0-9]+\.test\.invalid$/)
  }).pipe(Effect.provide(OpenTunnelClient.layer())),
)
