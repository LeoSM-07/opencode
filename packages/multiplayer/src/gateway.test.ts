import { expect } from "bun:test"
import { OpenCode } from "@opencode/client"
import { createData } from "@opencode/client/solid"
import { Mcp } from "@opencode/schema/mcp"
import { Agent } from "@opencode/schema/agent"
import { Effect, Fiber, Schema } from "effect"
import { createRoot } from "solid-js"
import { WebSocket } from "ws"
import { it } from "../../core/test/lib/effect.js"
import { ServerInfo } from "../../protocol/src/groups/server.js"
import { gateway } from "./gateway.js"
import { makeRoom } from "./room.js"
import { RoomEvent, Ticket } from "./protocol.js"
import { allowed, filterEvents, promptBody, sanitize } from "./policy.js"

it.live(
  "guest bootstrap populates native client caches with valid read models",
  Effect.gen(function* () {
    const room = yield* makeRoom({ sessionID: "ses_room", directory: "/room", host: { name: "Host", color: 0 } })
    const target = yield* gateway(
      {
        server: {
          fetch: (request) =>
            Effect.sync(() => {
              const path = new URL(request.url).pathname
              if (path === "/api/config") throw new Error("Private config must not reach the host")
              if (path === "/api/location")
                return Response.json({
                  directory: "/room",
                  project: { id: "global", directory: "/room", canonical: "/room" },
                })
              return Response.json({
                data: path === "/api/vcs" ? { branch: { current: "shared" } } : [],
                location: { directory: "/room" },
              })
            }),
        },
      },
      room,
    )
    const joined = yield* room.join(room.code, { name: "Guest", color: 1 })
    if (joined.status !== 200) throw new Error("Join failed")
    const client = OpenCode.make({ baseUrl: target, headers: { authorization: `Bearer ${joined.ticket.token}` } })
    const view = createRoot((dispose) => ({
      dispose,
      data: createData({
        api: () => client,
        directory: "/room",
        event: { on: () => () => {}, listen: () => () => {} },
      }),
    }))
    yield* Effect.addFinalizer(() => Effect.sync(view.dispose))
    yield* Effect.tryPromise(() => Promise.all([view.data.location.config.sync(), view.data.location.sync()]))
    expect(
      view.data.location.config
        .list()
        ?.findLast((entry) => entry.type === "document" && entry.info.model !== undefined),
    ).toBeUndefined()
    expect(view.data.location.config.list()).toEqual([])
    expect(view.data.location.vcs.info()?.branch.current).toBe("shared")
    expect(view.data.location.mcp.resource.list()).toEqual([])
    expect(view.data.location.agent.list()).toEqual([])
    expect(view.data.location.model.list()).toEqual([])
  }),
)

it.live(
  "synthetic guest catalogs preserve each endpoint's response shape",
  Effect.gen(function* () {
    const room = yield* makeRoom({ sessionID: "ses_room", directory: "/room", host: { name: "Host", color: 0 } })
    const target = yield* gateway(
      { server: { fetch: () => Effect.die("Private catalogs must not reach the host") } },
      room,
    )
    const joined = yield* room.join(room.code, { name: "Guest", color: 1 })
    if (joined.status !== 200) throw new Error("Join failed")
    const headers = { authorization: `Bearer ${joined.ticket.token}` }
    yield* Effect.forEach(["config", "config/shell", "project", "worktree"], (path) =>
      Effect.gen(function* () {
        const response = yield* Effect.tryPromise(() => fetch(`${target}/api/${path}`, { headers }))
        expect(yield* Effect.tryPromise(() => response.json())).toEqual([])
      }),
    )
    yield* Effect.forEach(
      [
        "plugin",
        "command",
        "skill",
        "reference",
        "integration",
        "permission/request",
        "form",
        "shell",
        "mcp",
        "websearch/provider",
      ],
      (path) =>
        Effect.gen(function* () {
          const response = yield* Effect.tryPromise(() => fetch(`${target}/api/${path}`, { headers }))
          expect(yield* Effect.tryPromise(() => response.json())).toEqual({
            data: [],
            location: { directory: "/room" },
          })
        }),
    )
    const client = OpenCode.make({ baseUrl: target, headers })
    const catalog = yield* Effect.tryPromise(() => client.mcp.resource.catalog())
    expect(yield* Schema.decodeUnknownEffect(Mcp.ResourceCatalog)(catalog.data)).toEqual({
      resources: [],
      templates: [],
    })
    const info = sanitize(
      "/api/info",
      { version: "test", pid: 123, urls: ["https://private.invalid"], paths: { tmp: "/private" } },
      room.family,
    )
    expect(yield* Schema.decodeUnknownEffect(ServerInfo)(info)).toEqual({
      version: "test",
      pid: 0,
      urls: [],
      paths: { tmp: "" },
      capabilities: { persistentPty: false },
    })
    const agents = sanitize(
      "/api/agent",
      {
        data: [
          {
            ...Agent.Info.default(Agent.ID.make("build")),
            system: "private",
            request: { settings: { apiKey: "secret" }, headers: { authorization: "secret" }, body: {} },
          },
        ],
      },
      room.family,
    )
    yield* Schema.decodeUnknownEffect(Schema.Struct({ data: Schema.Array(Agent.Info) }))(agents)
    expect(JSON.stringify(agents)).not.toContain("secret")
    expect(JSON.stringify(agents)).not.toContain("private")
  }),
)

it.live(
  "guest VCS info satisfies the native composer's branch read",
  Effect.gen(function* () {
    const room = yield* makeRoom({ sessionID: "ses_room", directory: "/room", host: { name: "Host", color: 0 } })
    const requests: Request[] = []
    const target = yield* gateway(
      {
        server: {
          fetch: (request) =>
            Effect.sync(() => {
              requests.push(request)
              return Response.json({
                data: { provider: "git", branch: { current: "shared" } },
                location: { directory: "/room" },
              })
            }),
        },
      },
      room,
    )
    const joined = yield* room.join(room.code, { name: "Guest", color: 1 })
    if (joined.status !== 200) throw new Error("Join failed")
    const client = OpenCode.make({ baseUrl: target, headers: { authorization: `Bearer ${joined.ticket.token}` } })
    const response = yield* Effect.tryPromise(() => client.vcs.get({ location: { directory: "/private" } }))
    // This is the same branch access that crashed the native composer after joining.
    expect(response.data?.branch.current).toBe("shared")
    expect(new URL(requests[0].url).searchParams.get("location[directory]")).toBe("/room")
  }),
)

it.live(
  "gateway exchanges invites, scopes reads, stamps prompts, and revokes guests",
  Effect.gen(function* () {
    const room = yield* makeRoom({ sessionID: "ses_room", directory: "/room", host: { name: "Host", color: 0 } })
    const requests: Request[] = []
    const target = yield* gateway(
      {
        server: {
          fetch: (request) =>
            Effect.gen(function* () {
              requests.push(request)
              if (request.method === "POST")
                return Response.json({ received: yield* Effect.tryPromise(() => request.json()) })
              return Response.json({ data: [{ id: "ses_room" }, { id: "ses_private" }], cursor: { next: "private" } })
            }),
        },
      },
      room,
    )
    room.state.gatewayURL = target
    const response = yield* Effect.tryPromise(() =>
      fetch(`${target}/j/${room.code}`, {
        method: "POST",
        body: JSON.stringify({ name: "Guest", color: 0 }),
      }),
    )
    expect(response.status).toBe(200)
    const ticket = yield* Effect.tryPromise(() => response.text()).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(Ticket))),
    )
    expect(ticket.room.members[1].color).not.toBe(0)
    const headers = { authorization: `Bearer ${ticket.token}` }
    const list = yield* Effect.tryPromise(() =>
      fetch(`${target}/api/session?location[directory]=/private`, { headers }),
    )
    expect(yield* Effect.tryPromise(() => list.json())).toEqual({ data: [{ id: "ses_room" }], cursor: {} })
    expect(new URL(requests[0].url).searchParams.get("location[directory]")).toBe("/room")
    const denied = yield* Effect.forEach(
      ["/api/session/ses_private/message", "/api/rpc/call", "/api/credential", "/api/session/ses_room/interrupt"],
      (path) =>
        Effect.tryPromise(() => fetch(target + path, { method: path.endsWith("interrupt") ? "POST" : "GET", headers })),
    )
    expect(denied.map((item) => item.status)).toEqual([403, 403, 403, 403])
    const sent = yield* Effect.tryPromise(() =>
      fetch(`${target}/api/session/ses_room/prompt`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          text: "hello",
          metadata: { author: { name: "Spoofed host" } },
          agents: [{ id: "other" }],
          resume: false,
        }),
      }),
    )
    expect(yield* Effect.tryPromise(() => sent.json())).toEqual({
      received: {
        text: "hello",
        metadata: { author: { id: ticket.participantID, name: "Guest", color: 1, role: "guest" } },
      },
    })
    expect(requests).toHaveLength(2)
    yield* Effect.tryPromise(() => fetch(`${target}/_multiplayer/leave`, { method: "POST", headers }))
    const revoked = yield* Effect.tryPromise(() => fetch(`${target}/api/session`, { headers }))
    expect(revoked.status).toBe(401)
  }),
)

it.live(
  "real WebSocket roster, typing, and room-close delivery",
  Effect.gen(function* () {
    const room = yield* makeRoom({ sessionID: "ses_room", directory: "/room", host: { name: "Host", color: 0 } })
    const target = yield* gateway({ server: { fetch: () => Effect.succeed(new Response()) } }, room)
    const joined = yield* room.join(room.code, { name: "Guest", color: 1 })
    if (joined.status !== 200) throw new Error("Join failed")
    const ws = new WebSocket(`${target.replace("http:", "ws:")}/_multiplayer/ws?token=${joined.ticket.token}`)
    yield* Effect.addFinalizer(() => Effect.sync(() => ws.terminate()))
    const next = Effect.callback<typeof RoomEvent.Type, Error>((resume) => {
      const receive = (data: Buffer) =>
        resume(
          Effect.yieldNow.pipe(
            Effect.andThen(Schema.decodeUnknownEffect(Schema.fromJsonString(RoomEvent))(data.toString())),
            Effect.orDie,
          ),
        )
      ws.once("message", receive)
      return Effect.sync(() => ws.off("message", receive))
    })
    const initial = yield* next
    expect(initial.type).toBe("snapshot")
    if (initial.type === "snapshot") expect(initial.room.members[1].online).toBe(true)
    ws.send(JSON.stringify({ type: "typing", active: true }))
    const typing = yield* next
    if (typing.type === "snapshot") expect(typing.room.members[1].typing).toBe(true)
    const closed = yield* Effect.forkScoped(next)
    yield* Effect.yieldNow
    yield* room.close
    const event = yield* Fiber.join(closed)
    expect(event.type).toBe("closed")
  }),
)

it.live(
  "SSE filtering handles split frames and only admits the room family",
  Effect.gen(function* () {
    const family = new Set(["ses_room"])
    const frames =
      [
        { type: "server.connected", data: {} },
        { type: "session.created", data: { sessionID: "ses_child", parentID: "ses_room" } },
        { type: "session.created", data: { sessionID: "ses_private" } },
        { type: "session.updated", data: { sessionID: "ses_child" } },
        { type: "credential.updated", data: { sessionID: "ses_room", secret: "hidden" } },
      ]
        .map((frame) => `data: ${JSON.stringify(frame)}\n\n`)
        .join("") + ": heartbeat\n\n"
    const source = new ReadableStream<string>({
      start(controller) {
        controller.enqueue(frames.slice(0, 17))
        controller.enqueue(frames.slice(17))
        controller.close()
      },
    })
    const text = yield* Effect.tryPromise(() =>
      new Response(source.pipeThrough(filterEvents(family)).pipeThrough(new TextEncoderStream())).text(),
    )
    expect(text).toContain("server.connected")
    expect(text).toContain("ses_child")
    expect(text).toContain(": heartbeat")
    expect(text).not.toContain("ses_private")
    expect(text).not.toContain("hidden")
  }),
)

it.effect(
  "policy strips model credentials and rejects file references and shared writes",
  Effect.gen(function* () {
    const family = new Set(["ses_room"])
    expect(allowed("POST", "/api/session/ses_room/model", family)).toBe(false)
    expect(allowed("GET", "/api/session/ses_private", family)).toBe(false)
    expect(
      sanitize(
        "/api/model",
        {
          data: [
            {
              id: "model",
              headers: { authorization: "secret" },
              settings: { apiKey: "secret" },
              variants: [{ id: "high", body: { secret: "hidden" } }],
            },
          ],
        },
        family,
      ),
    ).toEqual({ data: [{ id: "model", variants: [{ id: "high" }] }] })
    const denied = yield* promptBody(JSON.stringify({ text: "hi", files: [{ uri: "file:///private/key" }] }), {
      id: "guest",
      name: "Guest",
      color: 1,
      role: "guest",
    }).pipe(Effect.exit)
    expect(denied._tag).toBe("Failure")
  }),
)
