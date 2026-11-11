import { BunServices } from "@effect/platform-bun"
import { describe, expect, it } from "@effect/vitest"
import { Effect, FileSystem, Option, Schema } from "effect"
import { Transcript } from "./Transcript.ts"

const home = new URL("../../../fixtures/home", import.meta.url).pathname
const session = "55369201-d496-487b-b929-d7e8fb6484bb"

const said = (uuid: string, content: string, sessionId: string) =>
  Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({ type: "user", uuid, sessionId, message: { content } })

const running = (agent: string, id: string) => ({ agent, session: Option.some(id), cwd: "/home/demo" })

const read = (agent: string, id: string, limit: number) =>
  Transcript.use((transcripts) => transcripts.read(running(agent, id), limit)).pipe(
    Effect.provide(Transcript.layer(home))
  )

describe("finding an agent's conversation on disk", () => {
  it.effect("finds the session file in any project folder and keeps the latest items", () =>
    Effect.gen(function* () {
      const transcript = yield* read("claude", session, 100)

      expect(transcript.session).toBe(session)
      expect(transcript.items.length).toBe(12)
      expect(transcript.more).toBe(false)
    })
  )

  it.effect("reads only the end of a long conversation and says there is more", () =>
    Effect.gen(function* () {
      const transcript = yield* Transcript.use((transcripts) => transcripts.read(running("claude", session), 100)).pipe(
        Effect.provide(Transcript.layer(home, 300))
      )

      expect(transcript.more).toBe(true)
      expect(transcript.items.map((item) => item._tag)).toEqual(["Said"])
    })
  )

  it.effect("says when the transcripts folder can't be read", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        Transcript.use((transcripts) => transcripts.read(running("claude", session), 10)).pipe(
          Effect.provide(Transcript.layer("/nonexistent-home"))
        )
      )

      expect(error.message).toBe("The conversation file couldn't be read.")
    })
  )

  it.effect("explains what it can't show", () =>
    Effect.gen(function* () {
      expect((yield* Effect.flip(read("codex", session, 10))).message).toBe(
        "The conversation view knows Claude, Pi and OpenCode so far, not codex."
      )
      expect((yield* Effect.flip(read("claude", "../../etc/passwd", 10))).message).toBe(
        "The agent's session id isn't a UUID."
      )
      expect((yield* Effect.flip(read("claude", "019a4b5e-0000-7000-8000-000000000009", 10))).message).toBe(
        "Claude hasn't written this conversation yet."
      )
    })
  )

  it.effect("shows a picture sent from the phone, and only names files it won't open", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const root = yield* fs.makeTempDirectoryScoped()
      const uploads = `${root}/.cache/sth-herdr/uploads`
      yield* fs.makeDirectory(uploads, { recursive: true })
      yield* fs.makeDirectory(`${root}/.claude/projects/demo`, { recursive: true })
      yield* fs.writeFileString(`${uploads}/1-0-red.jpg`, "hi")
      yield* fs.writeFile(`${uploads}/1-1-huge.png`, new Uint8Array(2_400_000))
      yield* fs.writeFileString(`${root}/elsewhere.png`, "no")
      const paths = [
        `${uploads}/1-0-red.jpg`,
        `${uploads}/1-1-huge.png`,
        `${uploads}/1-2-gone.webp`,
        `${uploads}/1-3-notes.pdf`,
        `${root}/elsewhere.png`,
        `${uploads}/../../../elsewhere.png`
      ]
      const line = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
        type: "user",
        uuid: "u1",
        message: { content: `Look\n\n${paths.map((path) => `[Attached: ${path}]`).join("\n")}` }
      })
      yield* fs.writeFileString(`${root}/.claude/projects/demo/${session}.jsonl`, `${line}\n`)

      const transcript = yield* Transcript.use((transcripts) => transcripts.read(running("claude", session), 10)).pipe(
        Effect.provide(Transcript.layer(root))
      )

      expect(transcript.items).toEqual([
        { _tag: "Picture", id: "u1-f0", mediaType: "image/jpeg", base64: "aGk=" },
        { _tag: "Said", id: "u1-f1", who: "person", markdown: "📎 huge.png" },
        { _tag: "Said", id: "u1-f2", who: "person", markdown: "📎 gone.webp" },
        { _tag: "Said", id: "u1-f3", who: "person", markdown: "📎 notes.pdf" },
        { _tag: "Said", id: "u1-f4", who: "person", markdown: "📎 elsewhere.png" },
        { _tag: "Said", id: "u1-f5", who: "person", markdown: "📎 elsewhere.png" },
        { _tag: "Said", id: "u1", who: "person", markdown: "Look" }
      ])
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer))
  )

  it.effect("follows the session Claude carried this conversation on in, not another agent's in the same folder", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const root = yield* fs.makeTempDirectoryScoped()
      const folder = `${root}/.claude/projects/demo`
      yield* fs.makeDirectory(folder, { recursive: true })
      const carried = "0f4e3b1c-2a6d-4c8e-9f10-2b3c4d5e6f70"
      const other = "7a8b9c0d-1e2f-4a3b-8c4d-5e6f7a8b9c0d"
      yield* fs.writeFileString(`${folder}/${session}.jsonl`, `${yield* said("u1", "before", session)}\n`)
      yield* fs.writeFileString(
        `${folder}/${carried}.jsonl`,
        `${yield* said("u1", "before", session)}\n${yield* said("u2", "after", carried)}\n`
      )
      yield* fs.writeFileString(`${folder}/${other}.jsonl`, `${yield* said("u9", "someone else", other)}\n`)
      yield* fs.utimes(`${folder}/${session}.jsonl`, 1_000, 1_000)
      yield* fs.utimes(`${folder}/${carried}.jsonl`, 2_000, 2_000)
      yield* fs.utimes(`${folder}/${other}.jsonl`, 3_000, 3_000)

      const transcript = yield* Transcript.use((transcripts) => transcripts.read(running("claude", session), 10)).pipe(
        Effect.provide(Transcript.layer(root))
      )

      expect(transcript.items.map((item) => (item._tag === "Said" ? item.markdown : item._tag))).toEqual([
        "before",
        "after"
      ])
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer))
  )
})
