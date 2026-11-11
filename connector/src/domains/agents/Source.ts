import { Effect, Option, Result, Schema } from "effect"
import { SourceName } from "@sth-herdr/protocol/Herdr.ts"
import type {
  Ability,
  AgentKind,
  AgentName,
  Directory,
  Key,
  Pane,
  PaneId,
  Snapshot,
  SourceState,
  WorkspaceId
} from "@sth-herdr/protocol/Herdr.ts"
import type { PaneFormat } from "@sth-herdr/protocol/Connector.ts"

export class AgentsFailed extends Schema.TaggedError<AgentsFailed, { readonly brand: unique symbol }>()(
  "AgentsFailed",
  { command: Schema.String, reason: Schema.String }
) {
  override get message() {
    return this.reason
  }
}

export type SourceError = { readonly _tag: string; readonly message: string; readonly reason: string }

export type StartOptions = {
  readonly workspace: Option.Option<WorkspaceId>
  readonly cwd: Directory
  readonly kind: AgentKind
  readonly name: AgentName
}

export type Host = {
  readonly snapshot: Effect.Effect<Snapshot, SourceError>
  readonly read: (pane: PaneId, lines: number, format?: PaneFormat) => Effect.Effect<string, SourceError>
  readonly prompt: (pane: PaneId, text: string) => Effect.Effect<void, SourceError>
  readonly sendKeys: (pane: PaneId, keys: ReadonlyArray<Key>) => Effect.Effect<void, SourceError>
  readonly sendText: (pane: PaneId, text: string) => Effect.Effect<void, SourceError>
  readonly start: (options: StartOptions) => Effect.Effect<PaneId, SourceError>
}

export type Source = Host & { readonly name: SourceName; readonly abilities: ReadonlyArray<Ability> }

export const multiplexerAbilities: ReadonlyArray<Ability> = ["prompt", "keys", "screen"]

export const appAbilities: ReadonlyArray<Ability> = ["prompt", "keys"]

const labels: Readonly<Record<string, string>> = {
  herdr: "Herdr",
  "herdr-core": "the Herdr app",
  claude: "Claude Code",
  pi: "Pi",
  opencode: "OpenCode",
  codex: "Codex"
}

export const labelOf = (name: string): string => labels[name] ?? name

export const sourceOf = (name: string, abilities: ReadonlyArray<Ability>, host: Host): Source => ({
  ...host,
  name: SourceName.make(name),
  abilities
})

export const readOnly = (name: string, snapshot: Effect.Effect<Snapshot, SourceError>): Source => {
  const refused = (command: string) =>
    Effect.fail(
      new AgentsFailed({
        command,
        reason: `${labelOf(name)} started outside a multiplexer has no terminal the phone can type into.`
      })
    )

  return {
    name: SourceName.make(name),
    abilities: [],
    snapshot,
    read: () => refused("read"),
    prompt: () => refused("prompt"),
    sendKeys: () => refused("keys"),
    sendText: () => refused("text"),
    start: () => refused("start")
  }
}

export type Seen = {
  readonly source: Source
  readonly snapshot: Option.Option<Snapshot>
  readonly state: SourceState
}

const versionSources: ReadonlyArray<string> = ["herdr", "herdr-core"]

const tagged = (source: Source, snapshot: Snapshot): Snapshot => ({
  ...snapshot,
  workspaces: snapshot.workspaces.map((workspace) => ({ ...workspace, source: source.name })),
  panes: snapshot.panes.map((pane) => ({ ...pane, source: source.name, abilities: source.abilities }))
})

const versionOf = (seen: ReadonlyArray<Seen>): string =>
  versionSources
    .flatMap((name) => seen.filter((found) => found.source.name === name))
    .flatMap((found) => Option.toArray(found.snapshot))
    .map((snapshot) => snapshot.herdrVersion)
    .find((version) => version !== "") ?? ""

type Taken = { readonly source: Source; readonly snapshot: Snapshot }

const types = (taken: Taken): boolean => taken.source.abilities.includes("keys")

const layoutOf = (taken: Taken, used: ReadonlySet<string>) => {
  const typing = types(taken)
  const workspaces = taken.snapshot.workspaces.filter((workspace) => typing || used.has(workspace.id))
  const kept = new Set(workspaces.map((workspace) => workspace.id))

  return { workspaces, tabs: taken.snapshot.tabs.filter((tab) => kept.has(tab.workspace)) }
}

const takenOf = (found: Seen): ReadonlyArray<Taken> =>
  Option.toArray(
    Option.map(found.snapshot, (snapshot) => ({ source: found.source, snapshot: tagged(found.source, snapshot) }))
  )

const sessionsOf = (panes: ReadonlyArray<Pane>): ReadonlySet<string> =>
  new Set(panes.flatMap((pane) => Option.toArray(pane.session)))

const panesKept =
  (typed: ReadonlySet<string>) =>
  (taken: Taken): ReadonlyArray<Pane> =>
    types(taken)
      ? taken.snapshot.panes
      : taken.snapshot.panes.filter((pane) => !Option.exists(pane.session, (session) => typed.has(session)))

export const merged = (seen: ReadonlyArray<Seen>): Snapshot => {
  const taken = seen.flatMap(takenOf)
  const typed = sessionsOf(taken.filter(types).flatMap((found) => found.snapshot.panes))
  const panes = taken.flatMap(panesKept(typed))
  const used = new Set(panes.map((pane) => pane.workspace))
  const layouts = taken.map((found) => layoutOf(found, used))

  return {
    herdrVersion: versionOf(seen),
    workspaces: layouts.flatMap((layout) => layout.workspaces),
    tabs: layouts.flatMap((layout) => layout.tabs),
    panes,
    sources: seen.map((found) => found.state)
  }
}

const graceFailures = 5

export type Memory = { readonly last: Option.Option<Snapshot>; readonly failures: number }

export const fresh: Memory = { last: Option.none(), failures: 0 }

const versionIn = (memory: Memory): string =>
  Option.match(memory.last, { onNone: () => "", onSome: (last) => last.herdrVersion })

export const seenAfter = (
  source: Source,
  memory: Memory,
  found: Result.Result<Snapshot, SourceError>
): { readonly seen: Seen; readonly memory: Memory } => {
  if (Result.isSuccess(found))
    return {
      seen: {
        source,
        snapshot: Option.some(found.success),
        state: { name: source.name, version: found.success.herdrVersion, reachable: true }
      },
      memory: { last: Option.some(found.success), failures: 0 }
    }
  const failures = memory.failures + 1
  const held = failures < graceFailures ? memory.last : Option.none()

  return {
    seen: {
      source,
      snapshot: held,
      state: {
        name: source.name,
        version: versionIn(memory),
        reachable: Option.isSome(held),
        reason: found.failure.message
      }
    },
    memory: { last: memory.last, failures }
  }
}
