import { Array as Arr, Option, Order, Schema } from "effect"
import { PaneId, TabId, WorkspaceId } from "@sth-herdr/protocol/Herdr.ts"
import type { AgentStatus, Pane, Snapshot } from "@sth-herdr/protocol/Herdr.ts"
import type { Proc, Table } from "./Processes.ts"
import { ancestorsOf, commandOf, isInside, tableOf } from "./Processes.ts"

export const plainKinds = ["claude", "pi", "opencode", "codex"] as const
export type PlainKind = (typeof plainKinds)[number]

export const isPlainKind = (name: string): name is PlainKind => plainKinds.some((kind) => kind === name)

export const multiplexerProcesses: Readonly<Record<string, ReadonlyArray<string>>> = {
  herdr: ["herdr"],
  "herdr-core": ["hc", "herdr-core"]
}

export const insideOf = (sources: ReadonlyArray<string>): ReadonlySet<string> =>
  new Set(sources.flatMap((name) => multiplexerProcesses[name] ?? []))

const kindLabels: Readonly<Record<PlainKind, string>> = {
  claude: "Claude Code",
  pi: "Pi",
  opencode: "OpenCode",
  codex: "Codex"
}

const commandKinds: Readonly<Record<string, PlainKind>> = {
  claude: "claude",
  pi: "pi",
  opencode: "opencode",
  "opencode.exe": "opencode",
  codex: "codex"
}

export const kindOf = (proc: Proc): Option.Option<PlainKind> => Option.fromNullishOr(commandKinds[commandOf(proc)])

export type Found = {
  readonly pid: number
  readonly cwd: string
  readonly session: Option.Option<string>
  readonly name: Option.Option<string>
  readonly status: AgentStatus
}

const isOwnChild = (table: Table, proc: Proc, kind: PlainKind): boolean =>
  ancestorsOf(table, proc).some((ancestor) => Option.contains(kindOf(ancestor), kind))

export const agentProcesses = (
  procs: ReadonlyArray<Proc>,
  kind: PlainKind,
  inside: ReadonlySet<string>
): ReadonlyArray<Proc> => {
  const table = tableOf(procs)
  const isAgent = (proc: Proc): boolean => {
    if (!Option.contains(kindOf(proc), kind)) return false
    if (isOwnChild(table, proc, kind)) return false

    return !isInside(table, proc, inside)
  }

  return procs.filter(isAgent)
}

export const paneOf = (kind: PlainKind, agent: Found): Pane => ({
  id: PaneId.make(`w${kind}:p${agent.pid}`),
  workspace: WorkspaceId.make(`w${kind}`),
  tab: TabId.make(`w${kind}:t${kind}`),
  agent: Option.some(kind),
  name: agent.name,
  status: agent.status,
  cwd: agent.cwd,
  title: Option.none(),
  session: agent.session
})

const shownFirst: ReadonlyArray<AgentStatus> = ["blocked", "done", "working", "idle"]

const statusOf = (panes: ReadonlyArray<Pane>): AgentStatus =>
  shownFirst.find((status) => panes.some((pane) => pane.status === status)) ?? "unknown"

export const plainSnapshotOf = (kind: PlainKind, found: ReadonlyArray<Found>): Snapshot => {
  if (found.length === 0) return { herdrVersion: "", workspaces: [], tabs: [], panes: [] }
  const panes = found.map((agent) => paneOf(kind, agent))
  const status = statusOf(panes)
  const label = kindLabels[kind]
  const workspace = WorkspaceId.make(`w${kind}`)

  return {
    herdrVersion: "",
    workspaces: [{ id: workspace, label, number: 0, status }],
    tabs: [{ id: TabId.make(`w${kind}:t${kind}`), workspace, label, number: 0, status }],
    panes
  }
}

const ClaudeProcess = Schema.Struct({
  pid: Schema.Int,
  sessionId: Schema.String,
  cwd: Schema.String,
  kind: Schema.optionalKey(Schema.NullOr(Schema.String)),
  status: Schema.optionalKey(Schema.NullOr(Schema.String)),
  name: Schema.optionalKey(Schema.NullOr(Schema.String)),
  nameSource: Schema.optionalKey(Schema.NullOr(Schema.String))
})
type ClaudeProcess = typeof ClaudeProcess.Type

const decodeClaudeProcess = Schema.decodeUnknownOption(Schema.fromJsonString(ClaudeProcess))

const claudeStatuses: Readonly<Record<string, AgentStatus>> = { busy: "working", idle: "idle", waiting: "blocked" }

export const claudeStatusOf = (status: string | null | undefined): AgentStatus =>
  claudeStatuses[status ?? ""] ?? "unknown"

const isLiveClaude = (table: Table, inside: ReadonlySet<string>, found: ClaudeProcess): boolean => {
  if (found.kind !== "interactive") return false
  const proc = table.get(found.pid)
  if (proc === undefined) return false
  if (commandOf(proc) !== "claude") return false

  return !isInside(table, proc, inside)
}

export const claudesOf = (
  procs: ReadonlyArray<Proc>,
  files: ReadonlyArray<string>,
  inside: ReadonlySet<string>
): ReadonlyArray<Found> => {
  const table = tableOf(procs)

  return Arr.getSomes(files.map((text) => decodeClaudeProcess(text)))
    .filter((found) => isLiveClaude(table, inside, found))
    .map((found) => ({
      pid: found.pid,
      cwd: found.cwd,
      session: Option.some(found.sessionId),
      name: found.nameSource === "user" ? Option.fromNullishOr(found.name) : Option.none(),
      status: claudeStatusOf(found.status)
    }))
}

export const piFolderOf = (home: string, cwd: string): string =>
  `${home}/.pi/agent/sessions/--${cwd.replace(/^\//, "").replaceAll("/", "-")}--`

export type Dated = { readonly file: string; readonly at: number }

const latestFirst = Order.mapInput(Order.Number, (dated: Dated) => -dated.at)

export const newestOf = (dated: ReadonlyArray<Dated>): Option.Option<string> =>
  Option.map(Arr.head(Arr.sort(dated, latestFirst)), (found) => found.file)
