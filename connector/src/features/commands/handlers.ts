import { Effect, Match, Option, Schedule, Schema } from "effect"
import type { HubCommand, Outcome } from "@sth-herdr/protocol/Connector.ts"
import type { PaneId, Snapshot } from "@sth-herdr/protocol/Herdr.ts"
import { Agents } from "../../domains/agents/Agents.ts"
import { Screens } from "../../domains/screens/Screens.ts"
import { Transcript } from "../../domains/transcript/Transcript.ts"
import { Uploads, withAttached } from "../../domains/uploads/Uploads.ts"
import { SlashCommands } from "../../domains/slashcommands/SlashCommands.ts"

const done: Outcome = { _tag: "Done" }

class AgentNotReady extends Schema.TaggedError<AgentNotReady, { readonly brand: unique symbol }>()("AgentNotReady", {
  pane: Schema.String
}) {}

const ownWords: ReadonlySet<string> = new Set(["ScreenFailed", "UploadFailed"])

const agentIn = (snapshot: Snapshot, pane: PaneId) => {
  const found = Option.fromNullishOr(snapshot.panes.find((candidate) => candidate.id === pane))

  return Option.flatMap(found, (candidate) =>
    Option.map(candidate.agent, (agent) => ({ agent, session: candidate.session, cwd: candidate.cwd }))
  )
}

const isMissing = (error: { readonly _tag: string }): boolean => error._tag === "NoSuchElementError"

const conversation = Effect.fn("Commands.conversation")(function* (pane: PaneId, limit: number) {
  const herdr = yield* Agents
  const transcripts = yield* Transcript
  const running = yield* herdr.snapshot.pipe(
    Effect.map((snapshot) => agentIn(snapshot, pane)),
    Effect.flatMap(Effect.fromOption),
    Effect.retry({ while: isMissing, schedule: Schedule.spaced("300 millis"), times: 5 }),
    Effect.catchNoSuchElement
  )
  if (Option.isNone(running))
    return { _tag: "Refused", reason: "No agent is running in that pane now." } satisfies Outcome
  const transcript = yield* transcripts.read(running.value, limit)

  return { _tag: "TranscriptRead", transcript } satisfies Outcome
})

const slashCommands = Effect.fn("Commands.slashCommands")(function* (pane: PaneId) {
  const herdr = yield* Agents
  const slash = yield* SlashCommands
  const snapshot = yield* herdr.snapshot
  const found = snapshot.panes.find((candidate) => candidate.id === pane)
  if (found === undefined) return { _tag: "Refused", reason: "That pane isn't open now." } satisfies Outcome

  return { _tag: "CommandsListed", commands: yield* slash.list(found.cwd) } satisfies Outcome
})

const resting: ReadonlyArray<string> = ["idle", "done"]

const readyIn = (snapshot: Snapshot, pane: PaneId): boolean =>
  snapshot.panes.some((candidate) => candidate.id === pane && resting.includes(candidate.status))

const firstMessage = Effect.fn("Commands.firstMessage")(
  function* (pane: PaneId, task: string) {
    const herdr = yield* Agents
    yield* herdr.snapshot.pipe(
      Effect.flatMap((snapshot) => (readyIn(snapshot, pane) ? Effect.void : new AgentNotReady({ pane }))),
      Effect.retry({ schedule: Schedule.spaced("1 second"), times: 90 })
    )
    yield* herdr.prompt(pane, task)
  },
  Effect.catchCause((cause) => Effect.logWarning("couldn't give a new agent its first message", cause))
)

const startWithTask = Effect.fn("Commands.start")(function* (start: Extract<HubCommand, { _tag: "StartAgent" }>) {
  const herdr = yield* Agents
  const pane = yield* herdr.start(start)
  if (start.task !== undefined) yield* Effect.forkDetach(firstMessage(pane, start.task))

  return { _tag: "Started", pane } satisfies Outcome
})

export const execute = Effect.fn("Commands.execute")(function* (command: HubCommand) {
  const herdr = yield* Agents
  const screens = yield* Screens
  const uploads = yield* Uploads
  yield* Effect.annotateCurrentSpan({ "command.kind": command._tag })

  const outcome = Match.valueTags(command, {
    ReadPane: ({ pane, lines, format }) =>
      Effect.map(herdr.read(pane, lines, format), (text): Outcome => ({ _tag: "PaneText", text })),
    Prompt: ({ pane, text, files }) =>
      uploads.save(files ?? []).pipe(
        Effect.flatMap((paths) => herdr.prompt(pane, withAttached(text, paths))),
        Effect.as(done)
      ),
    SendKeys: ({ pane, keys }) => Effect.as(herdr.sendKeys(pane, keys), done),
    SendText: ({ pane, text }) => Effect.as(herdr.sendText(pane, text), done),
    StartAgent: (start) => startWithTask(start),
    ReadTranscript: ({ pane, limit }) => conversation(pane, limit),
    OpenScreen: ({ screen, cols, rows }) => Effect.as(screens.open(screen, cols, rows), done),
    ScreenInput: ({ screen, data }) => Effect.as(screens.input(screen, data), done),
    ResizeScreen: ({ screen, cols, rows }) => Effect.as(screens.resize(screen, cols, rows), done),
    CloseScreen: ({ screen }) => Effect.as(screens.close(screen), done),
    ListCommands: ({ pane }) => slashCommands(pane)
  })

  return yield* outcome.pipe(
    Effect.catch((error) =>
      Effect.succeed<Outcome>({ _tag: "Refused", reason: ownWords.has(error._tag) ? error.reason : error.message })
    )
  )
})
