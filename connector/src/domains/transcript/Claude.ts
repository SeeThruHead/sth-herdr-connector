import { Array as Arr, Option, Schema } from "effect"
import { changeOf } from "./Change.ts"
import { ItemId, Picture } from "@sth-herdr/protocol/Transcript.ts"
import type { Item } from "@sth-herdr/protocol/Transcript.ts"

const MediaType = Picture.fields.mediaType

const TextBlock = Schema.Struct({ type: Schema.Literal("text"), text: Schema.String })

const ImageBlock = Schema.Struct({
  type: Schema.Literal("image"),
  source: Schema.Struct({ type: Schema.Literal("base64"), media_type: MediaType, data: Schema.String })
})

const ToolUseBlock = Schema.Struct({
  type: Schema.Literal("tool_use"),
  id: Schema.String,
  name: Schema.String,
  input: Schema.Record(Schema.String, Schema.Unknown)
})

const ToolResultBlock = Schema.Struct({
  type: Schema.Literal("tool_result"),
  tool_use_id: Schema.String,
  content: Schema.optionalKey(Schema.Union([Schema.String, Schema.Array(Schema.Unknown)])),
  is_error: Schema.optionalKey(Schema.NullOr(Schema.Boolean))
})

const Block = Schema.Union([TextBlock, ImageBlock, ToolUseBlock, ToolResultBlock])
type Block = typeof Block.Type

const Line = Schema.Struct({
  type: Schema.Literals(["user", "assistant"]),
  uuid: Schema.String,
  isMeta: Schema.optionalKey(Schema.NullOr(Schema.Boolean)),
  isCompactSummary: Schema.optionalKey(Schema.NullOr(Schema.Boolean)),
  isApiErrorMessage: Schema.optionalKey(Schema.NullOr(Schema.Boolean)),
  message: Schema.Struct({ content: Schema.Union([Schema.String, Schema.Array(Schema.Unknown)]) })
})
type Line = typeof Line.Type

const Queued = Schema.Struct({
  type: Schema.Literal("attachment"),
  uuid: Schema.String,
  attachment: Schema.Struct({
    type: Schema.Literal("queued_command"),
    prompt: Schema.Union([Schema.String, Schema.Array(Schema.Unknown)])
  })
})
type Queued = typeof Queued.Type

const Local = Schema.Struct({
  type: Schema.Literal("system"),
  subtype: Schema.Literal("local_command"),
  uuid: Schema.String,
  content: Schema.String
})
type Local = typeof Local.Type

const decodeLine = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Union([Line, Queued, Local])))
const decodeBlock = Schema.decodeUnknownOption(Block)

export const pictureLimit = 3_000_000
const resultLimit = 4000
const detailLimit = 2000

const clip = (text: string, limit: number): string => (text.length > limit ? `${text.slice(0, limit)}\n…` : text)

const pasted = /<pasted_content id="[^"]*">\n?([\s\S]*?)\n?<\/pasted_content id="[^"]*">/g

const hidden = /<(system-reminder|task-notification)>[\s\S]*?<\/\1>/g

const cleaned = (text: string): string => text.replace(pasted, "$1").replace(hidden, "").trim()

const quiet = (text: string): boolean => {
  if (text === "") return true

  return /^<(local-command-caveat|command-message|command-args|bash-input|bash-stdout|bash-stderr)/.test(text)
}

const summaryKeys = ["description", "command", "file_path", "path", "pattern", "url", "prompt", "query", "code"]

export const summaryOf = (input: Readonly<Record<string, unknown>>): string =>
  Option.getOrElse(
    Arr.findFirst(summaryKeys, (key) => typeof input[key] === "string" && input[key] !== "").pipe(
      Option.map((key) => String(input[key]).split("\n", 1).join(""))
    ),
    () => ""
  )

const blocksOf = (content: ReadonlyArray<unknown>): ReadonlyArray<Block> =>
  Arr.getSomes(content.map((block) => decodeBlock(block)))

const pictureOf = (id: string, block: typeof ImageBlock.Type): Item =>
  block.source.data.length > pictureLimit
    ? { _tag: "Said", id: ItemId.make(id), who: "agent", markdown: "_An image too large to show here._" }
    : { _tag: "Picture", id: ItemId.make(id), mediaType: block.source.media_type, base64: block.source.data }

const resultItems = (id: string, block: typeof ToolResultBlock.Type): ReadonlyArray<Item> => {
  const content = block.content ?? ""
  const inner = typeof content === "string" ? [] : blocksOf(content)
  const text =
    typeof content === "string"
      ? content
      : inner.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n")
  const pictures = inner.flatMap((part, index) => (part.type === "image" ? [pictureOf(`${id}-p${index}`, part)] : []))
  const result: Item = {
    _tag: "ToolResult",
    id: ItemId.make(id),
    call: block.tool_use_id,
    text: clip(text, resultLimit),
    failed: block.is_error === true
  }

  return [result, ...pictures]
}

const attached = /^\[Attached: (.+)\]$/gm

const pathOf = (line: string): string => line.slice("[Attached: ".length, -1)

const fileName = (path: string): string => path.replace(/^.*\//, "").replace(/^\d+-\d+-/, "")

export type Attached = {
  readonly _tag: "Attached"
  readonly id: ItemId
  readonly who: "person" | "agent"
  readonly path: string
  readonly name: string
}

export type Part = Item | Attached

const commandName = /<command-name>([\s\S]*?)<\/command-name>/g

const commandArgs = /<command-args>([\s\S]*?)<\/command-args>/g

const commandOutput = /<local-command-std(?:out|err)>([\s\S]*?)<\/local-command-std(?:out|err)>/g

const inside = (text: string, tag: RegExp): string =>
  Array.from(text.matchAll(tag), (match) => match.slice(1).join("")).join("\n")

const ansi = new RegExp(`${String.fromCodePoint(27)}\\[[0-9;]*[A-Za-z]`, "g")

const typed = (text: string): string => `${inside(text, commandName)} ${inside(text, commandArgs)}`.trim()

const printed = (text: string): string => {
  const output = inside(text, commandOutput).replace(ansi, "").trim()

  return output === "" ? "" : `\`\`\`\n${output}\n\`\`\``
}

const command = (id: string, text: string): ReadonlyArray<Part> => {
  if (text.startsWith("<command-name>"))
    return [{ _tag: "Said", id: ItemId.make(id), who: "person", markdown: typed(text) }]
  const output = printed(text)

  return output === "" ? [] : [{ _tag: "Said", id: ItemId.make(id), who: "agent", markdown: output }]
}

const commandLike = (text: string): boolean => /^<(command-name|local-command-std)/.test(text)

const interrupted = /^\[Request interrupted by user[^\]]*\]$/

export const failure = (id: string, text: string): Item => ({
  _tag: "Said",
  id: ItemId.make(id),
  who: "agent",
  markdown: text === "" ? "The turn failed." : text,
  failed: true
})

const textOf = (content: Line["message"]["content"]): string =>
  typeof content === "string"
    ? content
    : blocksOf(content)
        .flatMap((block) => (block.type === "text" ? [block.text] : []))
        .join("\n")

const said = (id: string, line: Line, raw: string): ReadonlyArray<Part> => {
  const who = line.type === "user" ? "person" : "agent"
  const markdown = cleaned(raw)
  if (commandLike(markdown)) return command(id, markdown)
  if (interrupted.test(markdown)) return [failure(id, "Interrupted")]
  const files = Array.from(markdown.matchAll(attached), (match, index): Attached => ({
    _tag: "Attached",
    id: ItemId.make(`${id}-f${index}`),
    who,
    path: pathOf(match[0]),
    name: fileName(pathOf(match[0]))
  }))
  const text = markdown.replace(attached, "").trim()

  return quiet(text) ? files : [...files, { _tag: "Said", id: ItemId.make(id), who, markdown: text }]
}

export const noteOf = (part: Part): Item =>
  part._tag === "Attached" ? { _tag: "Said", id: part.id, who: part.who, markdown: `📎 ${part.name}` } : part

const itemsOfBlock = (line: Line, block: Block, index: number): ReadonlyArray<Part> => {
  const id = `${line.uuid}-${index}`
  if (block.type === "image") return [pictureOf(id, block)]
  if (block.type === "tool_result") return resultItems(id, block)
  if (block.type === "tool_use")
    return [
      {
        _tag: "ToolCall",
        id: ItemId.make(block.id),
        tool: block.name,
        summary: summaryOf(block.input),
        detail: clip(JSON.stringify(block.input, null, 2), detailLimit),
        ...Option.match(changeOf(block.name, block.input), { onNone: () => ({}), onSome: (change) => ({ change }) })
      }
    ]

  return said(id, line, block.text)
}

const asked = (line: Queued): Line => ({
  type: "user",
  uuid: line.uuid,
  message: { content: line.attachment.prompt }
})

const queued = (part: Part): Part => (part._tag === "Said" ? { ...part, queued: true } : part)

const itemsOfLine = (line: Line): ReadonlyArray<Part> => {
  if (line.isMeta === true) return []
  if (line.isCompactSummary === true) return []
  if (line.isApiErrorMessage === true) return [failure(line.uuid, cleaned(textOf(line.message.content)))]
  const content = line.message.content
  if (typeof content !== "string") return blocksOf(content).flatMap((block, index) => itemsOfBlock(line, block, index))

  return said(line.uuid, line, content)
}

const partsOfLine = (line: Line | Queued | Local): ReadonlyArray<Part> => {
  if (line.type === "system") return command(line.uuid, cleaned(line.content))
  if (line.type === "attachment") return itemsOfLine(asked(line)).map(queued)

  return itemsOfLine(line)
}

export const partsOf = (text: string): ReadonlyArray<Part> =>
  Arr.getSomes(text.split("\n").map((line) => decodeLine(line))).flatMap((line) => partsOfLine(line))

const decodeMessage = Schema.decodeUnknownOption(Line)

export const partsOfMessages = (lines: ReadonlyArray<unknown>): ReadonlyArray<Part> =>
  Arr.getSomes(lines.map((line) => decodeMessage(line))).flatMap((line) => itemsOfLine(line))

export const itemsOf = (text: string): ReadonlyArray<Item> => partsOf(text).map(noteOf)
