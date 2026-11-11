import { Schema } from "effect"

export const AgentStatus = Schema.Literals(["idle", "working", "blocked", "done", "unknown", "errored", "asleep"])
export type AgentStatus = typeof AgentStatus.Type

export const Host = Schema.Literals(["herdr", "herdr-core"])
export type Host = typeof Host.Type

export const SourceName = Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9-]{0,31}$/)).pipe(
  Schema.brand("SourceName")
)
export type SourceName = typeof SourceName.Type

export const Ability = Schema.Literals(["prompt", "keys", "screen"])
export type Ability = typeof Ability.Type

export const SourceState = Schema.Struct({
  name: SourceName,
  version: Schema.String,
  reachable: Schema.Boolean,
  reason: Schema.optionalKey(Schema.String)
})
export type SourceState = typeof SourceState.Type

export const MachineName = Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9-]{0,31}$/)).pipe(
  Schema.brand("MachineName")
)
export type MachineName = typeof MachineName.Type

export const WorkspaceId = Schema.String.check(Schema.isPattern(/^w[A-Za-z0-9]+$/)).pipe(Schema.brand("WorkspaceId"))
export type WorkspaceId = typeof WorkspaceId.Type

export const TabId = Schema.String.check(Schema.isPattern(/^w[A-Za-z0-9]+:t[A-Za-z0-9]+$/)).pipe(Schema.brand("TabId"))
export type TabId = typeof TabId.Type

export const PaneId = Schema.String.check(Schema.isPattern(/^w[A-Za-z0-9]+:p[A-Za-z0-9]+$/)).pipe(
  Schema.brand("PaneId")
)
export type PaneId = typeof PaneId.Type

export const AgentKind = Schema.Literals(["claude", "codex", "pi", "opencode", "gemini", "amp"])
export type AgentKind = typeof AgentKind.Type

export const AgentName = Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9_-]{0,31}$/)).pipe(
  Schema.brand("AgentName")
)
export type AgentName = typeof AgentName.Type

export const Directory = Schema.String.check(Schema.isPattern(/^[~/]/), Schema.isMaxLength(1024)).pipe(
  Schema.brand("Directory")
)
export type Directory = typeof Directory.Type

export const Key = Schema.Literals([
  "enter",
  "esc",
  "tab",
  "shift+tab",
  "up",
  "down",
  "left",
  "right",
  "backspace",
  "space",
  "ctrl+c",
  "ctrl+d",
  "1",
  "2",
  "3",
  "4",
  "5",
  "y",
  "n"
])
export type Key = typeof Key.Type

export const PromptText = Schema.String.check(
  Schema.isNonEmpty({ message: "Write something to send" }),
  Schema.isMaxLength(20_000, { message: "Keep a prompt under 20,000 characters" })
)

export const TypedText = Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(4096))
export type TypedText = typeof TypedText.Type

export const Workspace = Schema.Struct({
  id: WorkspaceId,
  label: Schema.String,
  number: Schema.Int,
  status: AgentStatus,
  source: Schema.optionalKey(SourceName)
})
export type Workspace = typeof Workspace.Type

export const Tab = Schema.Struct({
  id: TabId,
  workspace: WorkspaceId,
  label: Schema.String,
  number: Schema.Int,
  status: AgentStatus
})
export type Tab = typeof Tab.Type

export const Pane = Schema.Struct({
  id: PaneId,
  workspace: WorkspaceId,
  tab: TabId,
  agent: Schema.Option(Schema.String),
  name: Schema.Option(Schema.String),
  status: AgentStatus,
  cwd: Schema.String,
  title: Schema.Option(Schema.String),
  session: Schema.Option(Schema.String),
  source: Schema.optionalKey(SourceName),
  abilities: Schema.optionalKey(Schema.Array(Ability)),
  failure: Schema.optionalKey(Schema.String),
  active: Schema.optionalKey(Schema.Finite)
})
export type Pane = typeof Pane.Type

export const Snapshot = Schema.Struct({
  herdrVersion: Schema.String,
  workspaces: Schema.Array(Workspace),
  tabs: Schema.Array(Tab),
  panes: Schema.Array(Pane),
  sources: Schema.optionalKey(Schema.Array(SourceState))
})
export type Snapshot = typeof Snapshot.Type

export const emptySnapshot: Snapshot = { herdrVersion: "", workspaces: [], tabs: [], panes: [] }
