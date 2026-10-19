import { expect, test, type Page } from "@playwright/test"
import type { SessionMessageInfo } from "@opencode/client/promise"
import { holdRoute, pageMessagesFrom, project, seed, session, sessionHref, SERVER } from "../utils/app"
import { mockOpenCodeServer } from "../utils/mock-server"

test.use({
  viewport: { width: 1280, height: 800 },
  serviceWorkers: "block",
})

const sessions = [
  { id: "ses_warm_atlas", directory: "/work/atlas", title: "Atlas renderer", model: "alpha" },
  { id: "ses_warm_borealis", directory: "/work/borealis", title: "Borealis sync", model: "beta" },
  { id: "ses_warm_cinder", directory: "/work/cinder", title: "Cinder release", model: "alpha" },
] as const

const provider = {
  all: [
    {
      id: "acme",
      name: "Acme",
      models: {
        alpha: { id: "alpha", name: "Alpha", limit: { context: 200_000 }, variants: { high: {}, low: {} } },
        beta: { id: "beta", name: "Beta", limit: { context: 200_000 }, variants: { high: {}, low: {} } },
      },
    },
  ],
  connected: ["acme"],
  default: { providerID: "acme", modelID: "alpha" },
}

const messages = Object.fromEntries(
  sessions.map((item): [string, SessionMessageInfo[]] => [
    item.id,
    [{ id: `msg_${item.id}_u`, type: "user", time: { created: 1700000000000 }, text: `${item.title}: question` }],
  ]),
)

async function open(page: Page) {
  await mockOpenCodeServer(page, {
    directory: sessions[0].directory,
    project: project({ id: "proj_atlas", directory: sessions[0].directory }),
    projects: sessions.map((item) => project({ id: `proj_${item.id}`, directory: item.directory })),
    sessions: sessions.map((item) =>
      session({
        id: item.id,
        title: item.title,
        directory: item.directory,
        location: { directory: item.directory },
        projectID: `proj_${item.id}`,
        agent: "build",
        model: { id: item.model, providerID: "acme", variant: "high" },
      }),
    ),
    provider,
    pageMessages: pageMessagesFrom(messages),
  })
  await seed(page, {
    tabs: sessions.map((item) => item.id),
    settings: { appearance: { tabLayout: "vertical" } },
    theme: { id: "oc-2", scheme: "dark" },
  })
}

const tab = (page: Page, id: string) => page.locator(`[data-slot="vertical-tabs"] a[href="${sessionHref(id, SERVER)}"]`)

const chip = (page: Page) => page.locator('[data-action="composer-model"]')

const message = (page: Page, id: string) =>
  page.locator(`[data-timeline-virtual-content] [data-message-id^="msg_${id}_"]`)

async function openAtlas(page: Page) {
  await page.goto(sessionHref(sessions[0].id))
  await expect(chip(page)).toHaveText("Acme / Alpha")
  await expect(message(page, sessions[0].id).first()).toBeVisible()
}

test("paints a session's model from the loaded catalog before its Location's agents and config load", async ({
  page,
}) => {
  await open(page)
  await openAtlas(page)
  const location = sessions[1].directory

  const held = await holdRoute(
    page,
    (url) =>
      ["/api/agent", "/api/config"].includes(url.pathname) && url.searchParams.get("location[directory]") === location,
  )

  try {
    await tab(page, sessions[1].id).click()

    await held.arrived
    await expect(chip(page)).toHaveText("Acme / Beta")
    await expect(page.getByRole("button", { name: "Choose model variant" })).toHaveText("high")
    const painted = await chip(page).elementHandle()
    held.release()
    await page.waitForResponse((response) => new URL(response.url()).pathname === "/api/agent")
    await page.waitForTimeout(300)
    // The loaded selection keeps the same chip instead of replacing it.
    expect(await painted?.evaluate((element) => element.isConnected)).toBe(true)
    await expect(chip(page)).toHaveText("Acme / Beta")
  } finally {
    held.release()
  }
})

test("loads a tab's transcript while the pointer rests on it, and not when it passes over", async ({ page }) => {
  const requested: string[] = []
  page.on("request", (request) => {
    const id = new URL(request.url()).pathname.match(/^\/api\/session\/([^/]+)\/message$/)?.[1]

    if (id && request.method() === "GET") requested.push(id)
  })

  await open(page)
  await openAtlas(page)

  // Raw moves keep the pass well under the dwell, which hover() actionability checks can exceed on slow runners.
  const [passed, rest] = await Promise.all([
    tab(page, sessions[2].id).boundingBox(),
    tab(page, sessions[0].id).boundingBox(),
  ])

  await page.mouse.move(passed!.x + passed!.width / 2, passed!.y + passed!.height / 2)
  await page.mouse.move(rest!.x + rest!.width / 2, rest!.y + rest!.height / 2)
  await page.waitForTimeout(300)
  expect(requested).not.toContain(sessions[2].id)

  await tab(page, sessions[1].id).hover()
  await expect.poll(() => requested.includes(sessions[1].id)).toBe(true)
  await tab(page, sessions[1].id).click()
  await expect(message(page, sessions[1].id).last()).toBeVisible()
  expect(requested.filter((id) => id === sessions[1].id)).toHaveLength(1)
})
