import { Array as Arr, Option, Schema } from "effect"
import { partsOfMessages } from "./Claude.ts"
import type { Part } from "./Claude.ts"

const Entry = Schema.Struct({
  type: Schema.String,
  id: Schema.String,
  parentId: Schema.optionalKey(Schema.NullOr(Schema.String)),
  message: Schema.optionalKey(Schema.Unknown)
})
type Entry = typeof Entry.Type

const Message = Schema.Struct({
  role: Schema.String,
  content: Schema.optionalKey(Schema.Union([Schema.String, Schema.Array(Schema.Unknown)])),
  toolCallId: Schema.optionalKey(Schema.NullOr(Schema.String)),
  isError: Schema.optionalKey(Schema.NullOr(Schema.Boolean)),
  stopReason: Schema.optionalKey(Schema.NullOr(Schema.String)),
  errorMessage: Schema.optionalKey(Schema.NullOr(Schema.String))
})
type Message = typeof Message.Type

const TextBlock = Schema.Struct({ type: Schema.Literal("text"), text: Schema.String })

const ToolCallBlock = Schema.Struct({
  type: Schema.Literal("toolCall"),
  id: Schema.String,
  name: Schema.String,
  arguments: Schema.Record(Schema.String, Schema.Unknown)
})

const ImageBlock = Schema.Struct({ type: Schema.Literal("image"), data: Schema.String, mimeType: Schema.String })

const Block = Schema.Union([TextBlock, ToolCallBlock, ImageBlock])
type Block = typeof Block.Type

const decodeEntry = Schema.decodeUnknownOption(Schema.fromJsonString(Entry))
const decodeMessage = Schema.decodeUnknownOption(Message)
const decodeBlock = Schema.decodeUnknownOption(Block)

export const callId = (id: string): string => id.slice(0, 120)

const claudeBlock = (block: Block): unknown => {
  if (block.type === "text") return block
  if (block.type === "image")
    return { type: "image", source: { type: "base64", media_type: block.mimeType, data: block.data } }

  return { type: "tool_use", id: callId(block.id), name: block.name, input: block.arguments }
}

const blocksOf = (content: Message["content"]): ReadonlyArray<unknown> => {
  if (content === undefined) return []
  if (typeof content === "string") return [{ type: "text", text: content }]

  return Arr.getSomes(content.map((block) => decodeBlock(block))).map(claudeBlock)
}

const resultOf = (id: string, message: Message): unknown => ({
  type: "user",
  uuid: id,
  message: {
    content: [
      {
        type: "tool_result",
        tool_use_id: callId(message.toolCallId ?? ""),
        content: blocksOf(message.content),
        is_error: message.isError ?? false
      }
    ]
  }
})

const errorText = (text: string | null | undefined): string =>
  text === undefined || text === null || text === "" ? "" : `Error: ${text}`

const failedTurn = (id: string, message: Message): ReadonlyArray<unknown> => {
  if (message.stopReason === "error") return [failureLine(id, errorText(message.errorMessage))]
  if (message.stopReason !== "aborted") return []

  return [failureLine(id, message.errorMessage ?? "Interrupted")]
}

const failureLine = (id: string, text: string): unknown => ({
  type: "assistant",
  uuid: `${id}-failed`,
  isApiErrorMessage: true,
  message: { content: [{ type: "text", text }] }
})

const lineOf = (entry: Entry): ReadonlyArray<unknown> => {
  if (entry.type !== "message") return []
  const message = decodeMessage(entry.message)
  if (Option.isNone(message)) return []
  const role = message.value.role
  if (role === "toolResult") return [resultOf(entry.id, message.value)]
  if (role !== "user" && role !== "assistant") return []

  return [
    { type: role, uuid: entry.id, message: { content: blocksOf(message.value.content) } },
    ...failedTurn(entry.id, message.value)
  ]
}

const branchOf = (entries: ReadonlyArray<Entry>): ReadonlyArray<Entry> => {
  const byId = new Map(entries.map((entry) => [entry.id, entry]))
  const parentOf = (entry: Entry): Option.Option<Entry> =>
    Option.flatMap(Option.fromNullishOr(entry.parentId), (parent) => Option.fromNullishOr(byId.get(parent)))
  const walked = Arr.unfold({ at: Arr.last(entries), left: entries.length }, ({ at, left }) =>
    left === 0 ? Option.none() : Option.map(at, (entry) => [entry, { at: parentOf(entry), left: left - 1 }] as const)
  )

  return Arr.reverse(walked)
}

export const partsOf = (text: string): ReadonlyArray<Part> =>
  partsOfMessages(branchOf(Arr.getSomes(text.split("\n").map((line) => decodeEntry(line)))).flatMap(lineOf))
