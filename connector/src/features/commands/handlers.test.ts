import { BunServices } from "@effect/platform-bun"
import { describe, expect, it as live, layer } from "@effect/vitest"
import { Context, Effect, Fiber, FileSystem, Layer, Option } from "effect"
import type { ChildProcessSpawner } from "effect/process"
import { TestClock } from "effect/testing"
import { CommandId, ScreenId } from "@sth-herdr/protocol/Connector.ts"
import type { HubCommand } from "@sth-herdr/protocol/Connector.ts"
import { AgentName, Directory, PaneId } from "@sth-herdr/protocol/Herdr.ts"
import { Agents } from "../../domains/agents/Agents.ts"
import { multiplexerAbilities, sourceOf } from "../../domains/agents/Source.ts"
import { Herdr } from "../../domains/herdr/Herdr.ts"
import { Screens } from "../../domains/screens/Screens.ts"
import { Transcript } from "../../domains/transcript/Transcript.ts"
import { Uploads } from "../../domains/uploads/Uploads.ts"
import { SlashCommands, builtIn } from "../../domains/slashcommands/SlashCommands.ts"
import { execute } from "./handlers.ts"

const herdrSource = (herdr: Layer.Layer<Herdr, never, ChildProcessSpawner.ChildProcessSpawner>) =>
  Effect.scoped(
    Effect.map(Layer.build(herdr), (context) => sourceOf("herdr", multiplexerAbilities, Context.get(context, Herdr)))
  )

const fixtures = new URL("../../../fixtures/", import.meta.url).pathname

const services = Layer.mergeAll(
  Agents.layer([
    herdrSource(Herdr.layer({ binary: `${fixtures}bin/herdr`, session: Option.none(), home: "/home/demo" }))
  ]),
  Transcript.layer(`${fixtures}home`),
  Screens.layer({ binary: "/bin/cat", session: Option.none(), environment: {} }),
  Uploads.layer(`${fixtures}home/.cache/sth-herdr/uploads`),
  SlashCommands.layer(`${fixtures}home`)
).pipe(Layer.provide(BunServices.layer))

const id = CommandId.make("019a4b5e-0000-7000-8000-000000000001")
const agentPane = PaneId.make("w1:pH")
const shellPane = PaneId.make("w2:p1")

const run = (command: HubCommand) => execute(command)

const runAll = (commands: ReadonlyArray<HubCommand>) => Effect.forEach(commands, execute)

describe("what the connector does with each command from the hub", () => {
  layer(services)((it) => {
    it.effect("answers a pane read with the pane's text", () =>
      Effect.gen(function* () {
        const read = yield* run({ _tag: "ReadPane", id, pane: agentPane, lines: 40 })

        expect(read).toEqual({ _tag: "PaneText", text: "line one\nline two\n" })
      })
    )

    it.effect("confirms a prompt, keys and typed text", () =>
      Effect.gen(function* () {
        const outcomes = yield* runAll([
          { _tag: "Prompt", id, pane: agentPane, text: "hi" },
          { _tag: "Prompt", id, pane: agentPane, text: "see", files: [{ name: "a.png", base64: "!!" }] },
          { _tag: "SendKeys", id, pane: agentPane, keys: ["enter"] },
          { _tag: "SendText", id, pane: agentPane, text: "ls\r" }
        ])

        expect(outcomes).toEqual([
          { _tag: "Done" },
          { _tag: "Refused", reason: "a.png isn't a file the phone could send." },
          { _tag: "Done" },
          { _tag: "Done" }
        ])
      })
    )

    it.effect("lists the slash commands for the agent in a pane", () =>
      Effect.gen(function* () {
        const outcomes = yield* runAll([
          { _tag: "ListCommands", id, pane: agentPane },
          { _tag: "ListCommands", id, pane: PaneId.make("w9:p9") }
        ])

        expect(outcomes).toEqual([
          { _tag: "CommandsListed", commands: builtIn },
          { _tag: "Refused", reason: "That pane isn't open now." }
        ])
      })
    )

    it.effect("says which pane a new agent started in", () =>
      Effect.gen(function* () {
        const outcome = yield* run({
          _tag: "StartAgent",
          id,
          workspace: Option.none(),
          cwd: Directory.make("~/code/demo"),
          kind: "claude",
          name: AgentName.make("demo")
        })

        expect(outcome).toEqual({ _tag: "Started", pane: "w7:p1" })
      })
    )

    it.effect("refuses with Herdr's reason instead of failing the link", () =>
      Effect.gen(function* () {
        const read = yield* run({ _tag: "ReadPane", id, pane: PaneId.make("w9:p9"), lines: 40 })

        expect(read).toEqual({ _tag: "Refused", reason: "herdr pane read failed: pane w9:p9 not found" })
      })
    )

    it.effect("reads the conversation of the agent in a pane", () =>
      Effect.gen(function* () {
        const outcome = yield* run({ _tag: "ReadTranscript", id, pane: agentPane, limit: 3 })
        if (outcome._tag !== "TranscriptRead") return yield* Effect.die("expected a transcript")

        expect(outcome.transcript.items.map((item) => item._tag)).toEqual(["ToolResult", "ToolResult", "Said"])
        expect(outcome.transcript.more).toBe(true)
      })
    )

    it.effect("says so when Herdr still sees no agent after a few looks, or one it can't read", () =>
      Effect.gen(function* () {
        const reading = yield* Effect.forkChild(
          runAll([
            { _tag: "ReadTranscript", id, pane: PaneId.make("w2:p2"), limit: 3 },
            { _tag: "ReadTranscript", id, pane: shellPane, limit: 3 }
          ])
        )
        yield* Effect.forEach(Array.from({ length: 12 }), () =>
          TestClock.adjust("300 millis").pipe(Effect.andThen(Effect.sleep("30 millis").pipe(TestClock.withLive)))
        )
        const outcomes = yield* Fiber.join(reading)

        expect(outcomes).toEqual([
          { _tag: "Refused", reason: "The conversation view knows Claude, Pi and OpenCode so far, not codex." },
          { _tag: "Refused", reason: "No agent is running in that pane now." }
        ])
      })
    )

    it.effect(
      "opens Herdr on a screen, types into it, resizes and closes it, and refuses a screen it doesn't have",
      () =>
        Effect.gen(function* () {
          const screen = ScreenId.make("019a4b5e-0000-7000-8000-0000000000aa")
          const lost = ScreenId.make("019a4b5e-0000-7000-8000-0000000000bb")
          const outcomes = yield* runAll([
            { _tag: "OpenScreen", id, screen, cols: 80, rows: 24 },
            { _tag: "ResizeScreen", id, screen, cols: 100, rows: 30 },
            { _tag: "ScreenInput", id, screen, data: "hello\r" },
            { _tag: "CloseScreen", id, screen },
            { _tag: "CloseScreen", id, screen },
            { _tag: "ScreenInput", id, screen: lost, data: "x" }
          ])

          expect(outcomes).toEqual([
            ...Array.from({ length: 5 }, () => ({ _tag: "Done" })),
            { _tag: "Refused", reason: "That Herdr screen isn't open." }
          ])
        })
    )
  })
})

describe("an agent Herdr misses for a moment", () => {
  const flaky = Layer.mergeAll(
    Agents.layer([
      herdrSource(
        Herdr.layer({ binary: `${fixtures}bin/herdr-flaky`, session: Option.some("flaky"), home: "/home/demo" })
      )
    ]),
    Transcript.layer(`${fixtures}home`),
    Screens.layer({ binary: "/bin/cat", session: Option.none(), environment: {} }),
    Uploads.layer(`${fixtures}home/.cache/sth-herdr/uploads`),
    SlashCommands.layer(`${fixtures}home`)
  ).pipe(Layer.provideMerge(BunServices.layer))

  live.live("looks again and reads the conversation once Herdr sees the agent", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      yield* fs.remove(`${fixtures}state/flaky.snapshots`, { force: true })
      const outcome = yield* run({ _tag: "ReadTranscript", id, pane: agentPane, limit: 3 })

      expect(outcome._tag).toBe("TranscriptRead")
    }).pipe(Effect.provide(flaky))
  )
})
