import { define } from "@opencode/plugin/effect/plugin"
import { Effect, Exit, Scope, Stream } from "effect"
import { Multiplayer } from "./protocol.js"
import { makeRoom } from "./room.js"
import type { Room } from "./room.js"

export default define({
  id: "opencode.multiplayer",
  effect: Effect.fn("Multiplayer.plugin")(function* (ctx) {
    const scope = yield* Scope.Scope
    const state: { active?: { room: Room; scope: Scope.Closeable }; starting: boolean } = { starting: false }
    const stop = Effect.gen(function* () {
      const active = state.active
      state.active = undefined
      if (active) {
        yield* active.room.close
        yield* Scope.close(active.scope, Exit.void)
      }
      return true
    })
    yield* ctx.session.hook("prompt", (event) =>
      Effect.sync(() => {
        const room = state.active?.room
        if (!room || event.sessionID !== room.snapshot().sessionID || event.metadata?.author) return
        event.metadata = { ...event.metadata, author: room.host }
      }),
    )
    yield* ctx.rpc
      .register(Multiplayer, {
        start: (input, call) =>
          Effect.gen(function* () {
            if (state.active) return state.active.room.ticket()
            if (state.starting)
              return yield* Effect.fail(call.error("failed", "A room is already starting", "Try again shortly"))
            state.starting = true
            const roomScope = yield* Scope.fork(scope)
            return yield* Effect.gen(function* () {
              const { gateway } = yield* Effect.promise(() => import("./gateway.js"))
              const { tunnel } = yield* Effect.promise(() => import("./tunnel.js"))
              const { OpenTunnelClient } = yield* Effect.promise(() => import("@opentunnel/client/effect"))
              const session = yield* ctx.session.create({ title: "Multiplayer room", model: input.model })
              const room = yield* makeRoom({
                sessionID: session.id,
                directory: ctx.location.directory,
                host: { name: input.name, color: input.color },
              })
              yield* Effect.forkScoped(
                ctx.event.subscribe().pipe(
                  Stream.runForEach((event) =>
                    Effect.sync(() => {
                      if (
                        event.type === "session.created" &&
                        event.data.parentID &&
                        room.family.has(event.data.parentID)
                      )
                        room.family.add(event.data.sessionID)
                    }),
                  ),
                  Effect.catch((error) => Effect.logWarning("Room family subscription failed", { error })),
                ),
              )
              const target = yield* gateway(ctx, room)
              room.state.gatewayURL = yield* tunnel(target).pipe(Effect.provide(OpenTunnelClient.layer()))
              state.active = { room, scope: roomScope }
              return room.ticket()
            }).pipe(
              Effect.provideService(Scope.Scope, roomScope),
              Effect.tapError((error) => Effect.logError("Multiplayer room startup failed", { error: String(error) })),
              Effect.onError((cause) => Scope.close(roomScope, Exit.failCause(cause))),
              Effect.mapError((error) => call.error("failed", "Could not start multiplayer room", String(error))),
              Effect.ensuring(
                Effect.sync(() => {
                  state.starting = false
                }),
              ),
            )
          }),
        stop: () => stop,
        status: () => Effect.sync(() => state.active?.room.ticket() ?? null),
      })
      .pipe(Effect.orDie)
  }),
})
