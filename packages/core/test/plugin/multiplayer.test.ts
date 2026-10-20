import { expect } from "bun:test"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { Location } from "@opencode/core/location"
import { Rpc } from "@opencode/core/rpc"
import { AbsolutePath } from "@opencode/core/schema"
import Multiplayer from "@opencode/multiplayer/server"
import type { SessionCreateInput } from "@opencode/client/effect/api"
import { Effect, Layer } from "effect"
import { location } from "../fixture/location"
import { testEffect } from "../lib/effect"
import { host } from "./host"

const it = testEffect(
  AppNodeBuilder.build(Rpc.node, [
    Location.node.replace(Layer.succeed(Location.Service, location({ directory: AbsolutePath.make("/room") }))),
  ]),
)

it.effect(
  "room creation persists the host model through RPC before guest admission",
  Effect.gen(function* () {
    const rpc = yield* Rpc.Service
    const created: SessionCreateInput[] = []
    yield* Multiplayer.effect(
      host({
        rpc: Object.assign(rpc.client, { register: rpc.register }),
        session: {
          hook: () => Effect.succeed({ dispose: Effect.void }),
          create: (input) => {
            created.push(input ?? {})
            return Effect.fail(new Error("Fixture stops before opening a gateway or tunnel"))
          },
        },
      }),
    )
    const model = { providerID: "demo", id: "chosen", variant: "high" }
    yield* rpc.call("opencode.multiplayer", "start", { name: "Host", color: 0, model }).pipe(Effect.exit)
    expect(created).toMatchObject([{ title: "Multiplayer room", model }])
  }),
)
