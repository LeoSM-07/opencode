import type { FileSystem } from "@opencode/core/filesystem"
import { describe, expect } from "bun:test"
import { Context, Deferred, Duration, Effect, Fiber, Layer, LayerMap, RcMap, Schema } from "effect"
import { TestClock } from "effect/testing"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { makeGlobalNode } from "@opencode/util/effect/app-node"
import { Bus } from "@opencode/core/bus"
import { Database } from "@opencode/core/database/database"
import { Form } from "@opencode/core/form"
import { Location } from "@opencode/core/location"
import { LocationActivity } from "@opencode/core/location-activity"
import { LocationServiceMap, type LocationServices } from "@opencode/core/location-services"
import { Project } from "@opencode/core/project"
import { ProjectTable } from "@opencode/core/project/sql"
import { AbsolutePath } from "@opencode/core/schema"
import { Session } from "@opencode/core/session"
import { SessionExecution } from "@opencode/core/session/execution"
import { SessionEvent } from "@opencode/core/session/event"
import { SessionRunner } from "@opencode/core/session/runner/index"
import { SessionTable } from "@opencode/core/session/sql"
import { SessionStore } from "@opencode/core/session/store"
import { Workspace } from "@opencode/core/workspace"
import { testEffect } from "./lib/effect"

// Keep real execution ownership, location caching, forms, and eviction. The fixture
// runner waits on a form instead of making a model request before asking a question,
// or sleeps silently to stand in for one long tool call.
const locations = Layer.effect(
  LocationServiceMap.Service,
  Effect.gen(function* () {
    const bus = yield* Bus.Service
    const map = yield* LayerMap.make(
      (ref: Location.Ref) =>
        // The fixture only exercises these three Location services.
        // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
        Layer.merge(
          Layer.succeed(
            Location.Service,
            Location.Service.of({
              directory: ref.directory,
              workspaceID: ref.workspaceID,
              project: { id: Project.ID.global, directory: ref.directory, canonical: ref.directory },
            }),
          ),
          Layer.effect(
            SessionRunner.Service,
            Effect.gen(function* () {
              const forms = yield* Form.Service
              return SessionRunner.Service.of({
                drain: ({ sessionID }) =>
                  // A shell blocked on a build for three hours, silent until it exits.
                  sessionID.startsWith("ses_shell")
                    ? Effect.sleep("3 hours").pipe(Effect.as(SessionRunner.DrainResult.Complete()))
                    : forms
                        .ask({
                          sessionID,
                          title: "Questions",
                          fields: [{ key: "runtime", type: "string" }],
                        })
                        .pipe(
                          Effect.orDie,
                          Effect.as(SessionRunner.DrainResult.Complete()),
                          Effect.onInterrupt(() => Effect.sleep("5 minutes")),
                        ),
              })
            }),
          ),
        ).pipe(
          Layer.provideMerge(Form.layer),
          Layer.provide(Layer.succeed(Bus.Service, bus)),
          Layer.fresh,
        ) as unknown as Layer.Layer<LocationServices, FileSystem.DirectoryNotFoundError>,
      { idleTimeToLive: Duration.infinity },
    )
    return {
      ...map,
      get: (ref: Location.Ref) => map.get(LocationServiceMap.canonical(ref)),
      contextEffect: (ref: Location.Ref) => map.contextEffect(LocationServiceMap.canonical(ref)),
      contextEffectOption: (ref: Location.Ref) => map.contextEffectOption(LocationServiceMap.canonical(ref)),
      invalidate: (ref: Location.Ref) => map.invalidate(LocationServiceMap.canonical(ref)),
    }
  }),
)

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      Bus.node,
      SessionStore.node,
      LocationServiceMap.node,
      SessionExecution.node,
      LocationActivity.node,
    ]),
    [
      LocationServiceMap.node.replace(
        makeGlobalNode({
          service: LocationServiceMap.Service,
          layer: locations,
          deps: [Bus.node],
        }),
      ),
    ],
  ),
)

describe("LocationActivity eviction", () => {
  const setup = (sessionIDs: ReadonlyArray<Session.ID>) =>
    Effect.gen(function* () {
      const db = (yield* Database.Service).db
      const bus = yield* Bus.Service
      const execution = yield* SessionExecution.Service
      const ref = LocationServiceMap.canonical({ directory: AbsolutePath.make("/project") })
      yield* db
        .insert(ProjectTable)
        .values({ id: Project.ID.global, worktree: ref.directory, sandboxes: [] })
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(SessionTable)
        .values(
          sessionIDs.map((sessionID) => ({
            id: sessionID,
            project_id: Project.ID.global,
            slug: "busy",
            directory: ref.directory,
            title: "Busy session",
            version: "test",
          })),
        )
        .run()
        .pipe(Effect.orDie)
      const interrupted: SessionEvent.Execution.Interrupted["data"][] = []
      const unsubscribe = yield* bus.listen((event) =>
        Effect.sync(() => {
          if (event.type !== SessionEvent.Execution.Interrupted.type) return
          interrupted.push(Schema.decodeUnknownSync(SessionEvent.Execution.Interrupted.data)(event.data))
        }),
      )
      yield* Effect.addFinalizer(() => unsubscribe)
      yield* Effect.addFinalizer(() =>
        Effect.forEach(sessionIDs, (sessionID) => execution.interrupt(sessionID)).pipe(
          Effect.andThen(TestClock.adjust("5 minutes")),
        ),
      )
      return { ref, interrupted }
    })

  it.effect("retains a location while a session is blocked in one long tool call", () =>
    Effect.gen(function* () {
      const map = yield* LocationServiceMap.Service
      const execution = yield* SessionExecution.Service
      const sessionID = Session.ID.make("ses_shell_build")
      const { ref, interrupted } = yield* setup([sessionID])
      const idle = Location.Ref.make({ directory: ref.directory, workspaceID: Workspace.ID.make("wrk_idle") })

      const running = yield* execution.resume(sessionID).pipe(Effect.exit, Effect.forkScoped)
      yield* Effect.yieldNow
      expect(Array.from(yield* execution.active)).toEqual([sessionID])
      yield* Location.Service.pipe(Effect.provide(map.get(idle)), Effect.scoped)

      // The tool call emits no durable session events while it runs.
      yield* TestClock.adjust("1 minute")
      yield* TestClock.adjust("62 minutes")
      expect(Array.from(yield* execution.active)).toEqual([sessionID])
      expect(interrupted).toEqual([])
      // The idle workspace at the same directory still expires independently.
      expect(Array.from(yield* RcMap.keys(map.rcMap))).toEqual([ref])

      // Two hours in: still retained, still running.
      yield* TestClock.adjust("56 minutes")
      expect(Array.from(yield* execution.active)).toEqual([sessionID])
      expect(Array.from(yield* RcMap.keys(map.rcMap))).toEqual([ref])

      // The tool call finishes after three hours and the session settles normally.
      yield* TestClock.adjust("61 minutes")
      expect((yield* Fiber.join(running))._tag).toBe("Success")
      expect(Array.from(yield* execution.active)).toEqual([])
      expect(interrupted).toEqual([])

      // Idle now, the location lives out its inactivity deadline, then is evicted.
      yield* TestClock.adjust("55 minutes")
      expect(Array.from(yield* RcMap.keys(map.rcMap))).toEqual([ref])
      yield* TestClock.adjust("7 minutes")
      expect(Array.from(yield* RcMap.keys(map.rcMap))).toEqual([])
    }),
  )

  for (const count of [1, 2]) {
    it.effect(
      `retains a location while ${count === 1 ? "a session waits" : `${count} sessions wait`} on unanswered questions`,
      () =>
        Effect.gen(function* () {
          const bus = yield* Bus.Service
          const map = yield* LocationServiceMap.Service
          const execution = yield* SessionExecution.Service
          const store = yield* SessionStore.Service
          const sessionIDs = Array.from({ length: count }, (_, index) =>
            Session.ID.make(`ses_waiting_question_${index}`),
          )
          const { ref, interrupted } = yield* setup(sessionIDs)

          const created = yield* Deferred.make<void>()
          const pending: Form.Info[] = []
          const unsubscribe = yield* bus.listen((event) =>
            Effect.gen(function* () {
              if (event.type !== Form.Event.Created.type) return
              pending.push(Schema.decodeUnknownSync(Form.Event.Created.data)(event.data).form)
              if (pending.length === count) yield* Deferred.succeed(created, undefined)
            }),
          )
          yield* Effect.addFinalizer(() => unsubscribe)
          const running = yield* Effect.forEach(sessionIDs, (sessionID) =>
            execution.resume(sessionID).pipe(Effect.exit, Effect.forkScoped),
          )
          yield* Deferred.await(created)
          const context = yield* map.contextEffect(ref).pipe(Effect.scoped)
          const forms = Context.get(context, Form.Service)
          expect((yield* store.listSuspended()).toSorted()).toEqual(sessionIDs.toSorted())

          // Human input produces no durable activity while the question is pending.
          yield* TestClock.adjust("1 minute")
          yield* TestClock.adjust("62 minutes")
          yield* TestClock.adjust("2 hours")
          expect(Array.from(yield* execution.active).toSorted()).toEqual(sessionIDs.toSorted())
          expect(Array.from(yield* RcMap.keys(map.rcMap))).toEqual([ref])
          expect(interrupted).toEqual([])
          // The cached graph is still the one the waiting tools hold, so answers reach them.
          const current = Context.get(yield* map.contextEffect(ref).pipe(Effect.scoped), Form.Service)
          expect(current).toBe(forms)
          expect((yield* forms.list()).toSorted((a, b) => a.id.localeCompare(b.id))).toEqual(
            pending.toSorted((a, b) => a.id.localeCompare(b.id)),
          )
          yield* Effect.forEach(pending, (form) =>
            forms.reply({ id: form.id, answer: { runtime: "bun" } }).pipe(Effect.orDie),
          )

          const results = yield* Effect.forEach(running, Fiber.join)
          expect(results.every((exit) => exit._tag === "Success")).toBe(true)
          expect(Array.from(yield* execution.active)).toEqual([])
          expect(yield* store.listSuspended()).toEqual([])
          expect(interrupted).toEqual([])

          yield* TestClock.adjust("62 minutes")
          expect(Array.from(yield* RcMap.keys(map.rcMap))).toEqual([])
        }),
    )
  }

  it.effect("refreshes inactivity deadline for session events with non-canonical location refs", () =>
    Effect.gen(function* () {
      const bus = yield* Bus.Service
      const map = yield* LocationServiceMap.Service
      const raw = Location.Ref.make({ directory: AbsolutePath.make("/project") })
      const ref = LocationServiceMap.canonical(raw)

      yield* Location.Service.pipe(Effect.provide(map.get(raw)), Effect.scoped)
      expect(yield* RcMap.has(map.rcMap, raw)).toBe(false)
      expect(yield* RcMap.has(map.rcMap, ref)).toBe(true)

      yield* TestClock.adjust("31 minutes")
      yield* bus.publish(
        SessionEvent.Execution.Started,
        { sessionID: Session.ID.make("ses_activity") },
        { location: raw },
      )

      yield* TestClock.adjust("32 minutes")
      expect(Array.from(yield* RcMap.keys(map.rcMap))).toEqual([ref])

      yield* TestClock.adjust("30 minutes")
      expect(Array.from(yield* RcMap.keys(map.rcMap))).toEqual([])
    }),
  )
})
