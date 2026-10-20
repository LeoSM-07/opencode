export * as LocationActivity from "./location-activity.js"

import { Clock, Context, Duration, Effect, Layer, RcMap, Schema } from "effect"
import { Bus } from "./bus.js"
import { Location } from "./location.js"
import { LocationServiceMap } from "./location-service-map.js"
import { SessionEvent } from "./session/event.js"
import { SessionExecution } from "./session/execution.js"
import { SessionStore } from "./session/store.js"
import { makeGlobalNode } from "@opencode/util/effect/app-node"

const isSessionEvent = Schema.is(SessionEvent.Durable)

export class Service extends Context.Service<Service, {}>()("@opencode/LocationActivity") {}

export function layer(
  options: {
    readonly timeToLive?: Duration.Input
    readonly maxActiveHold?: Duration.Input
    readonly sweepInterval?: Duration.Input
  } = {},
) {
  return Layer.effect(
    Service,
    Effect.gen(function* () {
      const clock = yield* Clock.Clock
      const bus = yield* Bus.Service
      const locations = yield* LocationServiceMap.Service
      const execution = yield* SessionExecution.Service
      const sessions = yield* SessionStore.Service
      const timeToLive = Duration.toMillis(options.timeToLive ?? "60 minutes")
      const maxActiveHold = Duration.toMillis(options.maxActiveHold ?? "24 hours")
      // `activeAt` is the last durable session event; `expiresAt` also moves with keep-alive.
      const entries = new Map<string, { readonly ref: Location.Ref; expiresAt: number; readonly activeAt: number }>()
      const key = (ref: Location.Ref) => `${LocationServiceMap.canonical(ref).directory}\0${ref.workspaceID ?? ""}`
      const touch = (ref: Location.Ref) =>
        Effect.sync(() => {
          const now = clock.currentTimeMillisUnsafe()
          entries.set(key(ref), { ref, expiresAt: now + timeToLive, activeAt: now })
        })

      const unsubscribe = yield* bus.listen((event) => {
        if (!isSessionEvent(event) || !event.location) return Effect.void
        const location = LocationServiceMap.canonical(event.location)
        return RcMap.has(locations.rcMap, location).pipe(
          Effect.flatMap((active) => (active ? touch(location) : Effect.void)),
        )
      })
      yield* Effect.addFinalizer(() => unsubscribe)
      yield* Effect.gen(function* () {
        yield* Effect.sleep(options.sweepInterval ?? "1 minute")
        const refs = Array.from(yield* RcMap.keys(locations.rcMap))
        const cached = new Set(refs.map(key))
        yield* Effect.forEach(refs, (ref) => (entries.has(key(ref)) ? Effect.void : touch(ref)), { discard: true })
        for (const id of entries.keys()) {
          if (!cached.has(id)) entries.delete(id)
        }
        // A long tool call or a pending question emits no durable events, so count active
        // execution as activity, but only up to `maxActiveHold` of silence so nothing lives forever.
        const active = yield* Effect.forEach(yield* execution.active, (sessionID) => sessions.get(sessionID))
        const now = clock.currentTimeMillisUnsafe()
        for (const session of active) {
          const entry = session && entries.get(key(session.location))
          if (entry)
            entry.expiresAt = Math.max(entry.expiresAt, Math.min(now + timeToLive, entry.activeAt + maxActiveHold))
        }
        const expired = Array.from(entries.values()).filter((entry) => entry.expiresAt <= now)
        yield* Effect.forEach(
          expired,
          (entry) =>
            Effect.gen(function* () {
              const owners = active.flatMap((session) =>
                session && key(session.location) === key(entry.ref) ? [session] : [],
              )
              // Invalidation only detaches the cache entry; borrowers retain the old
              // graph. Stop its executions and settle tool cleanup before detaching it.
              yield* Effect.forEach(
                owners,
                (session) => execution.interrupt(session.id, { reason: "inactivity", awaitSettlement: true }),
                {
                  discard: true,
                  concurrency: "unbounded",
                },
              )
              const remaining = yield* Effect.forEach(yield* execution.active, (sessionID) => sessions.get(sessionID))
              // New work admitted during cleanup may now own the cached graph.
              if (remaining.some((session) => session && key(session.location) === key(entry.ref))) {
                yield* touch(entry.ref)
                return
              }
              entries.delete(key(entry.ref))
              yield* Effect.logInfo("location services evicted", {
                directory: entry.ref.directory,
                workspaceID: entry.ref.workspaceID,
              }).pipe(Effect.andThen(locations.invalidate(entry.ref)))
            }),
          { discard: true, concurrency: "unbounded" },
        )
      }).pipe(Effect.forever, Effect.forkScoped)

      return Service.of({})
    }),
  )
}

export const node = makeGlobalNode({
  service: Service,
  layer: layer(),
  deps: [Bus.node, LocationServiceMap.node, SessionExecution.node, SessionStore.node],
})
