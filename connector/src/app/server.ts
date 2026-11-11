import { BunCrypto, BunRuntime, BunServices } from "@effect/platform-bun"
import { Config, Deferred, Effect, FileSystem, Layer, Option, Path, Redacted, Schema } from "effect"
import { Agents } from "../domains/agents/Agents.ts"
import { Plain } from "../domains/plain/Plain.ts"
import { sourceNamesOf, sourcesOf, tuiBinaryOf, tuiSessionOf } from "./sources.ts"
import { SelfUpdate, TrialFailed, probeVariable } from "../domains/selfupdate/SelfUpdate.ts"
import { Transcript } from "../domains/transcript/Transcript.ts"
import { Uploads } from "../domains/uploads/Uploads.ts"
import { SlashCommands } from "../domains/slashcommands/SlashCommands.ts"
import { link, probe, updates } from "./Link.ts"
import type { HubSettings } from "./Link.ts"
import type { Revision } from "@sth-herdr/protocol/Connector.ts"

type Connect = (onHubReached: Effect.Effect<void>, revision: Option.Option<Revision>) => ReturnType<typeof link>

const bundleName = "sth-herdr-connector.js"
const checkForUpdatesEvery = "5 minutes"
const trialLimit = "1 minute"

const settings = Config.all({
  hubUrl: Config.option(Config.String("HERDR_HUB_URL")),
  tokenFile: Config.option(Config.String("HERDR_HUB_TOKEN_FILE")),
  host: Config.Literals(["herdr", "herdr-core"], "HERDR_HOST").pipe(Config.withDefault("herdr")),
  sources: Config.option(Config.String("HERDR_SOURCES")),
  binary: Config.option(Config.String("HERDR_BIN")),
  session: Config.option(Config.String("HERDR_SESSION")),
  coreBinary: Config.option(Config.String("HERDR_CORE_BIN")),
  coreSession: Config.option(Config.String("HERDR_CORE_SESSION")),
  home: Config.String("HOME"),
  probing: Config.option(Config.String(probeVariable))
})

class HubUnknown extends Schema.TaggedError<HubUnknown, { readonly brand: unique symbol }>()("HubUnknown", {
  file: Schema.String
}) {
  override get message() {
    return `Set HERDR_HUB_URL or write the hub's connector address (wss://<hub>/connector) to ${this.file}.`
  }
}

const isInstalled = (binary: string): boolean => Bun.which(binary) !== null

const runningBundle = Option.filter(Option.fromNullishOr(process.argv[1]), (file) => file.endsWith(bundleName))

const trialWatch = Effect.fn("Connector.trialWatch")(function* (reached: Deferred.Deferred<void>) {
  const self = yield* SelfUpdate
  if (!self.onTrial) return yield* Effect.never
  const inTime = yield* Deferred.await(reached).pipe(Effect.timeoutOption(trialLimit))
  if (Option.isSome(inTime)) return yield* Effect.never
  yield* self.rollBack

  return yield* new TrialFailed({ revision: self.revision })
})

const selfUpdating = (hub: HubSettings, connect: Connect, file: string) =>
  Effect.gen(function* () {
    const self = yield* SelfUpdate
    const reached = yield* Deferred.make<void>()
    const onHubReached = self.confirm.pipe(Effect.andThen(Deferred.succeed(reached, undefined)), Effect.asVoid)

    return yield* Effect.raceFirst(
      connect(onHubReached, Option.some(self.revision)),
      Effect.raceFirst(updates(hub, checkForUpdatesEvery), trialWatch(reached))
    )
  }).pipe(
    Effect.provide(
      SelfUpdate.layer({ file, bun: process.execPath, probeTimeout: trialLimit }).pipe(Layer.provide(BunCrypto.layer))
    )
  )

const program = Effect.gen(function* () {
  const config = yield* settings
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const tokenFile = Option.getOrElse(config.tokenFile, () => path.join(config.home, ".config", "sth-herdr", "token"))
  const token = Redacted.make((yield* fs.readFileString(tokenFile)).trim())
  const hubFile = path.join(config.home, ".config", "sth-herdr", "hub")
  const hubUrl = yield* Option.match(config.hubUrl, {
    onSome: Effect.succeed,
    onNone: () =>
      fs.readFileString(hubFile).pipe(
        Effect.map((text) => text.trim()),
        Effect.filterOrFail(
          (text) => text !== "",
          () => new HubUnknown({ file: hubFile })
        ),
        Effect.mapError(() => new HubUnknown({ file: hubFile }))
      )
  })
  const hub = { hubUrl, token }
  const names = sourceNamesOf(config, isInstalled)
  const agents = Agents.layer(sourcesOf(config, names, isInstalled)).pipe(Layer.provide(Plain.layer(config.home)))
  yield* Effect.logInfo("sources", { sources: names.join(", ") })

  if (Option.isSome(config.probing))
    return yield* Agents.use((found) => found.snapshot).pipe(Effect.andThen(probe(hub)), Effect.provide(agents))

  const connect: Connect = (onHubReached, revision) =>
    link({
      ...hub,
      pollEvery: "1 second",
      screens: { binary: tuiBinaryOf(config), session: tuiSessionOf(config), environment: process.env },
      revision,
      onHubReached
    })

  const running = Option.match(runningBundle, {
    onNone: () => connect(Effect.void, Option.none()),
    onSome: (file) => selfUpdating(hub, connect, file)
  })

  return yield* running.pipe(
    Effect.provide([
      agents,
      Transcript.layer(config.home),
      Uploads.layer(path.join(config.home, ".cache", "sth-herdr", "uploads")),
      SlashCommands.layer(config.home)
    ])
  )
})

program.pipe(Effect.provide(BunServices.layer), BunRuntime.runMain)
