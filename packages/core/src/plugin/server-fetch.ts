export * as ServerFetch from "./server-fetch.js"

import { Context, Effect, Layer } from "effect"
import { makeGlobalNode } from "@opencode/util/effect/app-node"

export interface Interface {
  readonly fetch: (request: Request) => Effect.Effect<Response, unknown>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/ServerFetch") {}

export const layer = Layer.succeed(
  Service,
  Service.of({
    fetch: () => Effect.fail(new Error("Host HTTP access is unavailable in this runtime")),
  }),
)
export const node = makeGlobalNode({ service: Service, layer, deps: [] })
