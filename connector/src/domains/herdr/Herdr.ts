import { Context, Duration, Effect, FileSystem, Layer, Option, Path, Random, Schedule, Schema, Stream } from "effect"
import type { PlatformError } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { PaneId } from "@sth-herdr/protocol/Herdr.ts"
import type { AgentKind, AgentName, Directory, Key, Snapshot, WorkspaceId } from "@sth-herdr/protocol/Herdr.ts"
import type { PaneFormat } from "@sth-herdr/protocol/Connector.ts"
import {
  AppDocument,
  CoreError,
  ReadResult,
  ServerStatus,
  Started,
  TerminalList,
  asleepSession,
  isClaudeReady,
  sleepLabel,
  appDocument,
  claudePids,
  coreSnapshotOf,
  decodeClaudeSession,
  expandHome,
  firstLine,
  keysOfText,
  newPlace,
  paneIdOf,
  rpcLine,
  runArgs,
  terminalOf
} from "./Core.ts"
import { CreatedPane, HerdrError, RawSnapshot, snapshotOf } from "./Raw.ts"

export class HerdrFailed extends Schema.TaggedError<HerdrFailed, { readonly brand: unique symbol }>()("HerdrFailed", {
  command: Schema.String,
  reason: Schema.String,
  code: Schema.optionalKey(Schema.String)
}) {
  override get message() {
    return `herdr ${this.command} failed: ${this.reason}`
  }
}

export type HerdrSettings = {
  readonly binary: string
  readonly session: Option.Option<string>
  readonly home: string
}

type Failure = { readonly reason: string; readonly code?: string }

const collect = (stream: Stream.Stream<Uint8Array, PlatformError.PlatformError>) =>
  stream.pipe(Stream.decodeText(), Stream.mkString)

const plainFailure = (stderr: string, stdout: string): Failure => ({
  reason: (stderr.trim() || stdout.trim() || "no output").slice(-400)
})

const decodeError = Schema.decodeUnknownOption(Schema.fromJsonString(HerdrError))

const failureOf = (stderr: string, stdout: string): Failure =>
  Option.match(decodeError(stderr.trim()), {
    onNone: () => plainFailure(stderr, stdout),
    onSome: (error) => ({ reason: error.error.message, code: error.error.code })
  })

const decodeCoreError = Schema.decodeUnknownOption(Schema.fromJsonString(CoreError))

const coreErrorOf = (stderr: string, stdout: string): Option.Option<Failure> =>
  Option.map(decodeCoreError(firstLine(stderr.trim() || stdout.trim())), (error) => ({
    reason: error.error.message,
    code: error.error.kind
  }))

const coreFailureOf = (stderr: string, stdout: string): Failure =>
  Option.getOrElse(coreErrorOf(stderr, stdout), () => plainFailure(stderr, stdout))

type Run = {
  readonly command: string
  readonly binary: string
  readonly args: ReadonlyArray<string>
  readonly options: ChildProcess.CommandOptions
  readonly timeout: Duration.Input
  readonly failure: (stderr: string, stdout: string) => Failure
  readonly refused: (stderr: string, stdout: string) => Option.Option<Failure>
}

const never = (): Option.Option<Failure> => Option.none()

const spawned = Effect.fn("Herdr.run")(function* (run: Run) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const command = run.command
  yield* Effect.annotateCurrentSpan({ "herdr.command": command })
  const failed = (reason: string) => new HerdrFailed({ command, reason })
  const finished = Effect.gen(function* () {
    const handle = yield* spawner.spawn(ChildProcess.make(run.binary, run.args, run.options))
    const [stdout, stderr, exitCode] = yield* Effect.all(
      [collect(handle.stdout), collect(handle.stderr), handle.exitCode],
      { concurrency: "unbounded" }
    )
    if (exitCode !== ChildProcessSpawner.ExitCode(0))
      return yield* new HerdrFailed({ command, ...run.failure(stderr, stdout) })
    const refused = run.refused(stderr, stdout)
    if (Option.isSome(refused)) return yield* new HerdrFailed({ command, ...refused.value })

    return stdout
  }).pipe(Effect.scoped)

  return yield* finished.pipe(
    Effect.catchTag("PlatformError", (error) => Effect.fail(failed(error.message))),
    Effect.timeoutOrElse({
      duration: run.timeout,
      orElse: () => Effect.fail(failed(`no answer within ${Duration.format(Duration.fromInputUnsafe(run.timeout))}`))
    })
  )
})

const decoded =
  <A>(schema: Schema.Codec<A, unknown>, command: string) =>
  (text: string) =>
    Schema.decodeEffect(Schema.fromJsonString(schema))(text).pipe(
      Effect.mapError((error) => new HerdrFailed({ command, reason: `unexpected answer: ${error.message}` }))
    )

const isBlocked = (error: HerdrFailed): boolean => error.code === "agent_blocked"

const isCoreBlocked = (error: HerdrFailed): boolean => error.code === "blocked"

const isWaitingAtStart = (error: HerdrFailed): boolean => error.code === "agent_not_ready"

const startTimeout = Duration.seconds(40)

const commandMarks: ReadonlyArray<string> = ["/", "!"]

export const afterLeftover = (text: string): string =>
  commandMarks.some((mark) => text.startsWith(mark)) ? text : ` ${text}`

const freshPane = (workspace: Option.Option<WorkspaceId>, cwd: string, name: AgentName) =>
  Option.match(workspace, {
    onNone: () => ["workspace", "create", "--cwd", cwd, "--label", name, "--no-focus"],
    onSome: (id) => ["tab", "create", "--workspace", id, "--cwd", cwd, "--label", name, "--no-focus"]
  })

const readArgs = (pane: PaneId, lines: number, format: PaneFormat): ReadonlyArray<string> =>
  format === "ansi"
    ? ["pane", "read", pane, "--source", "visible", "--format", "ansi"]
    : ["pane", "read", pane, "--source", "recent-unwrapped", "--lines", String(lines)]

const largestInt = 2_147_483_647

const freshName = Effect.map(
  Effect.all([Random.nextIntBetween(0, largestInt), Random.nextIntBetween(0, largestInt)]),
  ([high, low]) => `${high.toString(36)}${low.toString(36)}`
)

type StartOptions = {
  readonly workspace: Option.Option<WorkspaceId>
  readonly cwd: Directory
  readonly kind: AgentKind
  readonly name: AgentName
}

export class Herdr extends Context.Service<
  Herdr,
  {
    readonly snapshot: Effect.Effect<Snapshot, HerdrFailed>
    read(pane: PaneId, lines: number, format?: PaneFormat): Effect.Effect<string, HerdrFailed>
    prompt(pane: PaneId, text: string): Effect.Effect<void, HerdrFailed>
    sendKeys(pane: PaneId, keys: ReadonlyArray<Key>): Effect.Effect<void, HerdrFailed>
    sendText(pane: PaneId, text: string): Effect.Effect<void, HerdrFailed>
    start(options: StartOptions): Effect.Effect<PaneId, HerdrFailed>
  }
>()("sth-herdr/connector/Herdr") {
  static readonly layer = (settings: HerdrSettings) =>
    Layer.effect(
      Herdr,
      Effect.gen(function* () {
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
        const fs = yield* FileSystem.FileSystem
        const session = Option.match(settings.session, { onNone: () => [], onSome: (name) => ["--session", name] })

        const run = (args: ReadonlyArray<string>, timeout: Duration.Input) =>
          spawned({
            command: args.slice(0, 2).join(" "),
            binary: settings.binary,
            args: [...session, ...args],
            options: {},
            timeout,
            failure: failureOf,
            refused: never
          }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner))

        const json = <A>(schema: Schema.Codec<A, unknown>, args: ReadonlyArray<string>, timeout: Duration.Input) =>
          run(args, timeout).pipe(Effect.flatMap(decoded(schema, args.slice(0, 2).join(" "))))

        const snapshot = json(RawSnapshot, ["api", "snapshot"], "5 seconds").pipe(
          Effect.map(snapshotOf),
          Effect.withSpan("Herdr.snapshot")
        )

        const read = Effect.fn("Herdr.read")(function* (pane: PaneId, lines: number, format: PaneFormat = "text") {
          return yield* run(readArgs(pane, lines, format), "5 seconds")
        })

        const sendKeys = Effect.fn("Herdr.sendKeys")(function* (pane: PaneId, keys: ReadonlyArray<Key>) {
          yield* run(["pane", "send-keys", pane, ...keys], "5 seconds")
        })

        const sendText = Effect.fn("Herdr.sendText")(function* (pane: PaneId, text: string) {
          yield* run(["pane", "send-text", pane, text], "5 seconds")
        })

        const submit = (pane: PaneId, text: string) => run(["agent", "prompt", pane, text], "15 seconds")

        const throughPanel = Effect.fn("Herdr.throughPanel")(function* (pane: PaneId, text: string) {
          yield* sendKeys(pane, ["esc"])
          yield* submit(pane, text).pipe(
            Effect.retry({ while: isBlocked, schedule: Schedule.spaced("500 millis"), times: 6 }),
            Effect.catchIf(isBlocked, () => sendText(pane, text).pipe(Effect.andThen(sendKeys(pane, ["enter"]))))
          )
        })

        const prompt = Effect.fn("Herdr.prompt")(function* (pane: PaneId, text: string) {
          const typed = afterLeftover(text)
          yield* submit(pane, typed).pipe(Effect.catchIf(isBlocked, () => throughPanel(pane, typed)))
        })

        const start = Effect.fn("Herdr.start")(function* (options: StartOptions) {
          const cwd = expandHome(options.cwd, settings.home)
          yield* fs.makeDirectory(cwd, { recursive: true }).pipe(Effect.ignore)
          const created = yield* json(CreatedPane, freshPane(options.workspace, cwd, options.name), "10 seconds")
          const pane = created.result.root_pane.pane_id
          yield* run(["agent", "start", options.name, "--kind", options.kind, "--pane", pane], startTimeout).pipe(
            Effect.retry({
              while: (error) => !isWaitingAtStart(error),
              schedule: Schedule.spaced("1 second"),
              times: 3
            }),
            Effect.catchIf(isWaitingAtStart, () => Effect.void)
          )

          return pane
        })

        return Herdr.of({ snapshot, read, prompt, sendKeys, sendText, start })
      })
    )

  static readonly core = (settings: HerdrSettings) =>
    Layer.effect(
      Herdr,
      Effect.gen(function* () {
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const environment = Option.match(settings.session, {
          onNone: (): ChildProcess.CommandOptions => ({}),
          onSome: (name): ChildProcess.CommandOptions => ({ env: { HC_SESSION: name }, extendEnv: true })
        })

        const run = (args: ReadonlyArray<string>, timeout: Duration.Input, options = environment) =>
          spawned({
            command: args.slice(0, 1).join(" "),
            binary: settings.binary,
            args,
            options,
            timeout,
            failure: coreFailureOf,
            refused: coreErrorOf
          }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner))

        const json = <A>(schema: Schema.Codec<A, unknown>, args: ReadonlyArray<string>, timeout: Duration.Input) =>
          run(args, timeout).pipe(Effect.flatMap(decoded(schema, args.slice(0, 1).join(" "))))

        const rpc = <A>(schema: Schema.Codec<A, unknown>, method: string, params: Record<string, unknown>) =>
          run(["connect"], "5 seconds", {
            ...environment,
            stdin: Stream.make(new TextEncoder().encode(rpcLine(method, params)))
          }).pipe(Effect.map(firstLine), Effect.flatMap(decoded(schema, method)))

        const sessionOfPid = (pid: number) =>
          fs.readFileString(path.join(settings.home, ".claude", "sessions", `${pid}.json`)).pipe(
            Effect.map((text) => Option.map(decodeClaudeSession(text), (found) => [pid, found.sessionId] as const)),
            Effect.orElseSucceed(() => Option.none<readonly [number, string]>())
          )

        const stateFolder = path.join(
          settings.home,
          ".local",
          "state",
          "herdr-core",
          Option.getOrElse(settings.session, () => "default")
        )

        const isRunning = fs.readFileString(path.join(stateFolder, "core.lock")).pipe(
          Effect.flatMap((socket) => fs.exists(path.resolve(stateFolder, socket.trim()))),
          Effect.orElseSucceed(() => false)
        )

        const notRunning = new HerdrFailed({ command: "connect", reason: "The Herdr app's core isn't running." })

        const snapshot = Effect.gen(function* () {
          const running = yield* isRunning
          if (!running) return yield* notRunning
          const [list, document, status] = yield* Effect.all(
            [
              rpc(TerminalList, "terminal.list", {}),
              rpc(AppDocument, "doc.get", { name: appDocument }),
              rpc(Schema.Struct({ result: ServerStatus }), "server.status", {})
            ],
            { concurrency: "unbounded" }
          )
          const terminals = list.result.terminals
          const found = yield* Effect.forEach(claudePids(terminals), sessionOfPid, { concurrency: 4 })
          const sessions = new Map(found.flatMap(Option.toArray))

          return coreSnapshotOf({
            version: status.result.version,
            terminals,
            spaces: document.result.value?.spaces ?? [],
            sessionOf: (pid) => Option.fromNullishOr(sessions.get(pid))
          })
        }).pipe(Effect.withSpan("Herdr.core.snapshot"))

        const read = Effect.fn("Herdr.core.read")(function* (pane: PaneId, lines: number) {
          const found = yield* json(
            ReadResult,
            ["read", terminalOf(pane), "--lines", String(lines), "--json"],
            "5 seconds"
          )

          return found.text
        })

        const sendKeys = Effect.fn("Herdr.core.sendKeys")(function* (pane: PaneId, keys: ReadonlyArray<Key>) {
          yield* run(["keys", terminalOf(pane), ...keys, "--json"], "5 seconds")
        })

        const sendText = Effect.fn("Herdr.core.sendText")(function* (pane: PaneId, text: string) {
          const keys = keysOfText(text)
          if (Option.isNone(keys))
            return yield* new HerdrFailed({ command: "keys", reason: "herdr-core can only type plain ASCII text" })
          yield* run(["keys", terminalOf(pane), ...keys.value, "--json"], "5 seconds")
        })

        const send = (pane: PaneId, text: string, force: boolean) =>
          run(["send", terminalOf(pane), text, "--json", ...(force ? ["--force"] : [])], "15 seconds")

        const throughDialog = Effect.fn("Herdr.core.throughDialog")(function* (pane: PaneId, text: string) {
          yield* sendKeys(pane, ["esc"])
          yield* send(pane, text, false).pipe(
            Effect.retry({ while: isCoreBlocked, schedule: Schedule.spaced("500 millis"), times: 6 }),
            Effect.catchIf(isCoreBlocked, () => send(pane, text, true))
          )
        })

        const terminalNamed = (pane: PaneId) =>
          rpc(TerminalList, "terminal.list", {}).pipe(
            Effect.map((list) =>
              Option.fromNullishOr(list.result.terminals.find((terminal) => terminal.address === terminalOf(pane)))
            )
          )

        const awake = (pane: PaneId) =>
          terminalNamed(pane).pipe(
            Effect.flatMap((found) =>
              Option.exists(found, isClaudeReady)
                ? Effect.void
                : new HerdrFailed({ command: "wake", reason: "still waking" })
            ),
            Effect.retry({ schedule: Schedule.spaced("1 second"), times: 45 }),
            Effect.mapError(
              () => new HerdrFailed({ command: "wake", reason: "The agent didn't wake within 45 seconds." })
            )
          )

        const wake = Effect.fn("Herdr.core.wake")(function* (pane: PaneId, session: string) {
          yield* run(["label", terminalOf(pane), `${sleepLabel}=`], "5 seconds")
          yield* send(pane, ` clear; claude --resume ${session}`, true)
          yield* awake(pane)
        })

        const prompt = Effect.fn("Herdr.core.prompt")(function* (pane: PaneId, text: string) {
          const found = yield* terminalNamed(pane)
          const asleep = Option.flatMap(found, asleepSession)
          if (Option.isSome(asleep)) yield* wake(pane, asleep.value)
          const typed = afterLeftover(text)
          yield* send(pane, typed, false).pipe(Effect.catchIf(isCoreBlocked, () => throughDialog(pane, typed)))
        })

        const start = Effect.fn("Herdr.core.start")(function* (options: StartOptions) {
          const fresh = yield* freshName
          const place = newPlace(options.workspace, fresh)
          const cwd = expandHome(options.cwd, settings.home)
          yield* fs.makeDirectory(cwd, { recursive: true }).pipe(Effect.ignore)
          const started = yield* json(
            Started,
            runArgs({ name: options.name, cwd, kind: options.kind, place }),
            "20 seconds"
          )

          return yield* Schema.decodeEffect(PaneId)(paneIdOf(place.space, started.address)).pipe(
            Effect.mapError(() => new HerdrFailed({ command: "run", reason: `unexpected terminal ${started.address}` }))
          )
        })

        return Herdr.of({ snapshot, read, prompt, sendKeys, sendText, start })
      })
    )
}
