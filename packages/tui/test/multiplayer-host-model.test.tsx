import { expect, test } from "bun:test"
import { InputRenderable, TextareaRenderable } from "@opentui/core"
import { Schema } from "effect"
import { createAppFixture } from "./fixture/app"
import { directory, json } from "./fixture/tui-client"

test("hosting captures the composer's selected model before anyone prompts", async () => {
  const requested = Promise.withResolvers<unknown>()
  const sessionID = `ses_host_model_${crypto.randomUUID()}`
  const location = { directory, project: { id: "project", directory, canonical: directory } }
  await using setup = await createAppFixture({
    args: { sessionID },
    fetch: async (url, request) => {
      if (url.pathname === `/api/session/${sessionID}`)
        return json({
          data: {
            id: sessionID,
            projectID: "project",
            title: "Host model fixture",
            agent: "build",
            model: { providerID: "demo", id: "chosen", variant: "high" },
            location: { directory },
            cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            time: { created: 0, updated: 0 },
          },
        })
      if (/\/(message|inbox)$/.test(url.pathname)) return json({ data: [], cursor: {} })
      if (url.pathname === "/api/agent")
        return json({ location, data: [{ id: "build", mode: "primary", hidden: false, permissions: [] }] })
      if (url.pathname === "/api/provider") return json({ location, data: [{ id: "demo", name: "Demo" }] })
      if (url.pathname === "/api/model")
        return json({
          location,
          data: ["fallback", "chosen"].map((id) => ({
            id,
            providerID: "demo",
            name: `${id} model`,
            variants: [{ id: "high" }],
            cost: [],
            time: { released: 0 },
          })),
        })
      if (url.pathname === "/api/rpc/opencode.multiplayer/start") {
        requested.resolve(await Schema.decodeUnknownPromise(Schema.Json)(await request.json()))
        return json(
          { _tag: "RpcError", type: "failed", message: "Fixture stops before opening a tunnel" },
          { status: 400 },
        )
      }
      return undefined
    },
  })
  await setup.ready
  await setup.waitForFrame(
    (frame) => frame.includes("chosen model") && setup.renderer.currentFocusedRenderable instanceof TextareaRenderable,
  )
  await setup.mockInput.typeText("/host")
  await setup.waitForFrame((frame) => frame.includes("Host multiplayer room"))
  setup.mockInput.pressEnter()
  await setup.waitForFrame(
    (frame) =>
      frame.includes("Your room display name") && setup.renderer.currentFocusedRenderable instanceof TextareaRenderable,
  )
  await setup.mockInput.typeText("Host")
  setup.mockInput.pressEnter()
  const colors = await setup.waitForFrame(
    (frame) =>
      frame.includes("Your message color") && setup.renderer.currentFocusedRenderable instanceof InputRenderable,
  )
  expect(colors.match(/■/g)).toHaveLength(8)
  expect(colors).not.toContain("Color 1")
  setup.mockInput.pressEnter()
  expect(await requested.promise).toMatchObject({
    input: { name: "Host", color: 0, model: { providerID: "demo", id: "chosen", variant: "high" } },
  })
})
