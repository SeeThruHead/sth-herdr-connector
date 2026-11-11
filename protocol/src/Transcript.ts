import { Schema } from "effect"

export const ItemId = Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(120)).pipe(Schema.brand("ItemId"))
export type ItemId = typeof ItemId.Type

export const Said = Schema.TaggedStruct("Said", {
  id: ItemId,
  who: Schema.Literals(["person", "agent"]),
  markdown: Schema.String,
  queued: Schema.optionalKey(Schema.Boolean),
  failed: Schema.optionalKey(Schema.Boolean)
})
export type Said = typeof Said.Type

export const Change = Schema.Struct({
  file: Schema.String,
  added: Schema.Int,
  removed: Schema.Int,
  diff: Schema.String
})
export type Change = typeof Change.Type

export const ToolCall = Schema.TaggedStruct("ToolCall", {
  id: ItemId,
  tool: Schema.String,
  summary: Schema.String,
  detail: Schema.String,
  change: Schema.optionalKey(Change)
})
export type ToolCall = typeof ToolCall.Type

export const ToolResult = Schema.TaggedStruct("ToolResult", {
  id: ItemId,
  call: Schema.String,
  text: Schema.String,
  failed: Schema.Boolean
})
export type ToolResult = typeof ToolResult.Type

export const Picture = Schema.TaggedStruct("Picture", {
  id: ItemId,
  mediaType: Schema.Literals(["image/png", "image/jpeg", "image/gif", "image/webp"]),
  base64: Schema.String
})
export type Picture = typeof Picture.Type

export const Item = Schema.Union([Said, ToolCall, ToolResult, Picture])
export type Item = typeof Item.Type

export const Transcript = Schema.Struct({
  session: Schema.String,
  items: Schema.Array(Item),
  more: Schema.Boolean
})
export type Transcript = typeof Transcript.Type
