import { Context, Duration, Effect, FileSystem, Layer, Schema, Stream } from "effect"
import type { PlatformError } from "effect"
import { Digest } from "effect/crypto"
import { Hex } from "effect/encoding"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { Revision } from "@sth-herdr/protocol/Connector.ts"
import type { ConnectorBundle } from "@sth-herdr/protocol/Connector.ts"

export class UpdateFailed extends Schema.TaggedError<UpdateFailed, { readonly brand: unique symbol }>()(
  "UpdateFailed",
  { reason: Schema.String }
) {
  override get message() {
    return `connector update failed: ${this.reason}`
  }
}

export class UpdateInstalled extends Schema.TaggedError<UpdateInstalled, { readonly brand: unique symbol }>()(
  "UpdateInstalled",
  { revision: Revision }
) {
  override get message() {
    return `installed connector ${this.revision.slice(0, 7)}; exiting so the service manager starts it`
  }
}

export class TrialFailed extends Schema.TaggedError<TrialFailed, { readonly brand: unique symbol }>()("TrialFailed", {
  revision: Revision
}) {
  override get message() {
    return `connector ${this.revision.slice(0, 7)} didn't reach the hub in time; the previous one is back in place`
  }
}

export const probeVariable = "HERDR_CONNECTOR_PROBE"

export type SelfUpdateSettings = {
  readonly file: string
  readonly bun: string
  readonly probeTimeout: Duration.Input
}

const decodeRevision = Schema.decodeUnknownEffect(Revision)

const failed = (reason: string) => new UpdateFailed({ reason })

const drained = (stream: Stream.Stream<Uint8Array, PlatformError.PlatformError>) => Stream.runDrain(stream)

const textOf = (stream: Stream.Stream<Uint8Array, PlatformError.PlatformError>) =>
  stream.pipe(Stream.decodeText(), Stream.mkString)

export class SelfUpdate extends Context.Service<
  SelfUpdate,
  {
    readonly revision: Revision
    readonly onTrial: boolean
    isRejected(revision: Revision): Effect.Effect<boolean>
    install(bundle: ConnectorBundle): Effect.Effect<void, UpdateFailed>
    readonly confirm: Effect.Effect<void>
    readonly rollBack: Effect.Effect<void, UpdateFailed>
  }
>()("sth-herdr/connector/SelfUpdate") {
  static readonly layer = (settings: SelfUpdateSettings) =>
    Layer.effect(
      SelfUpdate,
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const digests = yield* Digest.Digest
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
        const next = `${settings.file}.next`
        const previous = `${settings.file}.prev`
        const trial = `${settings.file}.trial`
        const rejected = `${settings.file}.rejected`

        const hashOf = (bytes: Uint8Array) =>
          digests
            .digest(Digest.sha256, bytes)
            .pipe(Effect.map(Hex.encode), Effect.flatMap(decodeRevision), Effect.orDie)

        const revision = yield* fs.readFile(settings.file).pipe(Effect.orDie, Effect.flatMap(hashOf))
        const onTrial = yield* fs.exists(trial).pipe(Effect.orDie)

        const isRejected = (candidate: Revision) =>
          fs.readFileString(rejected).pipe(
            Effect.map((text) => text.trim() === candidate),
            Effect.orElseSucceed(() => false)
          )

        const reject = (candidate: Revision) =>
          fs.writeFileString(rejected, candidate).pipe(Effect.ignore({ log: "Warn" }))

        const probe = Effect.gen(function* () {
          const handle = yield* spawner.spawn(
            ChildProcess.make(settings.bun, [next], { env: { [probeVariable]: "1" }, extendEnv: true })
          )
          const [, stderr, exitCode] = yield* Effect.all(
            [drained(handle.stdout), textOf(handle.stderr), handle.exitCode],
            { concurrency: "unbounded" }
          )
          if (exitCode === ChildProcessSpawner.ExitCode(0)) return true
          yield* Effect.logWarning("the new connector's probe run failed", { exitCode, stderr: stderr.slice(-800) })

          return false
        }).pipe(
          Effect.scoped,
          Effect.timeoutOrElse({
            duration: settings.probeTimeout,
            orElse: () => Effect.as(Effect.logWarning("the new connector's probe run didn't finish in time"), false)
          }),
          Effect.catchCause((cause) =>
            Effect.as(Effect.logWarning("couldn't start the new connector's probe run", cause), false)
          )
        )

        const swapIn = Effect.fn("SelfUpdate.swapIn")(function* (candidate: Revision) {
          yield* fs.copyFile(settings.file, previous)
          yield* fs.writeFileString(trial, candidate)
          yield* fs.rename(next, settings.file)
        })

        const install = Effect.fn("SelfUpdate.install")(function* (bundle: ConnectorBundle) {
          yield* Effect.annotateCurrentSpan({ "connector.revision": bundle.revision })
          const hash = yield* hashOf(new TextEncoder().encode(bundle.source))
          if (hash !== bundle.revision) return yield* failed("the bundle didn't match its hash")
          yield* fs.writeFileString(next, bundle.source).pipe(Effect.mapError((error) => failed(error.message)))
          const passed = yield* probe
          if (!passed) {
            yield* reject(bundle.revision)
            yield* fs.remove(next, { force: true }).pipe(Effect.ignore)
            return yield* failed("the new connector couldn't reach the hub, so it was set aside")
          }
          yield* swapIn(bundle.revision).pipe(Effect.mapError((error) => failed(error.message)))
          yield* Effect.logInfo("installed a new connector", { from: revision, to: bundle.revision })
        })

        const confirm = Effect.gen(function* () {
          const pending = yield* fs.exists(trial).pipe(Effect.orDie)
          if (!pending) return
          yield* fs.remove(trial, { force: true }).pipe(Effect.ignore({ log: "Warn" }))
          yield* Effect.logInfo("this connector reached the hub; keeping it", { revision })
        })

        const rollBack = Effect.gen(function* () {
          yield* fs.copyFile(previous, next)
          yield* fs.rename(next, settings.file)
          yield* fs.rename(trial, rejected)
          yield* Effect.logWarning("put the previous connector back", { rejected: revision })
        }).pipe(Effect.mapError((error) => failed(error.message)))

        return SelfUpdate.of({ revision, onTrial, isRejected, install, confirm, rollBack })
      })
    )
}
