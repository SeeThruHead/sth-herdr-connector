import { describe, expect, it } from "@effect/vitest"
import { Context, Effect, Exit, Layer, Option, Scope, Stream } from "effect"
import { ScreenId } from "@sth-herdr/protocol/Connector.ts"
import { Screens } from "./Screens.ts"

const screenOf = (n: number) => ScreenId.make(`019a4b5e-0000-7000-8000-${String(n).padStart(12, "0")}`)

const withScreens = (binary: string, session: Option.Option<string> = Option.none()) =>
  Screens.layer({ binary, session, environment: { LANG: "C.UTF-8", HERDR_ENV: "1" } })

const outputUntil = (screens: Screens["Service"], screen: ScreenId, done: (text: string) => boolean) =>
  screens.output.pipe(
    Stream.filter((chunk) => chunk.screen === screen),
    Stream.scan(
      (): { readonly text: string; readonly closed: boolean } => ({ text: "", closed: false }),
      (sofar, chunk) => ({ text: sofar.text + chunk.data, closed: chunk.closed })
    ),
    Stream.takeUntil((sofar) => done(sofar.text) || sofar.closed),
    Stream.runLast,
    Effect.map(Option.getOrThrow),
    Effect.timeout("5 seconds")
  )

describe("Herdr on a screen of its own", () => {
  it.effect("runs the program in a terminal, echoes what is typed, and says when it ends", () =>
    Effect.gen(function* () {
      const screens = yield* Screens
      const screen = screenOf(1)
      yield* screens.open(screen, 80, 24)
      yield* screens.resize(screen, 90, 30)
      yield* screens.input(screen, "héllo\r")
      expect((yield* outputUntil(screens, screen, (text) => text.includes("héllo"))).text).toContain("héllo")
      yield* screens.input(screen, "\u0004")
      const last = yield* outputUntil(screens, screen, () => false)
      const resized = yield* Effect.exit(screens.resize(screen, 80, 24))

      expect(last.closed).toBe(true)
      expect(Exit.isFailure(resized)).toBe(true)
    }).pipe(Effect.provide(withScreens("/bin/cat")))
  )

  it.effect("keeps to a handful of screens per machine and closes them all when the link ends", () =>
    Effect.gen(function* () {
      const scope = yield* Scope.make()
      const context = yield* Layer.buildWithScope(withScreens("/bin/cat"), scope)
      const screens = Context.get(context, Screens)
      yield* Effect.forEach([1, 2, 3, 4, 5, 6], (n) => screens.open(screenOf(n), 80, 24), { discard: true })
      const refused = yield* Effect.flip(screens.open(screenOf(7), 80, 24))
      expect(refused.reason).toBe("Herdr is already open in 6 places on this machine.")
      yield* Scope.close(scope, Exit.void)
    })
  )

  it.effect("says when the program can't start", () =>
    Effect.gen(function* () {
      const screens = yield* Screens
      const failed = yield* Effect.flip(screens.open(screenOf(9), 80, 24))
      expect(failed.reason).toMatch(/^herdr didn't start: /)
    }).pipe(Effect.provide(withScreens("/nonexistent/herdr")))
  )

  it.effect("attaches to the named Herdr session", () =>
    Effect.gen(function* () {
      const screens = yield* Screens
      const screen = screenOf(10)
      yield* screens.open(screen, 80, 24)
      const seen = yield* outputUntil(screens, screen, () => false)
      expect(seen.text).toContain("--session sthherdr-test")
      expect(seen.closed).toBe(true)
    }).pipe(
      Effect.provide(Screens.layer({ binary: "/bin/echo", session: Option.some("sthherdr-test"), environment: {} }))
    )
  )
})
