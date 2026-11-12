import { BunSocket } from "@effect/platform-bun"
import { Duration, Effect, Layer, Option, Redacted, Schedule, Schema, Stream } from "effect"
import { RpcClient, RpcSerialization } from "effect/rpc"
import type { RpcClientError } from "effect/rpc"
import { Socket } from "effect/socket"
import { ConnectorRpcs } from "@sth-herdr/protocol/Connector.ts"
import type { Revision } from "@sth-herdr/protocol/Connector.ts"
import { Snapshot } from "@sth-herdr/protocol/Herdr.ts"
import { Agents } from "../domains/agents/Agents.ts"
import { SelfUpdate, UpdateInstalled } from "../domains/selfupdate/SelfUpdate.ts"
import { Screens } from "../domains/screens/Screens.ts"
import type { ScreenChunk, ScreenSettings } from "../domains/screens/Screens.ts"
import { execute } from "../features/commands/handlers.ts"
import { withFailures } from "./failures.ts"

export const connectorVersion = "0.3.0"

export type HubSettings = { readonly hubUrl: string; readonly token: Redacted.Redacted }

export type LinkSettings = HubSettings & {
  readonly pollEvery: Duration.Input
  readonly screens: ScreenSettings
  readonly revision: Option.Option<Revision>
  readonly onHubReached: Effect.Effect<void>
}

type Hub = RpcClient.FromGroup<typeof ConnectorRpcs, RpcClientError.RpcClientError>

const joined = (chunks: ReadonlyArray<ScreenChunk>, chunk: ScreenChunk): ReadonlyArray<ScreenChunk> => {
  const last = chunks.at(-1)
  if (last === undefined) return [chunk]
  if (last.screen !== chunk.screen) return [...chunks, chunk]
  if (last.closed) return [...chunks, chunk]

  return [...chunks.slice(0, -1), { ...chunk, data: `${last.data}${chunk.data}` }]
}

const coalesced = (batch: Iterable<ScreenChunk>): ReadonlyArray<ScreenChunk> => Array.from(batch).reduce(joined, [])

const sameSnapshot = Schema.toEquivalence(Snapshot)

const protocol = (settings: HubSettings) =>
  RpcClient.layerProtocolSocket({ pingInterval: "10 seconds", pingTimeout: "30 seconds" }).pipe(
    Layer.provide(Layer.effect(Socket.Socket, Socket.makeWebSocket(settings.hubUrl, { openTimeout: "10 seconds" }))),
    Layer.provide([BunSocket.layerWebSocketConstructor, RpcSerialization.layerNdjson])
  )

const session = Effect.fn("Link.session")(function* (settings: LinkSettings) {
  const herdr = yield* Agents
  const screens = yield* Screens
  const hub = yield* RpcClient.make(ConnectorRpcs)
  const look = Effect.flatMap(herdr.snapshot, withFailures)
  const first = yield* look

  const reports = Stream.make(first).pipe(
    Stream.concat(Stream.fromEffectSchedule(look, Schedule.spaced(settings.pollEvery))),
    Stream.changesWith(sameSnapshot),
    Stream.drop(1),
    Stream.runForEach((snapshot) => hub.Report({ snapshot }))
  )

  const revision = Option.match(settings.revision, { onNone: () => ({}), onSome: (found) => ({ revision: found }) })
  const commands = hub
    .Attach({ connectorVersion, snapshot: first, ...revision })
    .pipe(
      Stream.runForEach((command) =>
        Effect.forkScoped(Effect.flatMap(execute(command), (outcome) => hub.Answer({ id: command.id, outcome })))
      )
    )

  const output = screens.output.pipe(
    Stream.groupedWithin(256, "16 millis"),
    Stream.flatMap((batch) => Stream.fromIterable(coalesced(batch))),
    Stream.runForEach((chunk) => hub.ScreenOutput(chunk))
  )

  yield* Effect.logInfo("connected to the hub", { hub: settings.hubUrl, herdr: first.herdrVersion })
  yield* Effect.forkScoped(
    hub.Probe().pipe(
      Effect.andThen(settings.onHubReached),
      Effect.catchCause((cause) => Effect.logDebug("the hub didn't answer a probe", cause))
    )
  )

  return yield* Effect.raceFirst(commands, Effect.raceFirst(reports, output))
})

const backoff = Schedule.exponential("1 second").pipe(
  Schedule.modifyDelay(({ output }) => Effect.succeed(Duration.min(output, Duration.seconds(30))))
)

export const link = (settings: LinkSettings) =>
  session(settings).pipe(
    Effect.provide(Screens.layer(settings.screens)),
    Effect.scoped,
    RpcClient.withHeaders({ authorization: `Bearer ${Redacted.value(settings.token)}` }),
    Effect.provide(protocol(settings)),
    Effect.tapCause((cause) => Effect.logWarning("hub link dropped; reconnecting", cause)),
    Effect.sandbox,
    Effect.retry(backoff),
    Effect.repeat(Schedule.spaced("2 seconds"))
  )

const withHub = <A, E, R>(settings: HubSettings, use: (hub: Hub) => Effect.Effect<A, E, R>) =>
  RpcClient.make(ConnectorRpcs).pipe(
    Effect.flatMap(use),
    Effect.scoped,
    RpcClient.withHeaders({ authorization: `Bearer ${Redacted.value(settings.token)}` }),
    Effect.provide(protocol(settings))
  )

export const probe = (settings: HubSettings) =>
  withHub(settings, (hub) => hub.Probe()).pipe(
    Effect.timeout("30 seconds"),
    Effect.tap(() => Effect.logInfo("probe reached the hub", { hub: settings.hubUrl }))
  )

const check = Effect.fn("Link.checkForUpdate")(function* (settings: HubSettings) {
  const self = yield* SelfUpdate
  const latest = yield* withHub(settings, (hub) => hub.LatestConnector())
  if (Option.isNone(latest)) return
  if (latest.value === self.revision) return
  if (yield* self.isRejected(latest.value)) return
  yield* Effect.logInfo("the hub has a newer connector", { running: self.revision, latest: latest.value })
  const bundle = yield* withHub(settings, (hub) => hub.DownloadConnector())
  yield* self.install(bundle)

  return yield* new UpdateInstalled({ revision: bundle.revision })
})

export const updates = (settings: HubSettings, every: Duration.Input) =>
  check(settings).pipe(
    Effect.catchIf(
      (error) => error._tag !== "UpdateInstalled",
      (error) => Effect.logWarning("couldn't check the hub for a newer connector", error)
    ),
    Effect.catchDefect((defect) => Effect.logWarning("couldn't check the hub for a newer connector", defect)),
    Effect.repeat(Schedule.spaced(every)),
    Effect.andThen(Effect.never)
  )
