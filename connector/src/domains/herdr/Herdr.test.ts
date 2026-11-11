import { BunServices } from "@effect/platform-bun"
import { describe, expect, it as alone, layer } from "@effect/vitest"
import { Effect, Fiber, FileSystem, Layer, Option } from "effect"
import { TestClock } from "effect/testing"
import { AgentName, Directory, PaneId, WorkspaceId } from "@sth-herdr/protocol/Herdr.ts"
import { Herdr, afterLeftover } from "./Herdr.ts"
import type { HerdrFailed } from "./Herdr.ts"

const binary = new URL("../../../fixtures/bin/herdr", import.meta.url).pathname

const stepUntilDone = <A, E>(fiber: Fiber.Fiber<A, E>) =>
  TestClock.adjust("500 millis").pipe(
    Effect.andThen(Effect.sleep("50 millis").pipe(TestClock.withLive)),
    Effect.map(() => fiber.pollUnsafe() !== undefined),
    Effect.repeat({ until: (done) => done })
  )

const herdrWith = (path: string) =>
  Herdr.layer({ binary: path, session: Option.some("test"), home: "/home/demo" }).pipe(Layer.provide(BunServices.layer))

describe("a phone message typed after whatever is already in the agent's box", () => {
  alone("starts with a space so it never runs into leftover text", () => {
    expect(afterLeftover("carry on")).toBe(" carry on")
  })

  alone("keeps slash and shell commands as they are", () => {
    expect([afterLeftover("/compact"), afterLeftover("!ls")]).toEqual(["/compact", "!ls"])
  })
})

describe("talking to Herdr through its CLI", () => {
  layer(herdrWith(binary))((it) => {
    it.effect("reads the snapshot into workspaces, tabs and panes", () =>
      Effect.gen(function* () {
        const snapshot = yield* (yield* Herdr).snapshot

        expect(snapshot.herdrVersion).toBe("0.9.5")
        expect(snapshot.panes.length).toBe(5)
      })
    )

    it.effect("reads the visible screen with its colours", () =>
      Effect.gen(function* () {
        const herdr = yield* Herdr
        const text = yield* herdr.read(PaneId.make("w1:pH"), 50, "ansi")

        expect(text).toBe("\u001b[1mbold\u001b[0m visible\n")
      })
    )

    it.effect("reads a pane's text", () =>
      Effect.gen(function* () {
        const herdr = yield* Herdr
        const text = yield* herdr.read(PaneId.make("w1:pH"), 50)

        expect(text).toBe("line one\nline two\n")
      })
    )

    it.effect("passes Herdr's own error message on", () =>
      Effect.gen(function* () {
        const error = yield* Effect.flip((yield* Herdr).read(PaneId.make("w9:p9"), 50))

        expect(error.message).toBe("herdr pane read failed: pane w9:p9 not found")
      })
    )

    it.effect("passes on plain error text, or says there was none", () =>
      Effect.gen(function* () {
        const herdr = yield* Herdr

        expect((yield* Effect.flip(herdr.read(PaneId.make("w5:p5"), 5))).reason).toBe("plain failure")
        expect((yield* Effect.flip(herdr.read(PaneId.make("w6:p6"), 5))).reason).toBe("no output")
      })
    )

    it.effect("gives up on a command Herdr doesn't answer in time", () =>
      Effect.gen(function* () {
        const reading = yield* Effect.forkChild(Effect.flip((yield* Herdr).read(PaneId.make("w8:p8"), 5)))
        yield* Effect.yieldNow
        yield* TestClock.adjust("6 seconds")
        const error = yield* Fiber.join(reading)

        expect(error.reason).toBe("no answer within 5s")
      })
    )

    it.effect("prompts an agent and sends keys", () =>
      Effect.gen(function* () {
        const herdr = yield* Herdr
        yield* herdr.prompt(PaneId.make("w1:pH"), "hello")
        yield* herdr.sendKeys(PaneId.make("w1:pH"), ["esc", "enter"])
      })
    )

    it.effect("starts an agent in a new workspace, or in a new tab of a workspace", () =>
      Effect.gen(function* () {
        const herdr = yield* Herdr
        const start = { cwd: Directory.make("~/code/demo"), kind: "claude", name: AgentName.make("demo") } as const

        const inNewWorkspace = yield* herdr.start({ ...start, workspace: Option.none() })
        const inWorkspace = yield* herdr.start({ ...start, workspace: Option.some(WorkspaceId.make("w1")) })

        expect(inNewWorkspace).toBe("w7:p1")
        expect(inWorkspace).toBe("w1:p8")
      })
    )

    it.effect("counts an agent that stops on a question as it starts, such as trusting a new folder, as started", () =>
      Effect.gen(function* () {
        const herdr = yield* Herdr
        const start = { cwd: Directory.make("~/code/new"), kind: "claude", name: AgentName.make("waiting") } as const

        const pane = yield* herdr.start({ ...start, workspace: Option.none() })

        expect(pane).toBe("w7:p1")
      })
    )
  })

  layer(herdrWith(new URL("../../../fixtures/bin/herdr-garbled", import.meta.url).pathname))((it) => {
    it.effect("says when Herdr answers with something it can't read", () =>
      Effect.gen(function* () {
        const error = yield* Effect.flip((yield* Herdr).snapshot)

        expect(error.reason).toContain("unexpected answer")
      })
    )
  })

  layer(herdrWith("/nonexistent/herdr"))((it) => {
    it.effect("says so when the herdr binary is missing", () =>
      Effect.gen(function* () {
        const error = yield* Effect.flip((yield* Herdr).snapshot)

        expect(error._tag).toBe("HerdrFailed")
        expect(error.message).toContain("herdr api snapshot failed")
      })
    )
  })

  describe("a message sent while the agent shows a panel", () => {
    const blocked = new URL("../../../fixtures/bin/herdr-blocked", import.meta.url).pathname
    const state = new URL("../../../fixtures/state/", import.meta.url).pathname

    const callsAfter = (session: string, send: (herdr: Herdr["Service"]) => Effect.Effect<void, HerdrFailed>) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        yield* fs.remove(`${state}${session}.calls`, { force: true })
        const herdr = yield* Herdr
        yield* send(herdr)
        const calls = yield* fs.readFileString(`${state}${session}.calls`)

        return calls.trim().split("\n")
      }).pipe(
        Effect.provide(
          Herdr.layer({ binary: blocked, session: Option.some(session), home: "/home/demo" }).pipe(
            Layer.provideMerge(BunServices.layer)
          )
        )
      )

    alone.effect("closes the panel with Esc and sends the message", () =>
      Effect.gen(function* () {
        const calls = yield* callsAfter("closes", (herdr) => herdr.prompt(PaneId.make("wB:p1"), "carry on"))

        expect(calls).toEqual([
          "agent prompt wB:p1  carry on",
          "pane send-keys wB:p1 esc",
          "agent prompt wB:p1  carry on"
        ])
      })
    )

    alone.effect("types the message and presses Enter when Herdr still calls the agent blocked", () =>
      Effect.gen(function* () {
        const sending = yield* Effect.forkChild(
          callsAfter("stays", (herdr) => herdr.prompt(PaneId.make("wB:p2"), "carry on"))
        )
        yield* Effect.yieldNow
        yield* stepUntilDone(sending)
        const calls = yield* Fiber.join(sending)

        expect(calls.slice(0, 2)).toEqual(["agent prompt wB:p2  carry on", "pane send-keys wB:p2 esc"])
        expect(calls.slice(-2)).toEqual(["pane send-text wB:p2  carry on", "pane send-keys wB:p2 enter"])
        expect(calls.filter((call) => call.startsWith("agent prompt")).length).toBe(8)
      })
    )
  })

  describe("talking to herdr-core through hc", () => {
    const hc = new URL("../../../fixtures/bin/hc", import.meta.url).pathname
    const home = new URL("../../../fixtures/home", import.meta.url).pathname
    const state = new URL("../../../fixtures/state/", import.meta.url).pathname

    const coreWith = (session: string, program = hc) =>
      Herdr.core({ binary: program, session: Option.some(session), home }).pipe(Layer.provideMerge(BunServices.layer))

    const callsOf = Effect.fnUntraced(function* (session: string) {
      const fs = yield* FileSystem.FileSystem
      const calls = yield* fs.readFileString(`${state}core-${session}.calls`)

      return calls.trim().split("\n")
    })

    const fresh = Effect.fnUntraced(function* (session: string) {
      const fs = yield* FileSystem.FileSystem
      yield* fs.remove(`${state}core-${session}.calls`, { force: true })
    })

    alone.effect("reads the core's terminals and the app's spaces into a snapshot", () =>
      Effect.gen(function* () {
        const snapshot = yield* (yield* Herdr).snapshot

        expect(snapshot.herdrVersion).toBe("0.1.18")
        expect(snapshot.workspaces.map((workspace) => [workspace.id, workspace.label, workspace.status])).toEqual([
          ["wspA", "project-1", "working"],
          ["wspB", "Other work", "blocked"],
          ["wspEmpty", "space", "unknown"],
          ["wcore", "Other terminals", "unknown"]
        ])
        expect(snapshot.tabs.map((tab) => [tab.id, tab.label])).toEqual([
          ["wspA:ttbA", "build"],
          ["wspB:ttbB", "1"],
          ["wspB:ttbC", "2"],
          ["wcore:tcore", "outside the app"]
        ])
        expect(
          snapshot.panes.map((pane) => [
            pane.id,
            Option.getOrNull(pane.agent),
            pane.status,
            Option.getOrNull(pane.session)
          ])
        ).toEqual([
          ["wspA:pt1", "claude", "working", "55369201-d496-487b-b929-d7e8fb6484bb"],
          ["wspA:pt2", null, "unknown", null],
          ["wcore:pt3", "codex", "unknown", null],
          ["wspB:pt5", "claude", "blocked", null],
          ["wcore:pt6", "pi", "unknown", null]
        ])
      }).pipe(Effect.provide(coreWith("default")))
    )

    alone.effect("reads an app that has no spaces yet", () =>
      Effect.gen(function* () {
        const snapshot = yield* (yield* Herdr).snapshot

        expect(snapshot.workspaces.map((workspace) => workspace.id)).toEqual(["wspA", "wcore", "wspB"])
      }).pipe(Effect.provide(coreWith("empty")))
    )

    alone.effect("says when the core answers with something it can't read", () =>
      Effect.gen(function* () {
        const error = yield* Effect.flip((yield* Herdr).snapshot)

        expect(error.reason).toContain("unexpected answer")
      }).pipe(Effect.provide(coreWith("garbled")))
    )

    alone.effect("reads a terminal, and passes the core's own errors on", () =>
      Effect.gen(function* () {
        const herdr = yield* Herdr
        const text = yield* herdr.read(PaneId.make("wspA:pt1"), 50)
        const missing = yield* Effect.flip(herdr.read(PaneId.make("wspA:pt9"), 5))
        const plain = yield* Effect.flip(herdr.read(PaneId.make("wspA:pt5"), 5))
        const refused = yield* Effect.flip(herdr.sendKeys(PaneId.make("wspA:pt7"), ["enter"]))

        expect(text).toBe("line one\nline two\n")
        expect(missing.message).toBe("herdr read failed: no terminal t9")
        expect(plain.reason).toBe("plain failure")
        expect(refused.code).toBe("not_found")
      }).pipe(Effect.provide(coreWith("reads")))
    )

    alone.effect("sends keys, types plain text as keys, and refuses text it can't type", () =>
      Effect.gen(function* () {
        yield* fresh("typing")
        const herdr = yield* Herdr
        yield* herdr.sendKeys(PaneId.make("wspA:pt1"), ["esc", "shift+tab"])
        yield* herdr.sendText(PaneId.make("wspA:pt1"), "a b")
        const refused = yield* Effect.flip(herdr.sendText(PaneId.make("wspA:pt1"), "café"))
        const calls = yield* callsOf("typing")

        expect(refused.reason).toBe("herdr-core can only type plain ASCII text")
        expect(calls).toEqual(["keys t1 esc shift+tab --json", "keys t1 a space b --json"])
      }).pipe(Effect.provide(coreWith("typing")))
    )

    alone.effect("prompts an agent, closing a dialog with Esc first when the agent is blocked", () =>
      Effect.gen(function* () {
        yield* fresh("prompts")
        const herdr = yield* Herdr
        yield* herdr.prompt(PaneId.make("wspA:pt1"), "carry on")
        yield* herdr.prompt(PaneId.make("wspA:ptB"), "/compact")
        const calls = yield* callsOf("prompts")

        expect(calls).toEqual([
          "connect",
          "send t1  carry on --json",
          "connect",
          "send tB /compact --json",
          "keys tB esc --json",
          "send tB /compact --json"
        ])
      }).pipe(Effect.provide(coreWith("prompts")))
    )

    alone.effect("types over a dialog that won't close", () =>
      Effect.gen(function* () {
        yield* fresh("forced")
        const sending = yield* Effect.forkChild((yield* Herdr).prompt(PaneId.make("wspA:ptC"), "go"))
        yield* Effect.yieldNow
        yield* stepUntilDone(sending)
        yield* Fiber.join(sending)
        const calls = yield* callsOf("forced")

        expect(calls.at(-1)).toBe("send tC  go --json --force")
      }).pipe(Effect.provide(coreWith("forced")))
    )

    alone.effect("starts an agent the app shows in a new space", () =>
      Effect.gen(function* () {
        const herdr = yield* Herdr
        const pane = yield* herdr.start({
          workspace: Option.some(WorkspaceId.make("wspA")),
          cwd: Directory.make("~/code/demo"),
          kind: "claude",
          name: AgentName.make("demo")
        })
        const odd = yield* Effect.flip(
          herdr.start({
            workspace: Option.none(),
            cwd: Directory.make("/srv"),
            kind: "claude",
            name: AgentName.make("odd")
          })
        )

        expect(pane.startsWith("wspA:pt8")).toBe(true)
        expect(odd.reason).toBe("unexpected terminal x/t9")
      }).pipe(Effect.provide(coreWith("starts")))
    )

    alone.effect("gives up on a core that doesn't answer in time, or isn't there", () =>
      Effect.gen(function* () {
        const reading = yield* Effect.forkChild(Effect.flip((yield* Herdr).read(PaneId.make("wspA:pt8"), 5)))
        yield* Effect.yieldNow
        yield* TestClock.adjust("6 seconds")
        const error = yield* Fiber.join(reading)

        expect(error.reason).toBe("no answer within 5s")
      }).pipe(Effect.provide(coreWith("slow")))
    )

    alone.effect("uses the core's default session when none is set", () =>
      Effect.gen(function* () {
        const snapshot = yield* (yield* Herdr).snapshot

        expect(snapshot.panes.length).toBe(5)
      }).pipe(
        Effect.provide(
          Herdr.core({ binary: hc, session: Option.none(), home }).pipe(Layer.provideMerge(BunServices.layer))
        )
      )
    )

    alone.effect("never starts a core: says the app isn't running when its socket is gone or it never ran", () =>
      Effect.gen(function* () {
        const stopped = yield* Effect.flip((yield* Herdr).snapshot)
        const never = yield* Effect.flip(
          Herdr.use((herdr) => herdr.snapshot).pipe(Effect.provide(coreWith("never-ran")))
        )
        const calls = yield* Effect.result(callsOf("stopped"))

        expect([stopped.reason, never.reason]).toEqual([
          "The Herdr app's core isn't running.",
          "The Herdr app's core isn't running."
        ])
        expect(calls._tag).toBe("Failure")
      }).pipe(Effect.provide(coreWith("stopped")))
    )

    alone.effect("says so when hc is missing", () =>
      Effect.gen(function* () {
        const error = yield* Effect.flip((yield* Herdr).snapshot)

        expect(error._tag).toBe("HerdrFailed")
      }).pipe(Effect.provide(coreWith("missing", "/nonexistent/hc")))
    )
  })
})
