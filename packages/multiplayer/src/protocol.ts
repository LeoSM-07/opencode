import { Rpc } from "@opencode/plugin/rpc"
import { Model } from "@opencode/schema/model"
import { Schema } from "effect"

export const Identity = Schema.Struct({
  name: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(40), Schema.isPattern(/^[^\p{C}]+$/u)),
  color: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 7 })),
})

export const HostInput = Schema.Struct({
  ...Identity.fields,
  model: Model.Ref.pipe(Schema.optional),
})

export const Author = Schema.Struct({
  ...Identity.fields,
  id: Schema.String,
  role: Schema.Literals(["host", "guest"]),
})
export type Author = typeof Author.Type

export const Snapshot = Schema.Struct({
  roomID: Schema.String,
  sessionID: Schema.String,
  directory: Schema.String,
  members: Schema.Array(Schema.Struct({ ...Author.fields, online: Schema.Boolean, typing: Schema.Boolean })),
})
export type Snapshot = typeof Snapshot.Type

export const Ticket = Schema.Struct({
  participantID: Schema.String,
  room: Snapshot,
  token: Schema.String,
  gatewayURL: Schema.String,
  joinURL: Schema.String,
})
export type Ticket = typeof Ticket.Type

export const ClientEvent = Schema.Union([
  Schema.Struct({ type: Schema.Literal("typing"), active: Schema.Boolean }),
  Schema.Struct({ type: Schema.Literal("leave") }),
])
export const RoomEvent = Schema.Union([
  Schema.Struct({ type: Schema.Literal("snapshot"), room: Snapshot }),
  Schema.Struct({ type: Schema.Literal("closed") }),
])

export const Multiplayer = Rpc.define({
  id: "opencode.multiplayer",
  methods: {
    start: { input: HostInput, output: Ticket, errors: { failed: Schema.String } },
    stop: { input: Schema.Struct({}), output: Schema.Boolean },
    status: { input: Schema.Struct({}), output: Schema.NullOr(Ticket) },
  },
  events: {},
})
