import { Context, Effect, HashMap, Layer, Option, Queue, Ref, Schema, Stream } from "effect"
import type { ScreenId } from "@sth-herdr/protocol/Connector.ts"

export class ScreenFailed extends Schema.TaggedError<ScreenFailed, { readonly brand: unique symbol }>()(
  "ScreenFailed",
  { reason: Schema.String }
) {}

export type ScreenChunk = { readonly screen: ScreenId; readonly data: string; readonly closed: boolean }

export type ScreenSettings = {
  readonly binary: string
  readonly session: Option.Option<string>
  readonly environment: Readonly<Record<string, string | undefined>>
}

type Live = { readonly terminal: Bun.Terminal; readonly process: Bun.Subprocess }

const mostOpen = 6

const missing = new ScreenFailed({ reason: "That Herdr screen isn't open." })

export class Screens extends Context.Service<
  Screens,
  {
    open(screen: ScreenId, cols: number, rows: number): Effect.Effect<void, ScreenFailed>
    input(screen: ScreenId, data: string): Effect.Effect<void, ScreenFailed>
    resize(screen: ScreenId, cols: number, rows: number): Effect.Effect<void, ScreenFailed>
    close(screen: ScreenId): Effect.Effect<void>
    readonly output: Stream.Stream<ScreenChunk>
  }
>()("sth-herdr/connector/Screens") {
  static readonly layer = (settings: ScreenSettings) =>
    Layer.effect(
      Screens,
      Effect.gen(function* () {
        const chunks = yield* Queue.unbounded<ScreenChunk>()
        const screens = yield* Ref.make(HashMap.empty<ScreenId, Live>())
        const session = Option.match(settings.session, { onNone: () => [], onSome: (name) => ["--session", name] })
        const environment = {
          ...Object.fromEntries(Object.entries(settings.environment).filter(([name]) => !name.startsWith("HERDR_"))),
          TERM: "xterm-256color",
          COLORTERM: "truecolor",
          LANG: settings.environment["LANG"] ?? "en_US.UTF-8"
        }

        const live = (screen: ScreenId) =>
          Effect.flatMap(Ref.get(screens), (all) =>
            Effect.fromOption(HashMap.get(all, screen)).pipe(Effect.mapError(() => missing))
          )

        const spawn = (screen: ScreenId, cols: number, rows: number): Live => {
          const decoder = new TextDecoder()
          const terminal = new Bun.Terminal({
            cols,
            rows,
            name: "xterm-256color",
            data: (_terminal, bytes) => {
              Queue.offerUnsafe(chunks, { screen, data: decoder.decode(bytes, { stream: true }), closed: false })
            },
            exit: () => {
              Queue.offerUnsafe(chunks, { screen, data: "", closed: true })
            }
          })
          const process = Bun.spawn([settings.binary, ...session], { terminal, env: environment })

          return { terminal, process }
        }

        const stop = (screen: Live) =>
          Effect.sync(() => {
            screen.process.kill()
            screen.terminal.close()
          })

        const close = Effect.fn("Screens.close")(function* (screen: ScreenId) {
          const found = yield* Ref.modify(screens, (all) => [HashMap.get(all, screen), HashMap.remove(all, screen)])
          if (Option.isSome(found)) yield* stop(found.value)
        })

        const open = Effect.fn("Screens.open")(function* (screen: ScreenId, cols: number, rows: number) {
          const running = yield* Ref.get(screens)
          if (HashMap.size(running) >= mostOpen)
            return yield* new ScreenFailed({ reason: `Herdr is already open in ${mostOpen} places on this machine.` })
          const started = yield* Effect.try({
            try: () => spawn(screen, cols, rows),
            catch: (cause) => new ScreenFailed({ reason: `herdr didn't start: ${String(cause)}` })
          })
          yield* Ref.update(screens, HashMap.set(screen, started))
          yield* Effect.forkDetach(
            Effect.promise(() => started.process.exited).pipe(
              Effect.andThen(Ref.update(screens, HashMap.remove(screen))),
              Effect.andThen(Effect.sync(() => started.terminal.close())),
              Effect.andThen(Queue.offer(chunks, { screen, data: "", closed: true }))
            )
          )
        })

        const input = Effect.fn("Screens.input")(function* (screen: ScreenId, data: string) {
          const found = yield* live(screen)
          found.terminal.write(data)
        })

        const resize = Effect.fn("Screens.resize")(function* (screen: ScreenId, cols: number, rows: number) {
          const found = yield* live(screen)
          found.terminal.resize(cols, rows)
        })

        yield* Effect.addFinalizer(() =>
          Effect.flatMap(Ref.get(screens), (all) => Effect.forEach(HashMap.values(all), stop, { discard: true }))
        )

        return Screens.of({ open, input, resize, close, output: Stream.fromQueue(chunks) })
      })
    )
}
