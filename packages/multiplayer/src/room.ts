import { randomBytes } from "node:crypto"
import { Clock, Effect, Schedule } from "effect"
import type { WebSocket } from "ws"
import type { Author, Snapshot } from "./protocol.js"

export const secret = () => randomBytes(32).toString("base64url")

export const makeRoom = Effect.fn("Multiplayer.room")(function* (input: {
  sessionID: string
  directory: string
  host: { readonly name: string; readonly color: number }
}) {
  const clock = yield* Clock.Clock
  const now = () => clock.currentTimeMillisUnsafe()
  const members = new Map<
    string,
    {
      author: Author
      sockets: Set<WebSocket>
      typingUntil: number
      offlineAt: number
    }
  >()
  const hostToken = secret()
  const code = secret()
  const roomID = secret()
  const expiresAt = now() + 3_600_000
  const host = { ...input.host, id: secret(), role: "host" as const }
  members.set(hostToken, { author: host, sockets: new Set(), typingUntil: 0, offlineAt: now() })
  const state = { closed: false, lastJoin: -Infinity, gatewayURL: "" }
  const snapshot = (): Snapshot => ({
    roomID,
    sessionID: input.sessionID,
    directory: input.directory,
    members: [...members.values()].map((member) => ({
      ...member.author,
      online: member.sockets.size > 0,
      typing: member.typingUntil > now(),
    })),
  })
  const broadcast = () => {
    const data = JSON.stringify({ type: "snapshot", room: snapshot() })
    members.forEach((member) =>
      member.sockets.forEach((socket) => {
        if (socket.readyState === 1) socket.send(data)
      }),
    )
  }
  const remove = (token: string) => {
    const member = members.get(token)
    if (!member || member.author.role === "host") return
    members.delete(token)
    member.sockets.forEach((socket) => socket.close())
    broadcast()
  }
  const close = Effect.gen(function* () {
    if (state.closed) return
    state.closed = true
    const sockets = [...members.values()].flatMap((member) => [...member.sockets])
    sockets.forEach((socket) => {
      if (socket.readyState === 1) socket.send(JSON.stringify({ type: "closed" }))
      socket.close()
    })
    members.clear()
    // Finish the close handshake before releasing the tunnel route.
    yield* Effect.forEach(
      sockets,
      (socket) =>
        Effect.callback<void>((resume) => {
          if (socket.readyState === 3) {
            resume(Effect.void)
            return
          }
          const closed = () => resume(Effect.void)
          socket.once("close", closed)
          return Effect.sync(() => socket.off("close", closed))
        }),
      { concurrency: "unbounded" },
    ).pipe(Effect.timeoutOption("1 second"))
  })
  yield* Effect.addFinalizer(() => close)
  yield* Effect.forkScoped(
    Effect.sync(() => {
      const time = now()
      const changed = [...members.entries()].some(([token, member]) => {
        if (!member.sockets.size && member.author.role === "guest" && time - member.offlineAt > 30_000) {
          remove(token)
          return true
        }
        return member.typingUntil > 0 && member.typingUntil <= time
      })
      if (!changed) return
      members.forEach((member) => {
        if (member.typingUntil <= time) member.typingUntil = 0
      })
      broadcast()
    }).pipe(Effect.repeat(Schedule.spaced("1 second"))),
  )
  return {
    family: new Set([input.sessionID]),
    host,
    code,
    state,
    snapshot,
    close,
    ticket: (token = hostToken) => ({
      participantID: members.get(token)?.author.id ?? host.id,
      room: snapshot(),
      token,
      gatewayURL: state.gatewayURL,
      joinURL: `${state.gatewayURL}/j/${code}`,
    }),
    author(token: string) {
      return state.closed ? undefined : members.get(token)?.author
    },
    join(codeInput: string, identity: { readonly name: string; readonly color: number }) {
      return Effect.sync(() => {
        if (now() - state.lastJoin < 250) return { status: 429 as const }
        state.lastJoin = now()
        if (state.closed || codeInput !== code || now() > expiresAt) return { status: 403 as const }
        if (members.size >= 8) return { status: 409 as const }
        const token = secret()
        // Prefer an unused category so the default room roster has distinct colors.
        const used = new Set([...members.values()].map((member) => member.author.color))
        const color = used.has(identity.color)
          ? (Array.from({ length: 8 }, (_, i) => i).find((i) => !used.has(i)) ?? identity.color)
          : identity.color
        members.set(token, {
          author: { name: identity.name.trim(), color, id: secret(), role: "guest" },
          sockets: new Set(),
          typingUntil: 0,
          offlineAt: now(),
        })
        broadcast()
        return { status: 200 as const, ticket: this.ticket(token) }
      })
    },
    connect(token: string, socket: WebSocket) {
      return Effect.sync(() => {
        const member = members.get(token)
        if (!member || state.closed) {
          socket.close()
          return
        }
        member.sockets.add(socket)
        broadcast()
      })
    },
    disconnect(token: string, socket: WebSocket) {
      return Effect.sync(() => {
        const member = members.get(token)
        if (!member) return
        member.sockets.delete(socket)
        if (!member.sockets.size) {
          member.offlineAt = now()
          member.typingUntil = 0
        }
        broadcast()
      })
    },
    typing(token: string, active: boolean) {
      return Effect.sync(() => {
        const member = members.get(token)
        if (!member) return
        member.typingUntil = active ? now() + 4_000 : 0
        broadcast()
      })
    },
    remove: (token: string) => Effect.sync(() => remove(token)),
  }
})

export type Room = Effect.Success<ReturnType<typeof makeRoom>>
