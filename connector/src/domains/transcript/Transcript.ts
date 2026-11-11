import { Array as Arr, Clock, Context, Effect, Layer, Option, Ref, Schema } from "effect"
import { Base64 } from "effect/encoding"
import type { Item, Picture, Transcript as Read } from "@sth-herdr/protocol/Transcript.ts"
import { Database } from "bun:sqlite"
import { noteOf, partsOf, pictureLimit } from "./Claude.ts"
import type { Attached, Part } from "./Claude.ts"
import * as OpenCode from "./OpenCode.ts"
import * as Pi from "./Pi.ts"

export class TranscriptMissing extends Schema.TaggedError<TranscriptMissing, { readonly brand: unique symbol }>()(
  "TranscriptMissing",
  { reason: Schema.String }
) {
  override get message() {
    return this.reason
  }
}

const SessionId = Schema.String.check(Schema.isUUID())

const isSession = Schema.is(SessionId)

const unreadable = <A>(read: () => Promise<A>) =>
  Effect.tryPromise({
    try: read,
    catch: () => new TranscriptMissing({ reason: "The conversation file couldn't be read." })
  })

const imageTypes: Readonly<Record<string, Picture["mediaType"]>> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp"
}

const imageTypeOf = (path: string): Option.Option<Picture["mediaType"]> =>
  Option.fromNullishOr(imageTypes[path.replace(/^.*\./, "").toLowerCase()])

const uploaded = (uploads: string, path: string): boolean => {
  if (!path.startsWith(uploads)) return false

  return !path.includes("..")
}

const shown =
  (uploads: string) =>
  (part: Part): Effect.Effect<Item> => {
    if (part._tag !== "Attached") return Effect.succeed(part)
    const mediaType = imageTypeOf(part.path)
    if (Option.isNone(mediaType)) return Effect.succeed(noteOf(part))
    if (!uploaded(uploads, part.path)) return Effect.succeed(noteOf(part))

    return picture(part, mediaType.value)
  }

const picture = (part: Attached, mediaType: Picture["mediaType"]): Effect.Effect<Item> =>
  Effect.tryPromise({
    try: () => Bun.file(part.path).bytes(),
    catch: () => new TranscriptMissing({ reason: `${part.name} couldn't be read.` })
  }).pipe(
    Effect.map((bytes) => Base64.encode(bytes)),
    Effect.map((base64): Item =>
      base64.length > pictureLimit ? noteOf(part) : { _tag: "Picture", id: part.id, mediaType, base64 }
    ),
    Effect.orElseSucceed(() => noteOf(part))
  )

const afterFirstLine = (text: string): string => text.slice(text.indexOf("\n") + 1)

const continuationHeadBytes = 2_000_000

const newerSessions = (folder: string, since: number) =>
  unreadable(() => Array.fromAsync(new Bun.Glob("*.jsonl").scan({ cwd: folder }))).pipe(
    Effect.map((names) =>
      names
        .map((name) => Bun.file(`${folder}/${name}`))
        .filter((file) => file.lastModified > since)
        .toSorted((left, right) => right.lastModified - left.lastModified)
    )
  )

const continues = (session: string) => (file: Bun.BunFile) =>
  unreadable(() => file.slice(0, continuationHeadBytes).text()).pipe(Effect.map((head) => head.includes(session)))

const latestOf = (folder: string, session: string, file: Bun.BunFile) =>
  newerSessions(folder, file.lastModified).pipe(
    Effect.flatMap((newer) => Effect.findFirst(newer, continues(session))),
    Effect.map(Option.getOrElse(() => file))
  )

export type Running = { readonly agent: string; readonly session: Option.Option<string>; readonly cwd: string }

type Found = { readonly session: string; readonly parts: ReadonlyArray<Part>; readonly cut: boolean }

const missing = (reason: string) => new TranscriptMissing({ reason })

const tailOf = Effect.fn("Transcript.tailOf")(function* (file: Bun.BunFile, tailBytes: number) {
  const start = Math.max(0, file.size - tailBytes)
  const text = yield* unreadable(() => file.slice(start).text())

  return { text: start > 0 ? afterFirstLine(text) : text, cut: start > 0 }
})

const claudeFile = Effect.fn("Transcript.claudeFile")(function* (home: string, running: Running) {
  if (Option.isNone(running.session)) return yield* missing("Herdr doesn't know this Claude session yet.")
  const session = running.session.value
  if (!isSession(session)) return yield* missing("The agent's session id isn't a UUID.")
  const glob = new Bun.Glob(`*/${session}.jsonl`)
  const found = yield* unreadable(() => Array.fromAsync(glob.scan({ cwd: `${home}/.claude/projects` })))
  const path = Option.fromNullishOr(found[0])
  if (Option.isNone(path)) return yield* missing("Claude hasn't written this conversation yet.")
  const folder = `${home}/.claude/projects/${path.value.slice(0, path.value.lastIndexOf("/"))}`
  const file = yield* latestOf(folder, session, Bun.file(`${home}/.claude/projects/${path.value}`))

  return { session, file }
})

const claude = Effect.fn("Transcript.claude")(function* (home: string, tailBytes: number, running: Running) {
  const { session, file } = yield* claudeFile(home, running)
  const { text, cut } = yield* tailOf(file, tailBytes)

  return { session, parts: partsOf(text), cut } satisfies Found
})

const piSession = (home: string, path: string): boolean => {
  if (!path.startsWith(`${home}/.pi/agent/sessions/`)) return false
  if (path.includes("..")) return false

  return path.endsWith(".jsonl")
}

const piFile = (home: string, running: Running): Effect.Effect<string, TranscriptMissing> => {
  if (Option.isNone(running.session)) return Effect.fail(missing("Herdr doesn't know this Pi session yet."))
  if (!piSession(home, running.session.value))
    return Effect.fail(missing("The Pi session isn't in Pi's sessions folder."))

  return Effect.succeed(running.session.value)
}

const pi = Effect.fn("Transcript.pi")(function* (home: string, tailBytes: number, running: Running) {
  const session = yield* piFile(home, running)
  const { text, cut } = yield* tailOf(Bun.file(session), tailBytes)

  return { session, parts: Pi.partsOf(text), cut } satisfies Found
})

const latestSession = `
  SELECT id FROM session_v2
  WHERE directory = ? AND parent_id IS NULL AND time_archived IS NULL
  ORDER BY time_updated DESC LIMIT 1`

const lastMessages = `
  SELECT id, type, data FROM session_message
  WHERE session_id = ? ORDER BY seq DESC LIMIT ?`

const openCodeRead = (database: Database, cwd: string, rows: number): Option.Option<Found> => {
  const session = database.query<{ readonly id: string }, [string]>(latestSession).get(cwd)
  if (session === null) return Option.none()
  const found = database.query<OpenCode.Row, [string, number]>(lastMessages).all(session.id, rows + 1)

  return Option.some({
    session: session.id,
    parts: OpenCode.partsOf(found.slice(0, rows).toReversed()),
    cut: found.length > rows
  })
}

const openCode = Effect.fn("Transcript.openCode")(function* (home: string, running: Running, limit: number) {
  const found = yield* Effect.acquireUseRelease(
    Effect.try({
      try: () => new Database(`${home}/.local/share/opencode/opencode.db`, { readonly: true }),
      catch: () => missing("OpenCode's database couldn't be opened.")
    }),
    (database) =>
      Effect.try({
        try: () => openCodeRead(database, running.cwd, limit),
        catch: () => missing("OpenCode's database couldn't be read.")
      }),
    (database) => Effect.sync(() => database.close())
  )
  if (Option.isNone(found)) return yield* missing("OpenCode hasn't written a conversation in this folder yet.")

  return found.value
})

export const lastFailure = (parts: ReadonlyArray<Part>): Option.Option<string> =>
  Option.flatMap(Arr.last(parts), (part) =>
    part._tag === "Said" && part.failed === true ? Option.some(part.markdown) : Option.none()
  )

const failureTail = 65_536

const relocateEvery = 30_000

export type Glance = { readonly failure: Option.Option<string>; readonly active: Option.Option<number> }

type Remembered = { readonly stamp: string; readonly glance: Glance }

type Located = { readonly file: string; readonly at: number }

const statOf = (path: string): Promise<string> =>
  Bun.file(path)
    .stat()
    .then((found) => `${found.size}:${found.mtimeMs}`)
    .catch(() => "-")

const stampOf = (paths: ReadonlyArray<string>) =>
  Effect.promise(() => Promise.all(paths.map(statOf))).pipe(Effect.map((stamps) => stamps.join("|")))

const Spoken = Schema.Struct({
  type: Schema.Literals(["user", "assistant", "message"]),
  timestamp: Schema.String,
  isMeta: Schema.optionalKey(Schema.NullOr(Schema.Boolean))
})

const decodeSpoken = Schema.decodeUnknownOption(Schema.fromJsonString(Spoken))

const spokenAt = (line: string): Option.Option<number> =>
  Option.flatMap(
    Option.filter(decodeSpoken(line), (spoken) => spoken.isMeta !== true),
    (spoken) => Option.liftPredicate(Date.parse(spoken.timestamp), Number.isFinite)
  )

export const lastSpoke = (text: string): Option.Option<number> => Arr.findFirst(Arr.reverse(text.split("\n")), spokenAt)

const glanceAt = (file: string, partsIn: (text: string) => ReadonlyArray<Part>) =>
  tailOf(Bun.file(file), failureTail).pipe(
    Effect.map(({ text }): Glance => ({ failure: lastFailure(partsIn(text)), active: lastSpoke(text) }))
  )

export class Transcript extends Context.Service<
  Transcript,
  {
    read(running: Running, limit: number): Effect.Effect<Read, TranscriptMissing>
    glance(running: Running): Effect.Effect<Glance>
  }
>()("sth-herdr/connector/Transcript") {
  static readonly layer = (home: string, tailBytes = 6_000_000) =>
    Layer.effect(
      Transcript,
      Effect.gen(function* () {
        const remembered = yield* Ref.make<ReadonlyMap<string, Remembered>>(new Map())
        const located = yield* Ref.make<ReadonlyMap<string, Located>>(new Map())
        const openCodeDatabase = `${home}/.local/share/opencode/opencode.db`

        const find = (running: Running, limit: number): Effect.Effect<Found, TranscriptMissing> => {
          if (running.agent === "claude") return claude(home, tailBytes, running)
          if (running.agent === "pi") return pi(home, tailBytes, running)
          if (running.agent === "opencode") return openCode(home, running, limit)

          return Effect.fail(
            missing(`The conversation view knows Claude, Pi and OpenCode so far, not ${running.agent}.`)
          )
        }

        const claudeLocated = Effect.fn("Transcript.claudeLocated")(function* (running: Running) {
          const key = Option.getOrElse(running.session, () => "")
          const now = yield* Clock.currentTimeMillis
          const known = (yield* Ref.get(located)).get(key)
          if (known !== undefined && now - known.at < relocateEvery) return known.file
          const { file } = yield* claudeFile(home, running)
          const path = String(file.name)
          yield* Ref.update(located, (all) => new Map([...all, [key, { file: path, at: now }]]))

          return path
        })

        const watched = (running: Running) => {
          if (running.agent === "claude")
            return Effect.map(claudeLocated(running), (file) => ({ files: [file], look: glanceAt(file, partsOf) }))
          if (running.agent === "pi")
            return Effect.map(piFile(home, running), (file) => ({ files: [file], look: glanceAt(file, Pi.partsOf) }))
          if (running.agent === "opencode")
            return Effect.succeed({
              files: [openCodeDatabase, `${openCodeDatabase}-wal`],
              look: Effect.map(openCode(home, running, 4), (found): Glance => ({
                failure: lastFailure(found.parts),
                active: Option.none()
              }))
            })

          return Effect.fail(missing(`No conversation to read for ${running.agent}.`))
        }

        const glance = Effect.fn("Transcript.glance")(function* (running: Running) {
          const key = `${running.agent}|${Option.getOrElse(running.session, () => "")}|${running.cwd}`
          const { files, look } = yield* watched(running)
          const stamp = yield* stampOf(files)
          const known = (yield* Ref.get(remembered)).get(key)
          const found = known !== undefined && known.stamp === stamp ? known.glance : yield* look
          yield* Ref.update(remembered, (all) => new Map([...all, [key, { stamp, glance: found }]]))

          return found
        })

        return Transcript.of({
          read: Effect.fn("Transcript.read")(function* (running: Running, limit: number) {
            const found = yield* find(running, limit)
            const items = yield* Effect.forEach(found.parts.slice(-limit), shown(`${home}/.cache/sth-herdr/uploads/`))

            return { session: found.session, items, more: found.cut || found.parts.length > limit }
          }),
          glance: (running) =>
            glance(running).pipe(
              Effect.orElseSucceed((): Glance => ({ failure: Option.none(), active: Option.none() }))
            )
        })
      })
    )
}
