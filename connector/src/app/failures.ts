import { Effect, Option } from "effect"
import type { AgentStatus, Pane, Snapshot } from "@sth-herdr/protocol/Herdr.ts"
import { Transcript } from "../domains/transcript/Transcript.ts"
import type { Glance } from "../domains/transcript/Transcript.ts"

const resting: ReadonlyArray<AgentStatus> = ["idle", "done", "asleep", "unknown"]

const withActive = (pane: Pane, glance: Glance): Pane =>
  Option.match(glance.active, { onNone: () => pane, onSome: (active) => ({ ...pane, active }) })

const withFailure = (pane: Pane, glance: Glance): Pane => {
  if (!resting.includes(pane.status)) return pane

  return Option.match(glance.failure, {
    onNone: () => pane,
    onSome: (text) => ({ ...pane, status: "errored", failure: text })
  })
}

const marked = (transcripts: Transcript["Service"]) => (pane: Pane) => {
  if (Option.isNone(pane.agent)) return Effect.succeed(pane)

  return transcripts
    .glance({ agent: pane.agent.value, session: pane.session, cwd: pane.cwd })
    .pipe(Effect.map((glance) => withFailure(withActive(pane, glance), glance)))
}

export const withFailures = Effect.fn("Connector.withFailures")(function* (snapshot: Snapshot) {
  const transcripts = yield* Transcript
  const panes = yield* Effect.forEach(snapshot.panes, marked(transcripts), { concurrency: 4 })

  return { ...snapshot, panes }
})
