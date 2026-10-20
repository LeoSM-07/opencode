import {
  batch,
  createEffect,
  createMemo,
  For,
  mergeProps,
  on,
  onCleanup,
  Show,
  type Accessor,
  type JSX,
} from "solid-js"
import { Schema } from "effect"
import { createMediaQuery } from "@solid-primitives/media"
import {
  SESSION_REVIEW_V2_SIDEBAR_WIDTH_DEFAULT,
  SESSION_REVIEW_V2_SIDEBAR_WIDTH_MAX,
  SESSION_REVIEW_V2_SIDEBAR_WIDTH_MIN,
} from "@opencode/session-ui/v2/session-review-v2"
import {
  Panel,
  PanelContext,
  type PanelFrame,
  type PanelSidebar,
  type PanelTab,
  type MountedSession,
  type SessionScreen,
} from "@opencode/gui-extensions/sdk"
import { same } from "@/runtime/persistence/equality"
import { Persist, persisted } from "@/runtime/persistence/storage"
import { Persistence } from "@/runtime/persistence/schema"
import { useExtensionHost } from "./host"
import { Contribution } from "./render"
import { useExtensionAttachment } from "./attachment"
import { legacyKeys, panelKey } from "./panel-keys"
import type { createClosedTabs } from "./closed-tabs"

type Tabs = Accessor<{
  all(): string[]
  active(): string | undefined
  setAll(all: string[]): void
  setActive(tab: string | undefined): void
  close(tab: string): void
  remap(rewrite: (tab: string) => string): void
}>

export type RegionEntry = {
  readonly key: string
  readonly extension: string
  readonly tab: PanelTab
  readonly provider: Panel
}

const SidebarState = Persistence.struct({
  sidebarOpened: Schema.Boolean,
  sidebarWidth: Schema.Finite.check(
    Schema.isBetween({ minimum: SESSION_REVIEW_V2_SIDEBAR_WIDTH_MIN, maximum: SESSION_REVIEW_V2_SIDEBAR_WIDTH_MAX }),
  ),
  expandMode: Schema.Literals(["expand", "collapse"]),
})

/**
 * The inner sidebar preference every side panel shares. The key predates extensions. `Layout.sidebar` reads it while
 * the session screen that created it is mounted.
 */
export function createPanelSidebar(): PanelSidebar {
  const [store, setStore, , ready] = persisted(Persist.global("review-panel-v2"), SidebarState, {
    sidebarOpened: true,
    sidebarWidth: SESSION_REVIEW_V2_SIDEBAR_WIDTH_DEFAULT,
    expandMode: "collapse",
  })

  const sidebar: PanelSidebar = {
    opened: () => store.sidebarOpened,
    width: () => store.sidebarWidth,
    transition: ready,
    resize: (width) =>
      setStore(
        "sidebarWidth",
        Math.min(SESSION_REVIEW_V2_SIDEBAR_WIDTH_MAX, Math.max(SESSION_REVIEW_V2_SIDEBAR_WIDTH_MIN, width)),
      ),
    toggle: () => setStore("sidebarOpened", (opened) => !opened),
  }

  onCleanup(useExtensionAttachment().sidebar(sidebar))

  return sidebar
}

/**
 * Every panel extensions offer in one region of the routed session, merged with the stored strip. `view` returns the
 * routed session's object, a new one per routed session.
 */
export function createRegion(input: {
  region: Panel["region"]
  view: Accessor<MountedSession>
  screen: SessionScreen
  tabs: Tabs
  closed: ReturnType<typeof createClosedTabs>
  /** Runs when a close leaves no stored tab, in the same batch as the close. */
  onEmptied?: () => void
}) {
  const host = useExtensionHost()
  const stored = () => input.tabs().all()
  const providers = createMemo(() => host.items(Panel).filter((item) => item.value.region === input.region))

  const entries = createMemo(() =>
    providers().flatMap((item) => {
      const prefix = `${item.extension}:`
      const open = stored().flatMap((key) => (key.startsWith(prefix) ? [key.slice(prefix.length)] : []))

      return item.value.list(panelInput(input.view, input.screen, { open })).map(
        (tab): RegionEntry => ({
          key: panelKey(item.extension, tab.id),
          extension: item.extension,
          tab,
          provider: item.value,
        }),
      )
    }),
  )

  const byKey = createMemo(() => new Map(entries().map((entry) => [entry.key, entry])))

  // Rewrites stored keys once their panel is present: keys stored before extensions (e.g. "context") or under an
  // extension's earlier id, and ids a panel writes more than one way. Duplicates collapse, so one file stored two ways
  // is one tab.
  createEffect(() => {
    const legacy = legacyKeys(providers())
    const normalizers = providers().flatMap((item) => (item.value.normalize ? [item] : []))

    if (legacy.size === 0 && normalizers.length === 0) return

    const rewrite = (key: string) => {
      const moved = legacy.get(key)

      if (moved) return moved
      const item = normalizers.find((provider) => key.startsWith(`${provider.extension}:`))

      if (!item?.value.normalize) return key

      return panelKey(
        item.extension,
        item.value.normalize(
          panelInput(input.view, input.screen, {
            id: key.slice(item.extension.length + 1),
          }),
        ),
      )
    }

    // remap reads the stored tabs and writes nothing once every key is canonical, so this settles in one rerun.
    input.tabs().remap(rewrite)
  })

  // Transient panels are not restored: their stored keys leave once the panel stops listing them.
  createEffect(() => {
    const listed = new Set(entries().map((entry) => entry.key))
    const transient = providers().flatMap((item) => (item.value.transient ? [`${item.extension}:`] : []))

    if (transient.length === 0) return
    const all = stored()
    const next = all.filter((key) => listed.has(key) || !transient.some((prefix) => key.startsWith(prefix)))

    if (next.length !== all.length) input.tabs().setAll(next)
  })

  const strip = createMemo(() => {
    const listed = stored().flatMap((key) => {
      const entry = byKey().get(key)

      return entry && !entry.tab.pinned ? [entry] : []
    })

    return [
      ...entries().filter((entry) => entry.tab.pinned),
      ...listed.filter((entry) => entry.tab.first),
      ...listed.filter((entry) => !entry.tab.first),
    ]
  })

  // Narrow screens never select a transient tab: a stored one falls back like a missing tab.
  const desktop = createMediaQuery("(min-width: 768px)")

  const active = createMemo(() => {
    const value = input.tabs().active()

    if (value && strip().some((entry) => entry.key === value && (desktop() || !entry.tab.transient))) return value

    const eligible = strip().filter((entry) => entry.tab.fallback && (desktop() || !entry.tab.transient))

    return [
      ...eligible.filter((entry) => !entry.tab.pinned && !entry.tab.first),
      ...eligible.filter((entry) => !entry.tab.pinned && entry.tab.first),
      ...eligible.filter((entry) => entry.tab.pinned),
    ][0]?.key
  })

  // The effect's own value marks its first run: the selection the region mounts with, stored or fallback.
  createEffect(
    on(active, (key, _, restored: boolean = true) => {
      const entry = key ? byKey().get(key) : undefined

      if (entry)
        entry.provider.focus?.(
          panelInput(input.view, input.screen, {
            tab: entry.tab,
            restored,
          }),
        )

      return false
    }),
  )

  // Hidden tabs keep their place in the strip for selection, focus, and close, but draw no trigger.
  const drawn = createMemo(() => strip().filter((entry) => !entry.tab.hidden))

  return {
    entries,
    /** Drawn strip order by key. Renders iterate keys so a provider's fresh tab objects never remount a trigger. */
    keys: createMemo(() => drawn().map((entry) => entry.key), [], { equals: same }),
    /** The strip holds no tab, hidden ones included. */
    empty: createMemo(() => strip().length === 0),
    entry: (key: string) => byKey().get(key),
    active,
    selected: createMemo(() => {
      const key = active()

      return key ? byKey().get(key) : undefined
    }),
    wide: createMemo(() => providers().some((item) => item.value.wide)),
    /** An extension's tab ids in the stored strip. */
    openFor: (extension: string) =>
      stored().flatMap((key) => (key.startsWith(`${extension}:`) ? [key.slice(extension.length + 1)] : [])),
    lead: () => !!drawn().find((entry) => !entry.tab.pinned)?.tab.first,
    select(key: string) {
      input.tabs().setActive(key)
    },
    close(key: string) {
      const entry = byKey().get(key)
      const last = stored().length === 1 && stored()[0] === key
      const reopen = entry?.provider.reopen?.(panelInput(input.view, input.screen, { tab: entry.tab }))

      if (reopen) input.closed.push(input.view().key, reopen)
      batch(() => {
        input.tabs().close(key)

        if (last) input.onEmptied?.()
      })

      if (entry)
        entry.provider.close?.(
          panelInput(input.view, input.screen, {
            tab: entry.tab,
          }),
        )
    },
    reopen: () => input.closed.reopen(input.view().key),
  }
}

export type Region = ReturnType<typeof createRegion>

/** Grouped content stays mounted while any member is listed; other tabs mount only while selected. */
export function RegionContent(props: {
  region: Region
  view: MountedSession
  screen: SessionScreen
  frame: Omit<PanelFrame, "visible" | "open"> & { shown: Accessor<boolean> }
}) {
  const groups = createMemo(() =>
    Array.from(new Set(props.region.entries().flatMap((entry) => (entry.tab.group ? [groupKey(entry)] : [])))),
  )

  const single = createMemo(() => {
    const entry = props.region.selected()

    return entry && !entry.tab.group ? entry.key : undefined
  })

  return (
    <>
      <For each={groups()}>
        {(group) => {
          const active = () => {
            const entry = props.region.selected()

            return !!entry && groupKey(entry) === group
          }

          // The last selected member keeps rendering while the group is hidden.
          const member = createMemo<RegionEntry | undefined>((previous) => {
            const members = props.region.entries().filter((entry) => groupKey(entry) === group)
            const selected = props.region.selected()

            if (selected && groupKey(selected) === group) return selected

            return members.find((entry) => entry.key === previous?.key) ?? members[0]
          })

          return (
            <Show when={member()?.extension} keyed>
              {(extension) => (
                <div
                  id={member()?.tab.dom?.panel}
                  role="tabpanel"
                  aria-labelledby={active() && !member()?.tab.hidden ? member()?.tab.dom?.tab : undefined}
                  data-slot="tabs-content"
                  class="h-full min-h-0 overflow-hidden"
                  classList={{ hidden: !active() }}
                  inert={!active() || undefined}
                >
                  <PanelContext.Provider
                    value={{
                      ...props.frame,
                      visible: () => props.frame.shown() && active(),
                      open: () => props.region.openFor(extension),
                    }}
                  >
                    <Contribution extension={extension}>
                      {() =>
                        member()!.provider.render(
                          panelInput(() => props.view, props.screen, {
                            get tab() {
                              return member()!.tab
                            },
                          }),
                        )
                      }
                    </Contribution>
                  </PanelContext.Provider>
                </div>
              )}
            </Show>
          )
        }}
      </For>
      <Show when={single()} keyed>
        {(key) => {
          const entry = createMemo(() => props.region.entries().find((item) => item.key === key))

          return (
            <Show when={entry()?.extension} keyed>
              {(extension) => (
                <div
                  id={entry()?.tab.dom?.panel}
                  role="tabpanel"
                  aria-labelledby={entry()?.tab.hidden ? undefined : entry()?.tab.dom?.tab}
                  tabIndex={entry()?.tab.tabbable ? 0 : undefined}
                  data-slot="tabs-content"
                  class="flex flex-col h-full overflow-hidden contain-strict"
                >
                  <PanelContext.Provider
                    value={{ ...props.frame, visible: props.frame.shown, open: () => props.region.openFor(extension) }}
                  >
                    <Contribution extension={extension}>
                      {() =>
                        entry()!.provider.render(
                          panelInput(() => props.view, props.screen, {
                            get tab() {
                              return entry()!.tab
                            },
                          }),
                        )
                      }
                    </Contribution>
                  </PanelContext.Provider>
                </div>
              )}
            </Show>
          )
        }}
      </Show>
    </>
  )
}

function groupKey(entry: RegionEntry) {
  return `${entry.extension}/${entry.tab.group ?? entry.key}`
}

/** Keeps session and tab getters live while the owning screen stays constant. Spreading would snapshot getters. */
function panelInput<T extends object>(view: Accessor<MountedSession>, screen: SessionScreen, fields: T) {
  return mergeProps(
    {
      get session() {
        return view()
      },
      screen,
    },
    fields,
  )
}

/** Renders one panel as a narrow-screen view. */
export function MobilePanel(props: {
  entry: RegionEntry
  view: MountedSession
  screen: SessionScreen
  sidebar: PanelSidebar
  visible: boolean
  open: Accessor<readonly string[]>
}): JSX.Element {
  return (
    <PanelContext.Provider
      value={{
        visible: () => props.visible,
        present: () => props.visible,
        placement: () => "mobile",
        reserve: () => false,
        animate: () => true,
        sidebar: props.sidebar,
        open: props.open,
      }}
    >
      <Contribution extension={props.entry.extension}>
        {() =>
          props.entry.provider.render(
            panelInput(() => props.view, props.screen, {
              get tab() {
                return props.entry.tab
              },
            }),
          )
        }
      </Contribution>
    </PanelContext.Provider>
  )
}
