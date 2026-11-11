import { describe, expect, it } from "@effect/vitest"
import { Effect, Option, Ref, Result } from "effect"
import { AgentKind, AgentName, Directory, PaneId, SourceName, TabId, WorkspaceId } from "@sth-herdr/protocol/Herdr.ts"
import type { Pane, Snapshot } from "@sth-herdr/protocol/Herdr.ts"
import { Agents } from "./Agents.ts"
import {
  AgentsFailed,
  appAbilities,
  fresh,
  labelOf,
  merged,
  multiplexerAbilities,
  readOnly,
  seenAfter,
  sourceOf
} from "./Source.ts"
import type { Host } from "./Source.ts"

const pane = (id: string, session: Option.Option<string>): Pane => ({
  id: PaneId.make(id),
  workspace: WorkspaceId.make(id.slice(0, id.indexOf(":"))),
  tab: TabId.make(`${id.slice(0, id.indexOf(":"))}:t1`),
  agent: Option.some("claude"),
  name: Option.none(),
  status: "idle",
  cwd: "/home/demo/api",
  title: Option.none(),
  session
})

const snapshotOf = (version: string, panes: ReadonlyArray<Pane>): Snapshot => ({
  herdrVersion: version,
  workspaces: [...new Set(panes.map((found) => found.workspace))].map((id) => ({
    id,
    label: id,
    number: 1,
    status: "idle"
  })),
  tabs: [...new Set(panes.map((found) => found.tab))].map((id) => ({
    id,
    workspace: WorkspaceId.make(id.slice(0, id.indexOf(":"))),
    label: id,
    number: 1,
    status: "idle"
  })),
  panes
})

const tuiSnapshot = snapshotOf("0.9.5", [pane("w1:p1", Option.some("s-shared")), pane("w1:p2", Option.none())])

const plainSnapshot = snapshotOf("", [
  pane("wclaude:p10", Option.some("s-shared")),
  pane("wclaude:p11", Option.some("s-alone"))
])

const failed = (command: string) => Effect.fail(new AgentsFailed({ command, reason: `${command} isn't here` }))

const hostOf = (
  snapshot: Effect.Effect<Snapshot, AgentsFailed>,
  log: Ref.Ref<ReadonlyArray<string>>,
  name: string
): Host => ({
  snapshot,
  read: (target) =>
    Effect.as(
      Ref.update(log, (seen) => [...seen, `${name} read ${target}`]),
      `${name} text`
    ),
  prompt: (target, text) => Ref.update(log, (seen) => [...seen, `${name} prompt ${target} ${text}`]),
  sendKeys: (target, keys) => Ref.update(log, (seen) => [...seen, `${name} keys ${target} ${keys.join(" ")}`]),
  sendText: (target, text) => Ref.update(log, (seen) => [...seen, `${name} text ${target} ${text}`]),
  start: () =>
    Effect.as(
      Ref.update(log, (seen) => [...seen, `${name} start`]),
      PaneId.make("w1:p9")
    )
})

const startOptions = {
  workspace: Option.none(),
  cwd: Directory.make("~/code"),
  kind: AgentKind.make("claude"),
  name: AgentName.make("helper")
}

describe("one snapshot from every source", () => {
  it("tags each pane with its source and drops a plain agent a multiplexer already shows", () => {
    const tui = sourceOf(
      "herdr",
      multiplexerAbilities,
      hostOf(Effect.succeed(tuiSnapshot), Ref.makeUnsafe<ReadonlyArray<string>>([]), "herdr")
    )
    const plain = readOnly("claude", Effect.succeed(plainSnapshot))
    const result = merged([
      { source: tui, snapshot: Option.some(tuiSnapshot), state: { name: tui.name, version: "0.9.5", reachable: true } },
      { source: plain, snapshot: Option.some(plainSnapshot), state: { name: plain.name, version: "", reachable: true } }
    ])

    expect(result.panes.map((found) => `${found.id} ${found.source} ${found.abilities?.join("+")}`)).toEqual([
      "w1:p1 herdr prompt+keys+screen",
      "w1:p2 herdr prompt+keys+screen",
      "wclaude:p11 claude "
    ])
    expect(result.herdrVersion).toBe("0.9.5")
    expect(result.workspaces.map((found) => found.id)).toEqual(["w1", "wclaude"])
    expect(result.sources?.map((found) => found.name)).toEqual(["herdr", "claude"])
  })

  it("leaves out a plain source's empty workspace and uses the app's version without the TUI", () => {
    const app = sourceOf(
      "herdr-core",
      appAbilities,
      hostOf(Effect.succeed(tuiSnapshot), Ref.makeUnsafe<ReadonlyArray<string>>([]), "core")
    )
    const plain = readOnly("claude", Effect.succeed(plainSnapshot))
    const emptyPlain = { ...plainSnapshot, panes: [] }
    const result = merged([
      {
        source: app,
        snapshot: Option.some({ ...tuiSnapshot, herdrVersion: "0.1.18" }),
        state: { name: app.name, version: "0.1.18", reachable: true }
      },
      { source: plain, snapshot: Option.some(emptyPlain), state: { name: plain.name, version: "", reachable: true } }
    ])

    expect(result.herdrVersion).toBe("0.1.18")
    expect(result.workspaces.map((found) => found.id)).toEqual(["w1"])
    expect(result.tabs.map((found) => found.id)).toEqual(["w1:t1"])
  })

  it("keeps a source's last snapshot through a few failed looks, then marks it unreachable", () => {
    const plain = readOnly("claude", Effect.succeed(plainSnapshot))
    const error = new AgentsFailed({ command: "snapshot", reason: "Claude's folder is gone" })
    const first = seenAfter(plain, fresh, Result.succeed(plainSnapshot))
    const looks = Array.from({ length: 5 }).reduce<ReturnType<typeof seenAfter>>(
      (last) => seenAfter(plain, last.memory, Result.fail(error)),
      first
    )
    const once = seenAfter(plain, first.memory, Result.fail(error))

    expect(Option.isSome(once.seen.snapshot)).toBe(true)
    expect(once.seen.state).toEqual({ name: "claude", version: "", reachable: true, reason: "Claude's folder is gone" })
    expect(Option.isNone(looks.seen.snapshot)).toBe(true)
    expect(looks.seen.state.reachable).toBe(false)
    expect(seenAfter(plain, fresh, Result.fail(error)).seen.state.version).toBe("")
  })

  it("names each source for people", () => {
    expect([labelOf("herdr-core"), labelOf("pi"), labelOf("tmux")]).toEqual(["the Herdr app", "Pi", "tmux"])
  })
})

describe("the router in front of every source", () => {
  it.effect("sends each command to the source that showed the pane", () =>
    Effect.gen(function* () {
      const log = yield* Ref.make<ReadonlyArray<string>>([])
      const tui = sourceOf("herdr", multiplexerAbilities, hostOf(Effect.succeed(tuiSnapshot), log, "herdr"))
      const app = sourceOf(
        "herdr-core",
        appAbilities,
        hostOf(Effect.succeed(snapshotOf("0.1.18", [pane("wsp1:pt1", Option.none())])), log, "core")
      )
      const result = yield* Effect.gen(function* () {
        const agents = yield* Agents
        const snapshot = yield* agents.snapshot
        yield* agents.prompt(PaneId.make("wsp1:pt1"), "hello")
        yield* agents.sendKeys(PaneId.make("w1:p1"), ["enter"])
        yield* agents.sendText(PaneId.make("wsp1:pt1"), "abc")
        const text = yield* agents.read(PaneId.make("w1:p2"), 10)
        yield* agents.start({ ...startOptions, source: SourceName.make("herdr-core") })
        yield* agents.start(startOptions)

        return { snapshot, text, sources: agents.sources }
      }).pipe(Effect.provide(Agents.layer([Effect.succeed(tui), Effect.succeed(app)])))

      expect(result.snapshot.panes.length).toBe(3)
      expect(result.text).toBe("herdr text")
      expect(result.sources).toEqual(["herdr", "herdr-core"])
      const logged = yield* Ref.get(log)
      expect(logged).toEqual([
        "core prompt wsp1:pt1 hello",
        "herdr keys w1:p1 enter",
        "core text wsp1:pt1 abc",
        "herdr read w1:p2",
        "core start",
        "herdr start"
      ])
    })
  )

  it.effect("looks again for a pane it hasn't seen, and hands an unknown one to the main multiplexer", () =>
    Effect.gen(function* () {
      const log = yield* Ref.make<ReadonlyArray<string>>([])
      const tui = sourceOf("herdr", multiplexerAbilities, hostOf(Effect.succeed(tuiSnapshot), log, "herdr"))
      yield* Effect.gen(function* () {
        const agents = yield* Agents
        yield* agents.prompt(PaneId.make("w1:p1"), "first")
        yield* agents.prompt(PaneId.make("w7:p7"), "lost")
      }).pipe(Effect.provide(Agents.layer([Effect.succeed(tui)])))

      const logged = yield* Ref.get(log)
      expect(logged).toEqual(["herdr prompt w1:p1 first", "herdr prompt w7:p7 lost"])
    })
  )

  it.effect("refuses where no source can take the command, and keeps a failing source from hiding the rest", () =>
    Effect.gen(function* () {
      const plain = readOnly("claude", Effect.succeed(plainSnapshot))
      const broken = readOnly("pi", failed("snapshot"))
      const result = yield* Effect.gen(function* () {
        const agents = yield* Agents
        const snapshot = yield* agents.snapshot
        const typed = yield* Effect.flip(agents.prompt(PaneId.make("wclaude:p11"), "hi"))
        const others = yield* Effect.all(
          [
            Effect.flip(agents.read(PaneId.make("wclaude:p11"), 5)),
            Effect.flip(agents.sendKeys(PaneId.make("wclaude:p11"), ["esc"])),
            Effect.flip(agents.sendText(PaneId.make("wclaude:p11"), "x"))
          ],
          { concurrency: 1 }
        )
        const unknown = yield* Effect.flip(agents.prompt(PaneId.make("w9:p9"), "hi"))
        const started = yield* Effect.flip(agents.start(startOptions))
        const startedPlain = yield* Effect.flip(agents.start({ ...startOptions, source: SourceName.make("claude") }))

        return { snapshot, typed, others, unknown, started, startedPlain }
      }).pipe(Effect.provide(Agents.layer([Effect.succeed(plain), Effect.succeed(broken)])))

      expect(result.snapshot.panes.map((found) => found.id)).toEqual(["wclaude:p10", "wclaude:p11"])
      expect(result.snapshot.sources?.map((found) => found.reachable)).toEqual([true, false])
      expect(result.typed.message).toBe(
        "Claude Code started outside a multiplexer has no terminal the phone can type into."
      )
      expect(result.others.map((error) => error.reason)).toEqual([
        "Claude Code started outside a multiplexer has no terminal the phone can type into.",
        "Claude Code started outside a multiplexer has no terminal the phone can type into.",
        "Claude Code started outside a multiplexer has no terminal the phone can type into."
      ])
      expect(result.unknown.message).toBe("That pane isn't open now.")
      expect(result.started.message).toBe("This machine has nowhere to start an agent.")
      expect(result.startedPlain.message).toBe(
        "Claude Code started outside a multiplexer has no terminal the phone can type into."
      )
    })
  )
})
