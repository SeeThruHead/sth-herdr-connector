import { Array as Arr, Option, Schema } from "effect"
import { PaneId, TabId, WorkspaceId } from "@sth-herdr/protocol/Herdr.ts"
import type { AgentStatus, Pane, Snapshot, Tab, Workspace } from "@sth-herdr/protocol/Herdr.ts"

const Text = Schema.optionalKey(Schema.NullOr(Schema.String))

const CoreStatus = Schema.Struct({ state: Schema.String, app: Text, title: Text })

const Foreground = Schema.Struct({
  pid: Schema.optionalKey(Schema.NullOr(Schema.Int)),
  name: Text,
  argv: Schema.optionalKey(Schema.NullOr(Schema.Array(Schema.String)))
})

export const CoreTerminal = Schema.Struct({
  address: Schema.String,
  name: Text,
  cwd: Text,
  title: Text,
  state: Schema.String,
  argv: Schema.optionalKey(Schema.NullOr(Schema.Array(Schema.String))),
  labels: Schema.optionalKey(Schema.NullOr(Schema.Record(Schema.String, Schema.String))),
  status: Schema.optionalKey(Schema.NullOr(CoreStatus)),
  foreground: Schema.optionalKey(Schema.NullOr(Foreground))
})
export type CoreTerminal = typeof CoreTerminal.Type

export const TerminalList = Schema.Struct({
  result: Schema.Struct({ terminals: Schema.Array(CoreTerminal) })
})

type Node = {
  readonly content?: { readonly terminal?: string | undefined } | undefined
  readonly children?: ReadonlyArray<Node> | undefined
}

const Node: Schema.Codec<Node> = Schema.Struct({
  content: Schema.optionalKey(Schema.Struct({ terminal: Schema.optionalKey(Schema.String) })),
  children: Schema.optionalKey(Schema.Array(Schema.suspend((): Schema.Codec<Node> => Node)))
})

const CoreTab = Schema.Struct({ id: Schema.String, name: Text, root: Schema.optionalKey(Node) })

const CoreSpace = Schema.Struct({
  id: Schema.String,
  name: Text,
  folder: Text,
  tabs: Schema.Array(CoreTab)
})
export type CoreSpace = typeof CoreSpace.Type

export const AppDocument = Schema.Struct({
  result: Schema.Struct({
    value: Schema.NullOr(Schema.Struct({ spaces: Schema.Array(CoreSpace) }))
  })
})

export const ServerStatus = Schema.Struct({ version: Schema.String })

export const CoreError = Schema.Struct({
  error: Schema.Struct({ kind: Schema.String, message: Schema.String })
})

export const appDocument = "herdr-app"

const spaceLabel = "herdr.space"
const tabLabel = "herdr.tab"

const looseSpace = "core"

const looseLabels = { workspace: "Other terminals", tab: "outside the app" }

const isWorkspace = Schema.is(WorkspaceId)
const isTab = Schema.is(TabId)
const isPane = Schema.is(PaneId)

const statuses: ReadonlyArray<AgentStatus> = ["idle", "working", "blocked", "done"]

const urgency: Readonly<Record<AgentStatus, number>> = {
  blocked: 0,
  errored: 1,
  done: 2,
  working: 3,
  idle: 4,
  asleep: 5,
  unknown: 6
}

const present = (value: string | null | undefined): Option.Option<string> =>
  Option.filter(Option.fromNullishOr(value), (text) => text.trim() !== "")

export const isClaudeReady = (terminal: CoreTerminal): boolean => {
  if (Option.isSome(asleepSession(terminal))) return false
  if (terminal.status?.app !== "claude-code") return false

  return ["idle", "done"].includes(terminal.status.state)
}

const statusOf = (terminal: CoreTerminal): AgentStatus => {
  if (Option.isSome(asleepSession(terminal))) return "asleep"
  const state = terminal.status?.state ?? ""

  return statuses.find((status) => status === state) ?? "unknown"
}

export const sleepLabel = "sth.sleep"

const shells: ReadonlySet<string> = new Set(["zsh", "bash", "sh", "fish", "-zsh", "-bash", "dash"])

const runsShell = (terminal: CoreTerminal): boolean => {
  const program = terminal.foreground?.argv?.[0] ?? terminal.foreground?.name ?? ""

  return shells.has(program.split("/").at(-1) ?? "")
}

export const asleepSession = (terminal: CoreTerminal): Option.Option<string> =>
  Option.filter(present(terminal.labels?.[sleepLabel]), () => runsShell(terminal))

const agentNames: Readonly<Record<string, string>> = { "claude-code": "claude", "claude-asleep": "claude" }

const knownAgents: ReadonlySet<string> = new Set(["claude", "codex", "pi", "opencode", "gemini", "amp"])

const commandName = (terminal: CoreTerminal): Option.Option<string> =>
  Option.flatMap(Option.fromNullishOr(terminal.argv?.[0]), (program) =>
    Option.fromNullishOr(program.split("/").findLast((part) => part !== ""))
  )

const agentOf = (terminal: CoreTerminal): Option.Option<string> => {
  if (Option.isSome(asleepSession(terminal))) return Option.some("claude")

  return Option.orElse(
    Option.map(present(terminal.status?.app), (app) => agentNames[app] ?? app),
    () => Option.filter(commandName(terminal), (name) => knownAgents.has(name))
  )
}

export const workspaceIdOf = (space: string): string => `w${space}`

export const tabIdOf = (space: string, tab: string): string => `w${space}:t${tab}`

export const paneIdOf = (space: string, address: string): string => `w${space}:p${address}`

export const terminalOf = (pane: PaneId): string => pane.slice(pane.indexOf(":p") + 2)

export const mostUrgent = (found: ReadonlyArray<AgentStatus>): AgentStatus =>
  found.reduce<AgentStatus>((best, status) => (urgency[status] < urgency[best] ? status : best), "unknown")

const terminalsIn = (node: Node | undefined): ReadonlyArray<string> => {
  if (node === undefined) return []
  const own = Option.toArray(present(node.content?.terminal))

  return [...own, ...(node.children ?? []).flatMap(terminalsIn)]
}

type Place = { readonly space: string; readonly tab: string }

const placeFromDocument = (spaces: ReadonlyArray<CoreSpace>, address: string): Option.Option<Place> =>
  Option.fromNullishOr(
    spaces
      .flatMap((space) => space.tabs.map((tab) => ({ space: space.id, tab: tab.id, root: tab.root })))
      .find((tab) => terminalsIn(tab.root).includes(address))
  )

const placeFromLabels = (terminal: CoreTerminal): Option.Option<Place> =>
  Option.map(
    Option.all([
      Option.fromNullishOr(terminal.labels?.[spaceLabel]),
      Option.fromNullishOr(terminal.labels?.[tabLabel])
    ]),
    ([space, tab]) => ({ space, tab })
  )

const isPlaceable = (place: Place, address: string): boolean => {
  if (!isWorkspace(workspaceIdOf(place.space))) return false
  if (!isTab(tabIdOf(place.space, place.tab))) return false

  return isPane(paneIdOf(place.space, address))
}

const loose: Place = { space: looseSpace, tab: looseSpace }

const placeOf = (spaces: ReadonlyArray<CoreSpace>, terminal: CoreTerminal): Option.Option<Place> => {
  const found = Option.orElse(placeFromDocument(spaces, terminal.address), () => placeFromLabels(terminal))
  const placeable = Option.filter(found, (place) => isPlaceable(place, terminal.address))
  if (Option.isSome(placeable)) return placeable
  if (Option.isNone(agentOf(terminal))) return Option.none()

  return isPane(paneIdOf(loose.space, terminal.address)) ? Option.some(loose) : Option.none()
}

export type SessionOf = (pid: number) => Option.Option<string>

const sessionFor = (terminal: CoreTerminal, sessionOf: SessionOf): Option.Option<string> => {
  if (!Option.contains(agentOf(terminal), "claude")) return Option.none()
  const asleep = asleepSession(terminal)
  if (Option.isSome(asleep)) return asleep

  return Option.flatMap(Option.fromNullishOr(terminal.foreground?.pid), sessionOf)
}

type Placed = { readonly terminal: CoreTerminal; readonly place: Place }

const paneOf = (placed: Placed, sessionOf: SessionOf): Pane => ({
  id: PaneId.make(paneIdOf(placed.place.space, placed.terminal.address)),
  workspace: WorkspaceId.make(workspaceIdOf(placed.place.space)),
  tab: TabId.make(tabIdOf(placed.place.space, placed.place.tab)),
  agent: agentOf(placed.terminal),
  name: present(placed.terminal.name),
  status: statusOf(placed.terminal),
  cwd: Option.getOrElse(present(placed.terminal.cwd), () => ""),
  title: Option.orElse(present(placed.terminal.status?.title), () => present(placed.terminal.title)),
  session: sessionFor(placed.terminal, sessionOf)
})

const folderName = (folder: string | null | undefined): string =>
  Option.getOrElse(
    Option.flatMap(present(folder), (path) => Option.fromNullishOr(path.split("/").findLast((part) => part !== ""))),
    () => "space"
  )

const statusAmong = (panes: ReadonlyArray<Pane>, keep: (pane: Pane) => boolean): AgentStatus =>
  mostUrgent(panes.filter(keep).map((pane) => pane.status))

const spaceIds = (spaces: ReadonlyArray<CoreSpace>, panes: ReadonlyArray<Pane>): ReadonlyArray<string> =>
  Arr.dedupe([...spaces.map((space) => workspaceIdOf(space.id)), ...panes.map((pane) => pane.workspace)]).filter(
    isWorkspace
  )

const workspaceOf =
  (spaces: ReadonlyArray<CoreSpace>, panes: ReadonlyArray<Pane>) =>
  (id: string, index: number): Workspace => {
    const space = spaces.find((found) => workspaceIdOf(found.id) === id)

    return {
      id: WorkspaceId.make(id),
      label: Option.getOrElse(present(space?.name), () =>
        space === undefined ? (id === workspaceIdOf(looseSpace) ? looseLabels.workspace : id) : folderName(space.folder)
      ),
      number: index + 1,
      status: statusAmong(panes, (pane) => pane.workspace === id)
    }
  }

const documentTabs = (spaces: ReadonlyArray<CoreSpace>): ReadonlyArray<{ id: string; label: string }> =>
  spaces.flatMap((space) =>
    space.tabs.map((tab, index) => ({
      id: tabIdOf(space.id, tab.id),
      label: Option.getOrElse(present(tab.name), () => String(index + 1))
    }))
  )

const tabsOf = (spaces: ReadonlyArray<CoreSpace>, panes: ReadonlyArray<Pane>): ReadonlyArray<Tab> => {
  const named = documentTabs(spaces)
  const ids = Arr.dedupe([...named.map((tab) => tab.id), ...panes.map((pane) => pane.tab)]).filter(isTab)

  return ids.map((id, index) => ({
    id: TabId.make(id),
    workspace: WorkspaceId.make(id.slice(0, id.indexOf(":t"))),
    label:
      named.find((tab) => tab.id === id)?.label ??
      (id === tabIdOf(looseSpace, looseSpace) ? looseLabels.tab : String(index + 1)),
    number: index + 1,
    status: statusAmong(panes, (pane) => pane.tab === id)
  }))
}

export type CoreView = {
  readonly version: string
  readonly terminals: ReadonlyArray<CoreTerminal>
  readonly spaces: ReadonlyArray<CoreSpace>
  readonly sessionOf: SessionOf
}

export const coreSnapshotOf = (view: CoreView): Snapshot => {
  const live = view.terminals.filter((terminal) => terminal.state === "live")
  const placed = live.flatMap((terminal) =>
    Option.toArray(Option.map(placeOf(view.spaces, terminal), (place) => ({ terminal, place })))
  )
  const panes = placed.map((found) => paneOf(found, view.sessionOf))

  return {
    herdrVersion: view.version,
    workspaces: spaceIds(view.spaces, panes).map(workspaceOf(view.spaces, panes)),
    tabs: tabsOf(view.spaces, panes),
    panes
  }
}

const freshSuffix = /[^A-Za-z0-9]/g

export const newPlace = (workspace: Option.Option<WorkspaceId>, fresh: string): Place => {
  const tab = `tb${fresh.replaceAll(freshSuffix, "")}`

  return Option.match(workspace, {
    onNone: () => ({ space: `sp${fresh.replaceAll(freshSuffix, "")}`, tab }),
    onSome: (id) => ({ space: id.slice(1), tab })
  })
}

const ClaudeSession = Schema.Struct({ sessionId: Schema.String })

export const decodeClaudeSession = Schema.decodeUnknownOption(Schema.fromJsonString(ClaudeSession))

export const ReadResult = Schema.Struct({ text: Schema.String })

export const Started = Schema.Struct({ address: Schema.String })

export const rpcLine = (method: string, params: Record<string, unknown>): string =>
  `${JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })}\n`

export const firstLine = (text: string): string => text.split("\n", 1).join("")

const typable = /^[\x21-\x7e]$/

const keyOf = (character: string): Option.Option<string> => {
  if (character === " ") return Option.some("space")

  return typable.test(character) ? Option.some(character) : Option.none()
}

export const keysOfText = (text: string): Option.Option<ReadonlyArray<string>> =>
  Option.all(Array.from(text).map(keyOf))

export const claudePids = (terminals: ReadonlyArray<CoreTerminal>): ReadonlyArray<number> =>
  terminals.flatMap((terminal) =>
    Option.contains(agentOf(terminal), "claude") ? Option.toArray(Option.fromNullishOr(terminal.foreground?.pid)) : []
  )

export const expandHome = (cwd: string, home: string): string => cwd.replace(/^~(?=$|\/)/, home)

export const runArgs = (options: {
  readonly name: string
  readonly cwd: string
  readonly kind: string
  readonly place: { readonly space: string; readonly tab: string }
}): ReadonlyArray<string> => [
  "run",
  "--bg",
  "--keep",
  "--no-parent",
  "--json",
  "--name",
  options.name,
  "--cwd",
  options.cwd,
  "--label",
  `herdr.space=${options.place.space}`,
  "--label",
  `herdr.tab=${options.place.tab}`,
  "--",
  options.kind
]
