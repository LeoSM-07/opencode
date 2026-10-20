import { expect, test } from "bun:test"
import { InputRenderable, TextareaRenderable } from "@opentui/core"
import { Effect, Exit, Schema, Scope } from "effect"
import { gateway } from "../../multiplayer/src/gateway"
import { makeRoom } from "../../multiplayer/src/room"
import { Author } from "@opencode/multiplayer/protocol"
import { createAppFixture } from "./fixture/app"
import { createEventStream, createFetch, directory, json } from "./fixture/tui-client"

test.each([false, true])(
  "guest composer sends without shared selection writes (changed agent: %s)",
  async (changeAgent) => {
    const scope = Effect.runSync(Scope.make())
    await using _ = { [Symbol.asyncDispose]: () => Effect.runPromise(Scope.close(scope, Exit.void)) }
    const sessionID = `ses_guest_${crypto.randomUUID()}`
    const location = { directory, project: { id: "project", directory, canonical: directory } }
    const prompts: Array<{ text: string; metadata: { author: { name: string; role: string } } }> = []
    const selections: string[] = []
    const events = createEventStream()
    const host = createFetch(async (url, request) => {
      if (url.pathname === "/api/location") return json(location)
      if (url.pathname === `/api/session/${sessionID}`)
        return json({
          data: {
            id: sessionID,
            projectID: "project",
            title: "Room send fixture",
            agent: "build",
            model: { providerID: "demo", id: "model" },
            location: { directory },
            cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            time: { created: 0, updated: 0 },
          },
        })
      if (url.pathname === `/api/session/${sessionID}/message`)
        return json({
          data: [
            {
              id: "msg_host_welcome",
              type: "user",
              text: "Host welcome",
              time: { created: 0 },
              metadata: { author: { id: "host", name: "Player 1", color: 0, role: "host" } },
            },
          ],
          cursor: {},
        })
      if (url.pathname === `/api/session/${sessionID}/inbox`) return json({ data: [] })
      if (url.pathname === "/api/agent")
        return json({
          location,
          data: ["build", "plan"].map((id) => ({ id, name: id, mode: "primary", hidden: false, permissions: [] })),
        })
      if (url.pathname === "/api/provider")
        return json({ location, data: [{ id: "demo", name: "Demo", package: "", activation: "enabled" }] })
      if (url.pathname === "/api/model")
        return json({
          location,
          data: [
            {
              id: "model",
              providerID: "demo",
              name: "Host Model",
              variants: [],
              cost: [],
              time: { released: 0 },
              capabilities: { input: ["text"], output: ["text"], tools: true },
            },
          ],
        })
      if (/\/(agent|model)$/.test(url.pathname) && request.method === "POST") selections.push(url.pathname)
      if (url.pathname === `/api/session/${sessionID}/prompt`) {
        const body = await Schema.decodeUnknownPromise(
          Schema.Struct({
            id: Schema.String,
            text: Schema.String,
            metadata: Schema.Struct({ author: Author }),
          }),
        )(await request.json())
        prompts.push(body)
        return json({
          data: {
            id: body.id,
            sessionID,
            type: "user",
            delivery: "steer",
            payload: { text: body.text, metadata: body.metadata },
            time: { created: 1 },
          },
        })
      }
      return undefined
    }, events)
    const room = await Effect.runPromise(
      makeRoom({ sessionID, directory, host: { name: "Host", color: 0 } }).pipe(
        Effect.provideService(Scope.Scope, scope),
      ),
    )
    const target = await Effect.runPromise(
      gateway({ server: { fetch: (request) => Effect.tryPromise(() => host.fetch(request)) } }, room).pipe(
        Effect.provideService(Scope.Scope, scope),
      ),
    )
    room.state.gatewayURL = target
    await using setup = await createAppFixture({ config: { animations: false, keybinds: { "agent.cycle": "f6" } } })
    await setup.ready
    await setup.waitForFrame(() => setup.renderer.currentFocusedRenderable instanceof TextareaRenderable)
    await setup.mockInput.typeText("/join")
    await setup.waitForFrame((frame) => frame.includes("Join multiplayer room"))
    await setup.mockInput.typeText(` ${target}/j/${room.code}`)
    setup.mockInput.pressEscape()
    setup.mockInput.pressEnter()
    await setup.waitForFrame(
      (frame) =>
        frame.includes("Your room display name") &&
        setup.renderer.currentFocusedRenderable instanceof TextareaRenderable,
    )
    await setup.mockInput.typeText("Guest")
    setup.mockInput.pressEnter()
    await setup.waitForFrame(
      (frame) =>
        frame.includes("Your message color") && setup.renderer.currentFocusedRenderable instanceof InputRenderable,
    )
    setup.mockInput.pressEnter()
    await setup.waitForFrame(
      (frame) =>
        frame.includes("Room · 1 online") &&
        frame.includes("Player 1 (host)") &&
        frame.includes("Host Model") &&
        setup.renderer.currentFocusedRenderable instanceof TextareaRenderable,
    )
    if (changeAgent) {
      setup.mockInput.pressKey("F6")
      await setup.waitForFrame((frame) => frame.includes("Plan ·"))
    }
    await setup.mockInput.typeText("Message from guest")
    setup.mockInput.pressEnter()
    const frame = await setup.waitForFrame(
      (frame) =>
        prompts.length > 0 || frame.includes("Failed to send prompt") || frame.includes("Failed to prepare session"),
    )
    expect(frame).not.toContain("Failed to switch model")
    expect(frame).not.toContain("Failed to prepare session")
    expect(prompts).toHaveLength(1)
    expect(prompts[0]).toMatchObject({
      text: "Message from guest",
      metadata: { author: { name: "Guest", role: "guest" } },
    })
    expect(selections).toEqual([])
  },
)
