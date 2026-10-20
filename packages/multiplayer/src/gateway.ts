import type { Context } from "@opencode/plugin/effect/plugin"
import { Effect, Schema, Stream } from "effect"
import { createServer } from "node:http"
import { Readable } from "node:stream"
import { pipeline } from "node:stream/promises"
import { WebSocketServer } from "ws"
import { ClientEvent, Identity } from "./protocol.js"
import type { Room } from "./room.js"
import { allowed, filterEvents, promptBody, sanitize } from "./policy.js"

export const gateway = Effect.fn("Multiplayer.gateway")(function* (ctx: Pick<Context, "server">, room: Room) {
  const context = yield* Effect.context<never>()
  const run = Effect.runForkWith(context)
  const sockets = new WebSocketServer({ noServer: true, maxPayload: 1024 })
  const family = room.family
  const server = createServer((req, res) => {
    const abort = new AbortController()
    res.on("close", () => abort.abort())
    const request = new Request(`http://room${req.url}`, {
      method: req.method,
      headers: Object.fromEntries(
        Object.entries(req.headers).flatMap(([key, value]) =>
          value === undefined ? [] : [[key, Array.isArray(value) ? value.join(", ") : value]],
        ),
      ),
      ...(req.method !== "GET" && req.method !== "HEAD"
        ? { body: Readable.toWeb(req) as unknown as NonNullable<RequestInit["body"]>, duplex: "half" as const }
        : {}),
      signal: abort.signal,
    })
    run(
      handle(ctx, room, family, request).pipe(
        Effect.catch(() => Effect.succeed(Response.json({ error: "Room request failed" }, { status: 400 }))),
        Effect.flatMap((response) =>
          Effect.tryPromise({
            try: () => {
              res.writeHead(response.status, Object.fromEntries(response.headers))
              if (!response.body) {
                res.end()
                return Promise.resolve()
              }
              return pipeline(Readable.from(response.body), res, { signal: abort.signal })
            },
            catch: (error) => error,
          }),
        ),
        Effect.catch(() => Effect.sync(() => res.destroy())),
      ),
    )
  })
  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://room")
    const token = url.searchParams.get("token") ?? ""
    if (url.pathname !== "/_multiplayer/ws" || !room.author(token)) {
      socket.destroy()
      return
    }
    sockets.handleUpgrade(req, socket, head, (ws) => {
      run(room.connect(token, ws))
      ws.on("message", (data) =>
        run(
          Schema.decodeUnknownEffect(Schema.fromJsonString(ClientEvent))(data.toString()).pipe(
            Effect.flatMap((event) => (event.type === "leave" ? room.remove(token) : room.typing(token, event.active))),
            Effect.catch(() => Effect.sync(() => ws.close(1008, "Invalid room event"))),
          ),
        ),
      )
      ws.on("close", () => run(room.disconnect(token, ws)))
      ws.on("error", () => ws.close())
    })
  })
  yield* Effect.addFinalizer(() =>
    room.close.pipe(
      Effect.andThen(
        Effect.callback<void>((resume) => {
          sockets.close(() => resume(Effect.void))
          return Effect.sync(() => sockets.clients.forEach((socket) => socket.terminate()))
        }).pipe(Effect.timeoutOption("1 second")),
      ),
      Effect.andThen(
        Effect.sync(() => {
          server.closeAllConnections()
          server.close()
        }),
      ),
    ),
  )
  yield* Effect.callback<void, Error>((resume) => {
    const fail = (error: Error) => resume(Effect.fail(error))
    server.once("error", fail)
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", fail)
      resume(Effect.void)
    })
  })
  const address = server.address()
  if (!address || typeof address === "string") return yield* Effect.fail(new Error("Room gateway did not bind"))
  return `http://127.0.0.1:${address.port}`
})

const handle = Effect.fn("Multiplayer.request")(function* (
  ctx: Pick<Context, "server">,
  room: Room,
  family: Set<string>,
  request: Request,
) {
  const url = new URL(request.url)
  if (request.method === "POST" && url.pathname.startsWith("/j/")) {
    const identity = yield* readBody(request, 1024).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(Identity))),
    )
    const result = yield* room.join(url.pathname.slice(3), identity)
    return Response.json(
      result.status === 200 ? result.ticket : { error: "Invalid invite, room full, or joining too quickly" },
      { status: result.status },
    )
  }
  const token = request.headers.get("authorization")?.replace(/^Bearer /, "") ?? ""
  const author = room.author(token)
  if (!author) return Response.json({ error: "Invalid room token" }, { status: 401 })
  if (url.pathname === "/_multiplayer/leave" && request.method === "POST") {
    yield* room.remove(token)
    return new Response(null, { status: 204 })
  }
  if (url.pathname === "/_multiplayer/room" && request.method === "GET") return Response.json(room.snapshot())
  if (author.role !== "guest" || !allowed(request.method, url.pathname, family))
    return new Response(null, { status: 403 })

  // Catalogs not needed for a plain-prompt guest are empty, rather than leaking host configuration.
  if (/^\/api\/(config(?:\/shell)?|worktree|project)$/.test(url.pathname)) return Response.json([])
  if (url.pathname === "/api/mcp/resource")
    return Response.json({ data: { resources: [], templates: [] }, location: { directory: room.snapshot().directory } })
  if (
    /^\/api\/(plugin|command|skill|reference|integration|shell|form|permission\/request|mcp|websearch\/provider)$/.test(
      url.pathname,
    )
  )
    return Response.json({ data: [], location: { directory: room.snapshot().directory } })
  url.searchParams.delete("location")
  url.searchParams.delete("location[directory]")
  url.searchParams.delete("location[workspace]")
  url.searchParams.set("location[directory]", room.snapshot().directory)
  const headers = new Headers({ accept: request.headers.get("accept") ?? "application/json" })
  const body =
    request.method === "POST" && url.pathname.endsWith("/prompt")
      ? yield* readBody(request, 16 * 1024 * 1024).pipe(Effect.flatMap((text) => promptBody(text, author)))
      : request.method === "POST"
        ? yield* readBody(request, 1024)
        : undefined
  if (body !== undefined) headers.set("content-type", "application/json")
  const response = yield* ctx.server.fetch(
    new Request(url.toString(), { method: request.method, headers, body, signal: request.signal }),
  )
  if (!response.ok) return Response.json({ error: "Host request failed" }, { status: response.status })
  if (url.pathname === "/api/event" && response.body)
    return new Response(
      response.body
        .pipeThrough(new TextDecoderStream())
        .pipeThrough(filterEvents(family))
        .pipeThrough(new TextEncoderStream()),
      {
        headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
      },
    )
  if (response.status === 204) return response
  const value = yield* Effect.tryPromise(() => response.text()).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Json))),
  )
  return Response.json(sanitize(url.pathname, value, family))
})

const readBody = Effect.fn("Multiplayer.readBody")(function* (request: Request, limit: number) {
  if (!request.body) return ""
  const state = { bytes: 0 }
  const body = request.body
  const chunks = yield* Stream.fromReadableStream({ evaluate: () => body, onError: (error) => error }).pipe(
    Stream.mapEffect((chunk) => {
      state.bytes += chunk.byteLength
      return state.bytes > limit ? Effect.fail(new Error("Room request body is too large")) : Effect.succeed(chunk)
    }),
    Stream.runCollect,
  )
  return Buffer.concat(chunks).toString("utf8")
})
