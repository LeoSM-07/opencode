import { expect, sourceURL, story } from "../../storybook/playwright/story"
import type { Accessor, ParentProps } from "solid-js"
import type { Command, MenuItem } from "@opencode/gui-extensions/sdk"
import type { Item } from "../src/runtime/extension/host"

const source = (path: string) => sourceURL(new URL(path, import.meta.url))

const modules = {
  fixture: source("../../gui-extensions/src/browser/panel.fixture.tsx"),
  host: source("../src/runtime/extension/host.tsx"),
  panels: source("../src/runtime/extension/panels.tsx"),
  closed: source("../src/runtime/extension/closed-tabs.ts"),
  language: source("../src/runtime/i18n/language.tsx"),
  browser: source("../../gui-extensions/src/browser/index.ts"),
  browserRenderer: source("../../gui-extensions/src/browser/renderer.tsx"),
  browserPanel: source("../../gui-extensions/src/browser/panel.tsx"),
  file: source("../../gui-extensions/src/file/index.ts"),
  fileRenderer: source("../../gui-extensions/src/file/renderer.tsx"),
  commands: source("../src/shell/commands/command.tsx"),
  sdk: source("../../gui-extensions/src/sdk/index.ts"),
  render: source("../src/runtime/extension/render.tsx"),
  settings: source("../src/settings/model.tsx"),
  platform: source("../src/runtime/platform/platform.tsx"),
  solid: source("./extension-host.fixture.tsx"),
}

story.beforeEach(async ({ mount, page }) => {
  // Any story loads the app styles; the fixture mounts the real side region and extensions beside it.
  await mount("ui-line-comment--editor")
  await page.evaluate(async (modules) => {
    const [
      { mountBrowserRegion },
      host,
      panels,
      language,
      browser,
      file,
      commands,
      sdk,
      renderer,
      settings,
      platform,
      solid,
      closed,
    ] = await Promise.all([
      import(modules.fixture),
      import(modules.host),
      import(modules.panels),
      import(modules.language),
      import(modules.browser),
      import(modules.file),
      import(modules.commands),
      import(modules.sdk),
      import(modules.render),
      import(modules.settings),
      import(modules.platform),
      import(modules.solid),
      import(modules.closed),
      // Load the pane before mounting: Vite must not reload the page to optimize its dependencies mid-fixture.
      import(modules.browserPanel),
    ])

    const closedTabs = closed.createClosedTabs()
    mountBrowserRegion({
      LanguageProvider: language.LanguageProvider,
      ExtensionHostProvider: host.ExtensionHostProvider,
      useExtensionHost: host.useExtensionHost,
      createRegion: (region: Omit<Parameters<typeof panels.createRegion>[0], "closed">) =>
        panels.createRegion({ ...region, closed: closedTabs }),
      definitions: [
        { ...browser.default, renderer: () => import(modules.browserRenderer) },
        { ...file.default, renderer: () => import(modules.fileRenderer) },
      ],
      Shell: (props: ParentProps) =>
        solid.createComponent(platform.PlatformProvider, {
          value: { platform: "web", openExternal() {}, restart: async () => undefined, notify: async () => undefined },
          get children() {
            return solid.createComponent(settings.SettingsProvider, {
              get children() {
                return solid.createComponent(commands.CommandProvider, {
                  get children() {
                    return props.children
                  },
                })
              },
            })
          },
        }),
      Commands: (props: {
        close: () => void
        review: () => void
        newSession: () => void
        reopenSession: () => void
        reopenSide: () => void
        shortcut: (shortcut: Accessor<string>) => void
      }) => {
        const command = commands.useCommand()
        const inSide = closed.createSideFocus()
        const extensions = host.useExtensionHost()
        // What the side strip's + shows beside the browser item, through the host's own formatter.
        props.shortcut(() => {
          const item = extensions.list(sdk.MenuItem).find((value: MenuItem) => value.menu === "session.panel")

          return item?.menu === "session.panel" && item.keybind ? command.keybind(item.keybind) : ""
        })
        command.register("fixture-session", () => [
          {
            id: "tab.close",
            title: "Close session tab",
            keybind: "mod+w",
            onSelect: props.close,
          },
          {
            id: "tab.new",
            title: "New session",
            keybind: "mod+t,mod+n",
            onSelect: props.newSession,
          },
          { id: "tab.reopenClosed", title: "", keybind: "mod+shift+t", onSelect: props.reopenSession },
          { id: "file.tab.reopen", title: "", keybind: "mod+shift+t", when: inSide, onSelect: props.reopenSide },
          {
            id: "review.toggle",
            title: "Toggle review",
            keybind: "mod+shift+r",
            onSelect: props.review,
          },
        ])
        // Storybook aliases the app's command hook to a no-op. Bridge the real extension contributions
        // to the real dispatcher imported by source URL, so the shortcut runs rather than its alias.
        command.register("fixture-extensions", () =>
          extensions.items(sdk.Command).map((item: Item<Command>) => {
            const scope = item.value.scope

            return {
              id: `${item.extension}.${item.value.id}`,
              title: item.value.title,
              keybind: item.value.bind,
              disabled: item.value.enabled === false,
              hidden: item.value.hidden,
              editable: item.value.editable,
              when: scope
                ? (event: KeyboardEvent) => event.target instanceof Element && !!event.target.closest(scope)
                : undefined,
              onSelect: () => item.value.run(),
            }
          }),
        )

        return null
      },
      Contribution: renderer.Contribution,
    })
  }, modules)
})

story("closes a blank browser tab from its address field without closing the session", async ({ page }) => {
  const root = page.getByTestId("browser-region-fixture")
  const outside = root.getByRole("button", { name: "Beta", exact: true })
  await expect(root.getByText("Registrations: 1", { exact: true })).toBeVisible()
  await outside.click()
  await expect(root.getByText("Registrations: 2", { exact: true })).toBeVisible()
  await root.getByRole("button", { name: "Blank page", exact: true }).click()
  await expect(root.getByRole("tab", { name: "New tab", exact: true })).toHaveAttribute("aria-selected", "true")

  // Prove the scope while browser.close is still registered.
  await outside.focus()
  await outside.press("ControlOrMeta+w")
  await expect(root.getByTestId("session-state")).toHaveText("closed")
  await expect(root.getByTestId("browser-closes")).toHaveText("[]")
  await expect(root.getByRole("tab", { name: "New tab", exact: true })).toBeVisible()
  await outside.click()
  await expect(root.getByTestId("session-state")).toHaveText("open")

  const address = root.getByRole("combobox", { name: "Browser address", exact: true })
  await address.fill("example.com")
  await expect(address).toBeFocused()
  await address.press("ControlOrMeta+w")
  await expect(root.getByRole("tab", { name: "New tab", exact: true })).toHaveCount(0)
  await expect(root.getByTestId("browser-closes")).toHaveText('["tab_33333333-3333-3333-3333-333333333333"]')
  await expect(root.getByTestId("session-state")).toHaveText("open")
})

story("toggles the element picker from the shortcut only inside the browser pane", async ({ page }) => {
  const root = page.getByTestId("browser-region-fixture")
  const outside = root.getByRole("button", { name: "Beta", exact: true })
  await expect(root.getByText("Registrations: 1", { exact: true })).toBeVisible()
  await outside.click()
  await expect(root.getByText("Registrations: 2", { exact: true })).toBeVisible()

  await root.getByRole("button", { name: "Blank page", exact: true }).click()
  const inspect = root.getByRole("button", { name: "Select an element to comment on", exact: true })
  const address = root.getByRole("combobox", { name: "Browser address", exact: true })
  await expect(inspect).toBeDisabled()
  await address.click()
  await address.press("ControlOrMeta+Shift+c")
  await expect(root.getByTestId("browser-inspects")).toHaveText("[]")

  await root.getByRole("button", { name: "First inventory", exact: true }).click()
  await expect(inspect).toBeEnabled()

  await outside.focus()
  await outside.press("ControlOrMeta+Shift+c")
  await expect(inspect).toHaveAttribute("aria-pressed", "false")
  await expect(root.getByTestId("browser-inspects")).toHaveText("[]")

  await address.click()
  await expect(address).toBeFocused()
  await address.press("ControlOrMeta+Shift+c")
  await expect(inspect).toHaveAttribute("aria-pressed", "true")
  await expect(root.getByTestId("browser-inspects")).toHaveText(
    '[{"tabID":"tab_33333333-3333-3333-3333-333333333333","enabled":true}]',
  )

  await address.press("ControlOrMeta+Shift+c")
  await expect(inspect).toHaveAttribute("aria-pressed", "false")
  await expect(root.getByTestId("browser-inspects")).toHaveText(
    '[{"tabID":"tab_33333333-3333-3333-3333-333333333333","enabled":true},{"tabID":"tab_33333333-3333-3333-3333-333333333333","enabled":false}]',
  )
})

story("keeps in-page shortcuts like ⌘K in the page while forwarding ⌘⇧R and ⌘W to the pane", async ({ page }) => {
  const root = page.getByTestId("browser-region-fixture")
  const mac = await page.evaluate(() => /Mac|iPhone|iPad|iPod/.test(navigator.platform))
  const mod = mac ? "Meta" : "Control"

  const editor = page
    .frameLocator('iframe[title="Browser page"]')
    .getByRole("textbox", { name: "Editor page input", exact: true })

  await expect(root.getByText("Registrations: 1", { exact: true })).toBeVisible()
  await root.getByRole("button", { name: "Beta", exact: true }).click()
  await expect(root.getByText("Registrations: 2", { exact: true })).toBeVisible()
  await root.getByRole("button", { name: "First inventory", exact: true }).click()
  await expect(root.getByRole("tab", { name: "Preview", exact: true })).toHaveAttribute("aria-selected", "true")

  // In-page shortcuts like ⌘K stay with the focused page.
  await editor.focus()
  await editor.press(`${mod}+k`)
  await expect(editor).toHaveValue("handled:k")

  // Shell shortcuts like ⌘⇧R and pane-scoped ⌘W are claimed before the page sees them.
  await editor.press(`${mod}+Shift+r`)
  await expect(root.getByTestId("review-toggles")).toHaveText("1")
  await editor.press(`${mod}+w`)
  await expect(editor).toHaveValue("handled:k")
  await expect(root.getByTestId("browser-closes")).toHaveText('["tab_33333333-3333-3333-3333-333333333333"]')
  await expect(root.getByTestId("session-state")).toHaveText("open")
})

story("opens a browser tab with ⌘T inside the pane and a session everywhere else", async ({ page }) => {
  const root = page.getByTestId("browser-region-fixture")
  const mac = await page.evaluate(() => /Mac|iPhone|iPad|iPod/.test(navigator.platform))
  const mod = mac ? "Meta" : "Control"
  const outside = root.getByRole("button", { name: "Beta", exact: true })
  const address = root.getByRole("combobox", { name: "Browser address", exact: true })
  const editor = page.frameLocator('iframe[title="Browser page"]').getByRole("textbox", { name: "Editor page input" })
  const opens = root.getByTestId("browser-opens")
  const sessions = root.getByTestId("new-sessions")
  await expect(root.getByText("Registrations: 1", { exact: true })).toBeVisible()
  // Alpha shows a file tab, so the + advertises no browser shortcut.
  await expect(root.getByTestId("add-shortcut")).toHaveText("none")
  await outside.click()
  await expect(root.getByText("Registrations: 2", { exact: true })).toBeVisible()
  await root.getByRole("button", { name: "First inventory", exact: true }).click()
  await expect(root.getByRole("tab", { name: "Preview", exact: true })).toHaveAttribute("aria-selected", "true")
  await expect(root.getByTestId("add-shortcut")).toHaveText(mac ? "⌘T" : "Ctrl+T")

  // Outside the pane the shell keeps ⌘T.
  await outside.focus()
  await outside.press(`${mod}+t`)
  await expect(sessions).toHaveText("1")
  await expect(opens).toHaveText("0")

  // Inside the pane it opens a browser tab instead.
  await address.focus()
  await address.press(`${mod}+t`)
  await expect(opens).toHaveText("1")

  // Dvorak's T sits on the physical K key: the shortcut follows the character, not the key position.
  await address.evaluate((element, meta) => {
    element.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "t",
        code: "KeyK",
        metaKey: meta,
        ctrlKey: !meta,
        bubbles: true,
        cancelable: true,
      }),
    )
  }, mac)
  await expect(opens).toHaveText("2")

  // A focused page hands the reserved chord to the pane before it sees it.
  await editor.focus()
  await editor.press(`${mod}+t`)
  await expect(opens).toHaveText("3")
  await expect(sessions).toHaveText("1")
})

story("reopens a closed browser tab with ⌘⇧T after the side panel and a session tab elsewhere", async ({ page }) => {
  const root = page.getByTestId("browser-region-fixture")
  const mac = await page.evaluate(() => /Mac|iPhone|iPad|iPod/.test(navigator.platform))
  const outside = root.getByRole("button", { name: "Beta", exact: true })
  const editor = page.frameLocator('iframe[title="Browser page"]').getByRole("textbox", { name: "Editor page input" })
  const opens = root.getByTestId("browser-opens")

  // Dvorak's T sits on the K key.
  const reopen = () =>
    page.evaluate((meta) => {
      const init = { key: "T", code: "KeyK", shiftKey: true, metaKey: meta, ctrlKey: !meta, bubbles: true }
      document.body.dispatchEvent(new KeyboardEvent("keydown", init))
    }, mac)

  await expect(root.getByText("Registrations: 1", { exact: true })).toBeVisible()
  await outside.click()
  await expect(root.getByText("Registrations: 2", { exact: true })).toBeVisible()
  await root.getByRole("button", { name: "First inventory", exact: true }).click()
  await expect(root.getByRole("tab", { name: "Preview", exact: true })).toHaveAttribute("aria-selected", "true")

  // The page hands ⌘W to the pane; the pane and the page go, leaving no focus.
  await editor.press(`${mac ? "Meta" : "Control"}+w`)
  await expect(root.getByTestId("selected")).toHaveText("file://beta.ts")

  await reopen()
  await expect(opens).toHaveText("1")

  // Once the user is outside the side panel, ⌘⇧T reopens a session tab again.
  await outside.click()
  await reopen()
  await expect(root.getByTestId("session-reopens")).toHaveText("1")
  await expect(opens).toHaveText("1")
})

story("keeps a restored browser tab selected and undrawn until the desktop's first inventory", async ({ page }) => {
  const root = page.getByTestId("browser-region-fixture")
  const tabs = root.getByRole("tab")
  const tree = root.getByTestId("tree")
  await expect(root.getByText("Registrations: 1", { exact: true })).toBeVisible()
  await expect(tabs).toHaveText(["alpha.ts"])
  await expect(tree).toHaveText('{"tab":"changes"}')

  // Beta was left on its browser tab, which the desktop has not reported yet.
  await root.getByRole("button", { name: "Beta", exact: true }).click()
  await expect(root.getByText("Registrations: 2", { exact: true })).toBeVisible()
  await expect(root.getByTestId("selected")).toHaveText(/^browser:tab_/)
  await expect(tabs).toHaveText(["beta.ts"])
  // No fallback tab was selected, so the file tab's selection never switched the tree to All files.
  await expect(tree).toHaveText('{"tab":"changes"}')

  await root.getByRole("button", { name: "First inventory", exact: true }).click()
  await expect(tabs).toHaveText(["beta.ts", "Preview"])
  await expect(root.getByRole("tab", { name: "Preview", exact: true })).toHaveAttribute("aria-selected", "true")
  await expect(tree).toHaveText('{"tab":"changes"}')
})

story(
  "keeps the browser tabs while the pane's Ipc is away and registers them again when it returns",
  async ({ page }) => {
    const root = page.getByTestId("browser-region-fixture")
    const tabs = root.getByRole("tab")
    await expect(root.getByText("Registrations: 1", { exact: true })).toBeVisible()
    await root.getByRole("button", { name: "Beta", exact: true }).click()
    await expect(root.getByText("Registrations: 2", { exact: true })).toBeVisible()
    await root.getByRole("button", { name: "First inventory", exact: true }).click()
    await expect(tabs).toHaveText(["beta.ts", "Preview"])

    // The pane's main extension reloads: every binding goes with it, and the strip keeps the tab it will restore.
    await root.getByRole("button", { name: "Pane away", exact: true }).click()
    await expect(tabs).toHaveText(["beta.ts", "Preview"])
    await expect(root.getByRole("tab", { name: "Preview", exact: true })).toHaveAttribute("aria-selected", "true")

    // Both attachments register again at once, without a retry timer; Beta hands main the tab to restore.
    await root.getByRole("button", { name: "Pane back", exact: true }).click()
    await expect(root.getByText("Registrations: 4", { exact: true })).toBeVisible()
    await expect(root.getByText("Beta restores: 1", { exact: true })).toBeVisible()
    await expect(tabs).toHaveText(["beta.ts", "Preview"])
  },
)
