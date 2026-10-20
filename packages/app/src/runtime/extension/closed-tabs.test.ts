import { expect, test } from "bun:test"
import { createClosedTabs } from "./closed-tabs"

test("reopens a session's closed side tabs newest first, once each, up to the limit", () => {
  const closed = createClosedTabs(2)
  const reopened: string[] = []

  for (const tab of ["a1", "b1", "a2", "a3"]) closed.push(tab[0]!, () => reopened.push(tab))

  for (const session of ["a", "a", "a", "b", "b"]) closed.reopen(session)

  expect(reopened).toEqual(["a3", "a2"])
})
