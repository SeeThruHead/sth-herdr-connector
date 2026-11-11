import { Context, Schema } from "effect"
import { Rpc, RpcGroup, RpcMiddleware } from "effect/rpc"
import {
  AgentKind,
  AgentName,
  Directory,
  Key,
  MachineName,
  PaneId,
  PromptText,
  Snapshot,
  SourceName,
  TypedText,
  WorkspaceId
} from "./Herdr.ts"
import { Transcript } from "./Transcript.ts"

export const CommandId = Schema.String.check(Schema.isUUID(7)).pipe(Schema.brand("CommandId"))
export type CommandId = typeof CommandId.Type

export const PaneFormat = Schema.Literals(["text", "ansi"])
export type PaneFormat = typeof PaneFormat.Type

export const ReadPane = Schema.TaggedStruct("ReadPane", {
  id: CommandId,
  pane: PaneId,
  lines: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 5000 })),
  format: Schema.optionalKey(PaneFormat)
})

export const UploadName = Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(200))

export const UploadData = Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(12_000_000))

export const Upload = Schema.Struct({ name: UploadName, base64: UploadData })
export type Upload = typeof Upload.Type

export const Uploads = Schema.Array(Upload).check(Schema.isMaxLength(4))

export const Prompt = Schema.TaggedStruct("Prompt", {
  id: CommandId,
  pane: PaneId,
  text: PromptText,
  files: Schema.optionalKey(Uploads)
})

export const SendKeys = Schema.TaggedStruct("SendKeys", {
  id: CommandId,
  pane: PaneId,
  keys: Schema.NonEmptyArray(Key)
})

export const SendText = Schema.TaggedStruct("SendText", { id: CommandId, pane: PaneId, text: TypedText })

export const ReadTranscript = Schema.TaggedStruct("ReadTranscript", {
  id: CommandId,
  pane: PaneId,
  limit: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 400 }))
})

export const StartAgent = Schema.TaggedStruct("StartAgent", {
  id: CommandId,
  workspace: Schema.Option(WorkspaceId),
  cwd: Directory,
  kind: AgentKind,
  name: AgentName,
  source: Schema.optionalKey(SourceName)
})

export const ScreenId = Schema.String.check(Schema.isUUID(7)).pipe(Schema.brand("ScreenId"))
export type ScreenId = typeof ScreenId.Type

export const ScreenSize = {
  cols: Schema.Int.check(Schema.isBetween({ minimum: 20, maximum: 500 })),
  rows: Schema.Int.check(Schema.isBetween({ minimum: 5, maximum: 300 }))
}

export const ScreenData = Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(65_536))

export const OpenScreen = Schema.TaggedStruct("OpenScreen", { id: CommandId, screen: ScreenId, ...ScreenSize })

export const ScreenInput = Schema.TaggedStruct("ScreenInput", { id: CommandId, screen: ScreenId, data: ScreenData })

export const ResizeScreen = Schema.TaggedStruct("ResizeScreen", { id: CommandId, screen: ScreenId, ...ScreenSize })

export const CloseScreen = Schema.TaggedStruct("CloseScreen", { id: CommandId, screen: ScreenId })

export const ListCommands = Schema.TaggedStruct("ListCommands", { id: CommandId, pane: PaneId })

export const SlashCommand = Schema.Struct({ name: Schema.String, description: Schema.String })
export type SlashCommand = typeof SlashCommand.Type

export const HubCommand = Schema.Union([
  ReadPane,
  Prompt,
  SendKeys,
  SendText,
  StartAgent,
  ReadTranscript,
  OpenScreen,
  ScreenInput,
  ResizeScreen,
  CloseScreen,
  ListCommands
])
export type HubCommand = typeof HubCommand.Type

export const PaneText = Schema.TaggedStruct("PaneText", { text: Schema.String })
export const Done = Schema.TaggedStruct("Done", {})
export const Started = Schema.TaggedStruct("Started", { pane: PaneId })
export const Refused = Schema.TaggedStruct("Refused", { reason: Schema.String })

export const TranscriptRead = Schema.TaggedStruct("TranscriptRead", { transcript: Transcript })

export const CommandsListed = Schema.TaggedStruct("CommandsListed", { commands: Schema.Array(SlashCommand) })

export const Outcome = Schema.Union([PaneText, Done, Started, Refused, TranscriptRead, CommandsListed])
export type Outcome = typeof Outcome.Type

export class ConnectorRefused extends Schema.TaggedError<ConnectorRefused, { readonly brand: unique symbol }>()(
  "ConnectorRefused",
  { reason: Schema.String }
) {}

export class ConnectedMachine extends Context.Service<ConnectedMachine, { readonly name: MachineName }>()(
  "sth-herdr/protocol/Connector/ConnectedMachine"
) {}

export class ConnectorAuth extends RpcMiddleware.Service<ConnectorAuth, { provides: ConnectedMachine }>()(
  "sth-herdr/protocol/Connector/ConnectorAuth",
  { error: ConnectorRefused }
) {}

export const Revision = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/)).pipe(Schema.brand("Revision"))
export type Revision = typeof Revision.Type

export const ConnectorBundle = Schema.Struct({ revision: Revision, source: Schema.String })
export type ConnectorBundle = typeof ConnectorBundle.Type

export const Attach = Rpc.make("Attach", {
  payload: Schema.Struct({
    connectorVersion: Schema.String,
    snapshot: Snapshot,
    revision: Schema.optionalKey(Revision)
  }),
  success: HubCommand,
  stream: true
})

export const Report = Rpc.make("Report", { payload: Schema.Struct({ snapshot: Snapshot }) })

export const Answer = Rpc.make("Answer", { payload: Schema.Struct({ id: CommandId, outcome: Outcome }) })

export const ScreenOutput = Rpc.make("ScreenOutput", {
  payload: Schema.Struct({ screen: ScreenId, data: Schema.String, closed: Schema.Boolean })
})

export const Probe = Rpc.make("Probe", {})

export const LatestConnector = Rpc.make("LatestConnector", { success: Schema.Option(Revision) })

export const DownloadConnector = Rpc.make("DownloadConnector", { success: ConnectorBundle, error: ConnectorRefused })

export const ConnectorRpcs = RpcGroup.make(
  Attach,
  Report,
  Answer,
  ScreenOutput,
  Probe,
  LatestConnector,
  DownloadConnector
).middleware(ConnectorAuth)

export const connectorPath = "/connector"
