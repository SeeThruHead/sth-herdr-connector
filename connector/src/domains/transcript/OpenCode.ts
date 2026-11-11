import { Array as Arr, Option, Schema } from "effect"
import { partsOfMessages } from "./Claude.ts"
import type { Part } from "./Claude.ts"
import { callId } from "./Pi.ts"

export type Row = { readonly id: string; readonly type: string; readonly data: string }

const Asked = Schema.Struct({ text: Schema.optionalKey(Schema.NullOr(Schema.String)) })

const TextBlock = Schema.Struct({ type: Schema.Literal("text"), text: Schema.String })

const ToolBlock = Schema.Struct({
  type: Schema.Literal("tool"),
  id: Schema.String,
  name: Schema.String,
  state: Schema.Struct({
    status: Schema.String,
    input: Schema.optionalKey(Schema.NullOr(Schema.Record(Schema.String, Schema.Unknown))),
    content: Schema.optionalKey(Schema.NullOr(Schema.Array(Schema.Unknown))),
    output: Schema.optionalKey(Schema.NullOr(Schema.String)),
    error: Schema.optionalKey(Schema.NullOr(Schema.String))
  })
})
type ToolBlock = typeof ToolBlock.Type

const Block = Schema.Union([TextBlock, ToolBlock])
type Block = typeof Block.Type

const Answered = Schema.Struct({ content: Schema.optionalKey(Schema.NullOr(Schema.Array(Schema.Unknown))) })

const Idle = Schema.Struct({
  outcome: Schema.optionalKey(Schema.NullOr(Schema.String)),
  error: Schema.optionalKey(
    Schema.NullOr(
      Schema.Struct({
        type: Schema.optionalKey(Schema.NullOr(Schema.String)),
        message: Schema.optionalKey(Schema.NullOr(Schema.String))
      })
    )
  )
})
type Idle = typeof Idle.Type

const decodeIdle = Schema.decodeUnknownOption(Schema.fromJsonString(Idle))

const failureText = (idle: Idle): string => {
  const message = idle.error?.message ?? ""
  if (message !== "") return `Error: ${message}`
  if (idle.outcome === "interrupted") return "Interrupted"

  return ""
}

const failedTurn = (row: Row): ReadonlyArray<unknown> =>
  Option.toArray(
    decodeIdle(row.data).pipe(
      Option.filter((idle) => idle.outcome === "failed" || idle.outcome === "interrupted"),
      Option.map((idle) => ({
        type: "assistant",
        uuid: row.id,
        isApiErrorMessage: true,
        message: { content: [{ type: "text", text: failureText(idle) }] }
      }))
    )
  )

const decodeAsked = Schema.decodeUnknownOption(Schema.fromJsonString(Asked))
const decodeAnswered = Schema.decodeUnknownOption(Schema.fromJsonString(Answered))
const decodeBlock = Schema.decodeUnknownOption(Block)
const decodeText = Schema.decodeUnknownOption(TextBlock)

const finished = (status: string): boolean => status === "completed" || status === "error"

const resultText = (tool: ToolBlock): string => {
  const said = Arr.getSomes((tool.state.content ?? []).map((part) => decodeText(part))).map((part) => part.text)
  if (said.join("") !== "") return said.join("\n")
  if (tool.state.status === "error") return tool.state.error ?? "The tool failed."

  return tool.state.output ?? ""
}

const claudeBlocks = (block: Block): ReadonlyArray<unknown> => {
  if (block.type === "text") return [block]
  const call = { type: "tool_use", id: callId(block.id), name: block.name, input: block.state.input ?? {} }
  if (!finished(block.state.status)) return [call]

  return [
    call,
    {
      type: "tool_result",
      tool_use_id: callId(block.id),
      content: resultText(block),
      is_error: block.state.status === "error"
    }
  ]
}

const lineOf = (row: Row): ReadonlyArray<unknown> => {
  if (row.type === "user")
    return Option.toArray(
      Option.map(decodeAsked(row.data), (asked) => ({
        type: "user",
        uuid: row.id,
        message: { content: asked.text ?? "" }
      }))
    )
  if (row.type === "idle") return failedTurn(row)
  if (row.type !== "assistant") return []

  return Option.toArray(
    Option.map(decodeAnswered(row.data), (answered) => ({
      type: "assistant",
      uuid: row.id,
      message: {
        content: Arr.getSomes((answered.content ?? []).map((block) => decodeBlock(block))).flatMap(claudeBlocks)
      }
    }))
  )
}

export const partsOf = (rows: ReadonlyArray<Row>): ReadonlyArray<Part> => partsOfMessages(rows.flatMap(lineOf))
