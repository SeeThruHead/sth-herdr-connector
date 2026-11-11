import { Context, Effect, HashMap, Layer, Option, Ref } from "effect"
import type { PaneId, SourceName } from "@sth-herdr/protocol/Herdr.ts"
import { AgentsFailed, fresh, merged, seenAfter } from "./Source.ts"
import type { Host, Memory, Source, SourceError, StartOptions } from "./Source.ts"

export type StartWith = StartOptions & { readonly source?: SourceName | undefined }

export type AgentsShape = Omit<Host, "start"> & {
  readonly sources: ReadonlyArray<SourceName>
  start(options: StartWith): Effect.Effect<PaneId, SourceError>
}

const starters: ReadonlyArray<string> = ["herdr", "herdr-core"]

const chooseStarter = (built: ReadonlyArray<Source>, wanted: SourceName | undefined): Option.Option<Source> =>
  Option.fromNullishOr(
    wanted === undefined
      ? built.find((source) => starters.includes(source.name))
      : built.find((source) => source.name === wanted)
  )

export class Agents extends Context.Service<Agents, AgentsShape>()("sth-herdr/connector/Agents") {
  static readonly layer = <R>(sources: ReadonlyArray<Effect.Effect<Source, never, R>>) =>
    Layer.effect(
      Agents,
      Effect.gen(function* () {
        const built = yield* Effect.all(sources)
        const memories = yield* Ref.make(HashMap.empty<SourceName, Memory>())
        const owners = yield* Ref.make(HashMap.empty<string, Source>())

        const look = Effect.fnUntraced(function* (source: Source) {
          const found = yield* Effect.result(source.snapshot)
          const remembered = yield* Ref.get(memories)
          const next = seenAfter(
            source,
            Option.getOrElse(HashMap.get(remembered, source.name), () => fresh),
            found
          )
          yield* Ref.update(memories, HashMap.set(source.name, next.memory))

          return next.seen
        })

        const snapshot = Effect.gen(function* () {
          const seen = yield* Effect.forEach(built, look, { concurrency: "unbounded" })
          const result = merged(seen)
          const owned = seen.flatMap((found) =>
            Option.toArray(found.snapshot).flatMap((taken) =>
              taken.panes.map((pane) => [pane.id, found.source] as const)
            )
          )
          yield* Ref.set(owners, HashMap.fromIterable(owned))

          return result
        }).pipe(Effect.withSpan("Agents.snapshot"))

        const ownerOf = Effect.fnUntraced(function* (command: string, pane: PaneId) {
          const before = yield* Ref.get(owners)
          const known = HashMap.get(before, pane)
          if (Option.isSome(known)) return known.value
          yield* snapshot
          const after = yield* Ref.get(owners)
          const found = HashMap.get(after, pane)
          const owner = Option.orElse(found, () => chooseStarter(built, undefined))
          if (Option.isNone(owner)) return yield* new AgentsFailed({ command, reason: "That pane isn't open now." })

          return owner.value
        })

        const start = (options: StartWith) =>
          Option.match(chooseStarter(built, options.source), {
            onNone: () =>
              Effect.fail(
                new AgentsFailed({ command: "start", reason: "This machine has nowhere to start an agent." })
              ),
            onSome: (source) => source.start(options)
          })

        return Agents.of({
          sources: built.map((source) => source.name),
          snapshot,
          read: (pane, lines, format) =>
            Effect.flatMap(ownerOf("read", pane), (source) => source.read(pane, lines, format)),
          prompt: (pane, text) => Effect.flatMap(ownerOf("prompt", pane), (source) => source.prompt(pane, text)),
          sendKeys: (pane, keys) => Effect.flatMap(ownerOf("keys", pane), (source) => source.sendKeys(pane, keys)),
          sendText: (pane, text) => Effect.flatMap(ownerOf("text", pane), (source) => source.sendText(pane, text)),
          start
        })
      })
    )
}
