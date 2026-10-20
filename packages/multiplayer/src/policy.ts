import { Effect, Schema } from "effect"
import { PromptInput } from "@opencode/schema/prompt-input"
import type { Author } from "./protocol.js"

const Prompt = Schema.Struct({
  text: Schema.String,
  files: Schema.Array(PromptInput.FileAttachment).pipe(Schema.optional),
  delivery: Schema.Literals(["steer", "queue"]).pipe(Schema.optional),
  id: Schema.String.pipe(Schema.optional),
})

export function promptBody(text: string, author: Author) {
  return Schema.decodeUnknownEffect(Schema.fromJsonString(Prompt))(text).pipe(
    Effect.flatMap((body) =>
      body.files?.some((file) => !file.uri.startsWith("data:"))
        ? Effect.fail(new Error("Only inline attachments are supported in rooms"))
        : Effect.succeed(JSON.stringify({ ...body, metadata: { author } })),
    ),
  )
}

/** Unknown paths and all shared controls are denied, not forwarded optimistically. */
export function allowed(method: string, path: string, family: ReadonlySet<string>) {
  const session = /^\/api\/session\/([^/]+)(.*)$/.exec(path)
  if (session && family.has(session[1])) {
    if (method === "POST") return session[2] === "/prompt" || session[2] === "/view"
    return (
      method === "GET" &&
      /^(|\/message(?:\/[^/]+)?|\/context|\/diff|\/inbox|\/permission(?:\/[^/]+)?|\/form(?:\/[^/]+)?)$/.test(session[2])
    )
  }
  return (
    method === "GET" &&
    /^\/api\/(info|event|location|session|session\/active|agent(?:\/[^/]+)?|model(?:\/default)?|provider(?:\/[^/]+)?|config|config\/shell|plugin|command|skill|reference|integration|worktree|project|permission\/request|form|shell|mcp|mcp\/resource|vcs|websearch\/provider)$/.test(
      path,
    )
  )
}

const EventFrame = Schema.Struct({
  type: Schema.String,
  data: Schema.Record(Schema.String, Schema.Unknown),
})
const decodeFrame = Schema.decodeUnknownOption(Schema.fromJsonString(EventFrame))

export function eventAllowed(text: string, family: Set<string>) {
  const event = decodeFrame(text)
  if (event._tag === "None") return false
  if (event.value.type === "server.connected") return true
  const data = event.value.data
  if (
    event.value.type === "session.created" &&
    typeof data.parentID === "string" &&
    family.has(data.parentID) &&
    typeof data.sessionID === "string"
  )
    family.add(data.sessionID)
  return (
    /^(session|permission|form)\./.test(event.value.type) &&
    typeof data.sessionID === "string" &&
    family.has(data.sessionID)
  )
}

/** A stream transform preserves backpressure and heartbeat comments without buffering SSE. */
export function filterEvents(family: Set<string>) {
  const state = { pending: "" }
  return new TransformStream<string, string>({
    transform(chunk, controller) {
      state.pending += chunk.replaceAll("\r\n", "\n")
      const blocks = state.pending.split("\n\n")
      state.pending = blocks.pop() ?? ""
      blocks.forEach((block) => {
        const data = block
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart())
          .join("\n")
        if ((!data && block.startsWith(":")) || eventAllowed(data, family)) controller.enqueue(block + "\n\n")
      })
    },
  })
}

type Json = Schema.Schema.Type<typeof Schema.Json>
const isArray = (value: Json): value is ReadonlyArray<Json> => Array.isArray(value)
export const object = (value: Json): Record<string, Json> =>
  value !== null && typeof value === "object" && !isArray(value) ? value : {}

export function sanitize(path: string, value: Json, family: ReadonlySet<string>) {
  const result = object(value)
  if (path === "/api/info")
    return {
      version: result.version,
      pid: 0,
      urls: [],
      paths: { tmp: "" },
      capabilities: { persistentPty: false },
    }
  if (path === "/api/session/active")
    return { data: Object.fromEntries(Object.entries(object(result.data)).filter(([id]) => family.has(id))) }
  if (path === "/api/session")
    return {
      data: Array.isArray(result.data) ? result.data.filter((item) => family.has(String(object(item).id))) : [],
      cursor: {},
    }
  if (/^\/api\/(permission\/request|form)$/.test(path))
    return {
      ...result,
      data: Array.isArray(result.data) ? result.data.filter((item) => family.has(String(object(item).sessionID))) : [],
    }
  if (/^\/api\/provider(?:\/|$)/.test(path)) {
    const clean = (item: Json) =>
      Object.fromEntries(
        Object.entries(object(item)).filter(([key]) => ["id", "name", "activation", "package"].includes(key)),
      )
    return { ...result, data: Array.isArray(result.data) ? result.data.map(clean) : clean(result.data) }
  }
  if (/^\/api\/agent(?:\/|$)/.test(path)) {
    const clean = (item: Json) => ({
      ...Object.fromEntries(
        Object.entries(object(item)).filter(([key]) =>
          ["id", "name", "model", "description", "mode", "hidden", "color", "steps", "permissions"].includes(key),
        ),
      ),
      request: { settings: {}, headers: {}, body: {} },
    })
    return { ...result, data: Array.isArray(result.data) ? result.data.map(clean) : clean(result.data) }
  }
  if (path === "/api/model") {
    const clean = (item: Json) =>
      Object.fromEntries(
        Object.entries(object(item)).filter(([key]) => !["headers", "body", "settings", "variants"].includes(key)),
      )
    return {
      ...result,
      data: Array.isArray(result.data)
        ? result.data.map((item) => {
            const variants = object(item).variants
            return {
              ...clean(item),
              variants: isArray(variants) ? variants.map((variant) => ({ id: object(variant).id })) : [],
            }
          })
        : [],
    }
  }
  return value
}
