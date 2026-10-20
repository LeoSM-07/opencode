import type { ResolvedTheme } from "@opencode/theme/tui"
import { Option, Schema } from "effect"
import { Author } from "./protocol.js"

const decode = Schema.decodeUnknownOption(Author)
export const readAuthor = (value: unknown) => Option.getOrUndefined(decode(value))
export const authorColor = (author: Author, theme: ResolvedTheme) =>
  theme.categorical[author.color % theme.categorical.length][200]

export function AuthorLabel(props: { author: Author; theme: ResolvedTheme }) {
  return (
    <text fg={authorColor(props.author, props.theme)}>
      {props.author.name}
      {props.author.role === "host" ? " (host)" : ""}
    </text>
  )
}
