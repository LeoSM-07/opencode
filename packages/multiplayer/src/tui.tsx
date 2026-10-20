import { isRpcError, OpenCode } from "@opencode/client"
import { Plugin } from "@opencode/plugin/tui"
import type { Context, Route } from "@opencode/plugin/tui/context"
import { Cause, Effect, Exit, Option, Schedule, Schema, Scope } from "effect"
import { createSignal, For, Show } from "solid-js"
import { HostInput, Identity, Multiplayer, RoomEvent, Ticket } from "./protocol.js"
import type { Snapshot } from "./protocol.js"
import { AuthorLabel } from "./author.js"

export default Plugin.define({
  id: "opencode.multiplayer",
  setup(ctx) {
    const scope = Effect.runSync(Scope.make())
    const [room, setRoom] = createSignal<Snapshot>()
    const [online, setOnline] = createSignal(false)
    const [busy, setBusy] = createSignal(false)
    const typing = () =>
      room()
        ?.members.filter((member) => member.typing && member.id !== state.ticket?.participantID)
        .map((member) => member.name)
        .join(", ")
    const [defaults, saveDefaults] = ctx.storage.store("identity", { initial: { name: "", color: 0 } })
    const state: {
      ticket?: Ticket
      socket?: WebSocket
      connection?: ReturnType<Context["ui"]["connection"]["current"]>
      route?: Route
      presence?: Scope.Closeable
      host: boolean
      lastTyping: number
    } = { host: false, lastTyping: 0 }
    const run = <A, E>(effect: Effect.Effect<A, E, Scope.Scope>) =>
      Effect.runPromise(
        effect.pipe(
          Effect.provideService(Scope.Scope, scope),
          Effect.catchCause((cause) =>
            Effect.sync(() =>
              ctx.ui.toast.show({
                message:
                  Cause.prettyErrors(cause)
                    .map((error) => error.message)
                    .join("\n") || Cause.pretty(cause),
                variant: "error",
              }),
            ),
          ),
        ),
      )
    const rpc = (method: "start" | "stop", input: typeof HostInput.Encoded | Record<string, never>) =>
      Effect.tryPromise({
        try: (signal) =>
          ctx.client.rpc.call({ rpcID: Multiplayer.id, method, input, location: ctx.location }, { signal }),
        catch: (error) =>
          isRpcError(error) && typeof error.data === "string" ? new Error(`${error.message}: ${error.data}`) : error,
      })
    const leave = Effect.gen(function* () {
      const ticket = state.ticket
      state.ticket = undefined
      if (state.presence) yield* Scope.close(state.presence, Exit.void)
      state.presence = undefined
      state.socket = undefined
      setRoom(undefined)
      setOnline(false)
      if (state.connection) {
        const target = state.connection
        state.connection = undefined
        yield* Effect.tryPromise(() => ctx.ui.connection.replace(target))
        const route = state.route
        state.route = undefined
        if (route?.type === "session") ctx.ui.router.navigate({ type: "session", sessionID: route.sessionID })
      }
      if (ticket && !state.host)
        yield* Effect.tryPromise((signal) =>
          fetch(`${ticket.gatewayURL}/_multiplayer/leave`, {
            method: "POST",
            headers: { authorization: `Bearer ${ticket.token}` },
            signal,
          }),
        ).pipe(Effect.timeoutOption("2 seconds"), Effect.ignore)
      state.host = false
    })
    const identity = Effect.gen(function* () {
      const name = yield* Effect.tryPromise(() =>
        ctx.ui.dialog.prompt({ title: "Your room display name", value: defaults.name, placeholder: "Name" }),
      )
      if (!name) return undefined
      const color = yield* Effect.tryPromise(() =>
        ctx.ui.dialog.select({
          title: "Your message color",
          current: defaults.color,
          options: Array.from({ length: 8 }, (_, value) => {
            const color = ctx.theme.categorical[value % ctx.theme.categorical.length][200]
            const title = (ctx.theme.source(color)?.hue ?? `Color ${value + 1}`)
              .replaceAll("-", " ")
              .replace(/\b\w/g, (letter) => letter.toUpperCase())
            return {
              title,
              value,
              get titleView() {
                return (
                  <span>
                    <span style={{ fg: color }}>■</span> {title}
                  </span>
                )
              },
            }
          }),
        }),
      )
      if (color === undefined) return undefined
      const value = yield* Schema.decodeUnknownEffect(Identity)({ name: name.trim(), color })
      yield* Effect.tryPromise(() =>
        saveDefaults((draft) => {
          draft.name = value.name
          draft.color = value.color
        }),
      )
      return value
    })
    const connect = Effect.fn("Multiplayer.connect")(function* (ticket: Ticket) {
      state.ticket = ticket
      setRoom(ticket.room)
      const presence = yield* Scope.fork(scope)
      state.presence = presence
      const listen = Effect.callback<void, Error>((resume) => {
        const url = new URL("/_multiplayer/ws", ticket.gatewayURL)
        url.protocol = url.protocol === "https:" ? "wss:" : "ws:"
        url.searchParams.set("token", ticket.token)
        const socket = new WebSocket(url)
        state.socket = socket
        socket.onopen = () => setOnline(true)
        socket.onmessage = (message) => {
          const event = Schema.decodeUnknownOption(Schema.fromJsonString(RoomEvent))(String(message.data))
          if (Option.isNone(event)) return
          if (event.value.type === "closed") {
            void run(leave)
            return
          }
          setRoom(event.value.room)
        }
        socket.onerror = () => socket.close()
        socket.onclose = () => {
          setOnline(false)
          resume(Effect.fail(new Error("Room presence disconnected")))
        }
        return Effect.sync(() => {
          socket.onclose = null
          socket.close()
          setOnline(false)
        })
      }).pipe(Effect.retry(Schedule.spaced("2 seconds")))
      yield* Effect.forkScoped(listen).pipe(Effect.provideService(Scope.Scope, presence))
    })
    const start = Effect.gen(function* () {
      const author = yield* identity
      if (!author) return
      const selected = ctx.ui.model.current()
      ctx.ui.toast.show({ message: "Starting room and setting up remote access…", duration: 10_000 })
      const response = yield* rpc("start", {
        ...author,
        model: selected
          ? { providerID: selected.providerID, id: selected.modelID, variant: selected.variant }
          : undefined,
      })
      const ticket = yield* Schema.decodeUnknownEffect(Ticket)(response.output)
      state.host = true
      yield* connect(ticket)
      ctx.ui.router.navigate({ type: "session", sessionID: ticket.room.sessionID })
      yield* Effect.tryPromise(() =>
        ctx.ui.dialog.alert({ title: "Room invite · share this URL", message: ticket.joinURL }),
      )
    })
    const join = Effect.fn("Multiplayer.join")(
      function* (input: string | undefined) {
        const invite =
          input?.trim() || (yield* Effect.tryPromise(() => ctx.ui.dialog.prompt({ title: "Room invite URL" })))
        if (!invite) return
        const url = yield* Effect.try(() => new URL(invite))
        if (
          (url.protocol !== "https:" &&
            !(url.protocol === "http:" && ["127.0.0.1", "localhost"].includes(url.hostname))) ||
          !/^\/j\/[^/]+$/.test(url.pathname) ||
          url.username ||
          url.password
        )
          return yield* Effect.fail(new Error("Use a room's https://…/j/… invite URL"))
        const author = yield* identity
        if (!author) return
        const response = yield* Effect.tryPromise((signal) =>
          fetch(url, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(author),
            signal,
          }),
        )
        if (!response.ok)
          return yield* Effect.fail(new Error("Could not join: invite expired, room full, or host unavailable"))
        const ticket = yield* Effect.tryPromise(() => response.text()).pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(Ticket))),
        )
        // Authenticate only to the origin the user chose, never a response-supplied redirect target.
        if (new URL(ticket.gatewayURL).origin !== url.origin)
          return yield* Effect.fail(new Error("Room origin does not match invite"))
        state.connection = ctx.ui.connection.current()
        state.route = ctx.ui.router.current()
        const api = OpenCode.make({ baseUrl: ticket.gatewayURL, headers: { authorization: `Bearer ${ticket.token}` } })
        yield* Effect.tryPromise(() =>
          ctx.ui.connection.replace({ api, location: { directory: ticket.room.directory }, external: true }),
        )
        yield* connect(ticket)
        ctx.ui.router.navigate({ type: "session", sessionID: ticket.room.sessionID })
      },
      (effect) => effect.pipe(Effect.onError(() => leave.pipe(Effect.ignore))),
    )
    const stop = Effect.gen(function* () {
      yield* rpc("stop", {})
      yield* leave
    })
    const command = (effect: Effect.Effect<unknown, unknown, Scope.Scope>) =>
      run(
        Effect.gen(function* () {
          if (busy()) return
          setBusy(true)
          yield* effect.pipe(Effect.ensuring(Effect.sync(() => setBusy(false))))
        }).pipe(Effect.asVoid),
      )
    ctx.keymap.layer(() => ({
      mode: "global",
      commands: [
        {
          id: "multiplayer.host",
          title: "Host multiplayer room",
          slash: { name: "host" },
          palette: true,
          enabled: () => !room() && !busy(),
          run: () => command(start),
        },
        {
          id: "multiplayer.join",
          title: "Join multiplayer room",
          slash: { name: "join", arguments: true },
          palette: true,
          enabled: () => !room() && !busy(),
          run: (input) => command(join(input)),
        },
        {
          id: "multiplayer.leave",
          title: "Leave multiplayer room",
          slash: { name: "leave" },
          palette: true,
          enabled: () => !!room(),
          run: () => command(leave),
        },
        {
          id: "multiplayer.stop",
          title: "Stop multiplayer room",
          slash: { name: "stop" },
          palette: true,
          enabled: () => !!room() && state.host,
          run: () => command(stop),
        },
        {
          id: "multiplayer.invite",
          title: "Show room invite",
          slash: { name: "invite" },
          palette: true,
          enabled: () => !!room() && state.host,
          run: () =>
            command(
              Effect.tryPromise(() =>
                ctx.ui.dialog.alert({ title: "Room invite", message: state.ticket?.joinURL ?? "" }),
              ),
            ),
        },
        {
          id: "multiplayer.room",
          title: "Show room roster",
          slash: { name: "room" },
          palette: true,
          enabled: () => !!room(),
          run: () => {
            ctx.ui.panel.open("multiplayer.room")
          },
        },
      ],
    }))
    const unsubscribe = ctx.ui.prompt.onChange((input) => {
      if (!room() || input.sessionID !== room()?.sessionID || state.socket?.readyState !== WebSocket.OPEN) return
      const active = input.text.length > 0
      if (active && Date.now() - state.lastTyping < 800) return
      state.lastTyping = Date.now()
      void run(Effect.sync(() => state.socket?.send(JSON.stringify({ type: "typing", active }))))
    })
    ctx.ui.slot({
      append: "session.composer.top",
      render: (props) => (
        <Show when={room()?.sessionID === props.sessionID}>
          <text fg={ctx.theme.text.muted}>
            {online()
              ? `Room · ${room()?.members.filter((member) => member.online).length} online`
              : "Room disconnected · /leave to return"}
            {typing() ? ` · ${typing()} typing…` : ""}
          </text>
        </Show>
      ),
    })
    ctx.ui.slot({
      append: "session.panel",
      render: (props) => (
        <Show when={props.name === "multiplayer.room" && room()?.sessionID === props.sessionID}>
          <box flexDirection="column" padding={1} gap={1}>
            <text fg={ctx.theme.text.base}>Multiplayer room · approvals are host-only</text>
            <For each={room()?.members}>
              {(member) => (
                <box flexDirection="row" gap={1}>
                  <AuthorLabel author={member} theme={ctx.theme} />
                  <text fg={ctx.theme.text.muted}>
                    {member.online ? "online" : "offline"}
                    {member.typing ? " · typing…" : ""}
                  </text>
                </box>
              )}
            </For>
            <text fg={ctx.theme.text.muted}>/invite · /leave{state.host ? " · /stop" : ""}</text>
          </box>
        </Show>
      ),
    })
    return () =>
      Effect.runPromise(
        leave.pipe(
          Effect.ensuring(Scope.close(scope, Exit.void)),
          Effect.ensuring(Effect.sync(unsubscribe)),
          Effect.ignore,
        ),
      )
  },
})
