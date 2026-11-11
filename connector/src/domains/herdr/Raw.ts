import { Option, Schema, SchemaGetter } from "effect"
import { AgentStatus, PaneId, TabId, WorkspaceId } from "@sth-herdr/protocol/Herdr.ts"
import type { Pane, Snapshot } from "@sth-herdr/protocol/Herdr.ts"

const Text = Schema.optionalKey(Schema.NullOr(Schema.String))

const isStatus = Schema.is(AgentStatus)

const Status = Schema.String.pipe(
  Schema.decodeTo(AgentStatus, {
    decode: SchemaGetter.transform((text: string) => (isStatus(text) ? text : "unknown")),
    encode: SchemaGetter.transform((status: AgentStatus) => status)
  })
)

const RawWorkspace = Schema.Struct({
  workspace_id: WorkspaceId,
  label: Schema.String,
  number: Schema.Int,
  agent_status: Status
})

const RawTab = Schema.Struct({
  tab_id: TabId,
  workspace_id: WorkspaceId,
  label: Schema.String,
  number: Schema.Int,
  agent_status: Status
})

const RawPane = Schema.Struct({
  pane_id: PaneId,
  workspace_id: WorkspaceId,
  tab_id: TabId,
  agent: Text,
  agent_status: Status,
  cwd: Text,
  foreground_cwd: Text,
  label: Text,
  terminal_title_stripped: Text,
  agent_session: Schema.optionalKey(Schema.NullOr(Schema.Struct({ kind: Schema.String, value: Schema.String })))
})
type RawPane = typeof RawPane.Type

const RawAgent = Schema.Struct({ pane_id: PaneId, name: Text })
type RawAgent = typeof RawAgent.Type

export const RawSnapshot = Schema.Struct({
  result: Schema.Struct({
    snapshot: Schema.Struct({
      version: Schema.String,
      workspaces: Schema.Array(RawWorkspace),
      tabs: Schema.Array(RawTab),
      panes: Schema.Array(RawPane),
      agents: Schema.Array(RawAgent)
    })
  })
})
export type RawSnapshot = typeof RawSnapshot.Type

const present = (value: string | null | undefined): Option.Option<string> =>
  Option.filter(Option.fromNullishOr(value), (text) => text.trim() !== "")

const nameOf = (agents: ReadonlyArray<RawAgent>, pane: RawPane): Option.Option<string> =>
  Option.flatMap(Option.fromNullishOr(agents.find((agent) => agent.pane_id === pane.pane_id)), (agent) =>
    present(agent.name)
  )

const sessionKinds: ReadonlySet<string> = new Set(["id", "path"])

const paneOf =
  (agents: ReadonlyArray<RawAgent>) =>
  (pane: RawPane): Pane => ({
    id: pane.pane_id,
    workspace: pane.workspace_id,
    tab: pane.tab_id,
    agent: present(pane.agent),
    name: Option.orElse(nameOf(agents, pane), () => present(pane.label)),
    status: pane.agent_status,
    cwd: Option.getOrElse(
      Option.orElse(present(pane.foreground_cwd), () => present(pane.cwd)),
      () => ""
    ),
    title: present(pane.terminal_title_stripped),
    session: Option.flatMap(
      Option.filter(Option.fromNullishOr(pane.agent_session), (session) => sessionKinds.has(session.kind)),
      (session) => present(session.value)
    )
  })

export const snapshotOf = (raw: RawSnapshot): Snapshot => {
  const found = raw.result.snapshot

  return {
    herdrVersion: found.version,
    workspaces: found.workspaces.map((workspace) => ({
      id: workspace.workspace_id,
      label: workspace.label,
      number: workspace.number,
      status: workspace.agent_status
    })),
    tabs: found.tabs.map((tab) => ({
      id: tab.tab_id,
      workspace: tab.workspace_id,
      label: tab.label,
      number: tab.number,
      status: tab.agent_status
    })),
    panes: found.panes.map(paneOf(found.agents))
  }
}

export const CreatedPane = Schema.Struct({
  result: Schema.Struct({ root_pane: Schema.Struct({ pane_id: PaneId }) })
})

export const HerdrError = Schema.Struct({ error: Schema.Struct({ code: Schema.String, message: Schema.String }) })
