import { BunServices } from "@effect/platform-bun"
import { describe, expect, it } from "@effect/vitest"
import { Database } from "bun:sqlite"
import { Effect, FileSystem, Option } from "effect"
import type { Item } from "@sth-herdr/protocol/Transcript.ts"
import { Transcript } from "./Transcript.ts"
import { toJson } from "@sth-herdr/protocol/Json.ts"

const shapeOf = (item: Item): string => {
  if (item._tag === "Said") return `${item.who}${item.failed === true ? " failed" : ""}: ${item.markdown}`
  if (item._tag === "ToolCall") return `call ${item.tool} ${item.summary} (${item.id})`
  if (item._tag === "ToolResult") return `result ${item.call}${item.failed ? " failed" : ""}: ${item.text}`

  return `picture ${item.mediaType}`
}

const lines = (entries: ReadonlyArray<unknown>): string => entries.map((entry) => toJson(entry)).join("\n")

const piSession = lines([
  { type: "session", version: 3, id: "s1", cwd: "/home/demo" },
  { type: "model_change", id: "m1", parentId: null, provider: "opencode-go", modelId: "luna" },
  { type: "message", id: "x0", parentId: "m1", message: { role: "system", content: "", sections: {} } },
  { type: "message", id: "u1", parentId: "x0", message: { role: "user", content: [{ type: "text", text: "Hi" }] } },
  {
    type: "message",
    id: "lost",
    parentId: "u1",
    message: { role: "assistant", content: [{ type: "text", text: "An abandoned branch" }] }
  },
  {
    type: "message",
    id: "a1",
    parentId: "u1",
    message: {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "Hmm", thinkingSignature: "{}" },
        { type: "toolCall", id: "call_1|fc_1", name: "bash", arguments: { command: "echo hi" } }
      ],
      api: "openai-responses"
    }
  },
  {
    type: "message",
    id: "r1",
    parentId: "a1",
    message: {
      role: "toolResult",
      toolCallId: "call_1|fc_1",
      toolName: "bash",
      content: [{ type: "text", text: "hi" }],
      isError: false
    }
  },
  {
    type: "message",
    id: "a2",
    parentId: "r1",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "It said hi.", textSignature: '{"v":1,"id":"msg_1","phase":"final_answer"}' }],
      api: "openai-responses"
    }
  },
  { type: "message", id: "u2", parentId: "a2", message: { role: "user", content: "How are you?" } },
  {
    type: "message",
    id: "a3",
    parentId: "u2",
    message: { role: "assistant", content: [{ type: "text", text: "Well, thanks." }] }
  },
  { type: "message", id: "z1", parentId: "a3", message: { nope: 1 } },
  { type: "message", id: "z2", parentId: "z1", message: { role: "custom", content: "Not for the phone" } },
  {
    type: "message",
    id: "z3",
    parentId: "z2",
    message: { role: "user", content: [{ type: "image", data: "aGk=", mimeType: "image/png" }] }
  },
  { type: "message", id: "z4", parentId: "z3", message: { role: "toolResult" } },
  { type: "message", id: "z5", parentId: "z4", message: { role: "assistant" } }
])

const usage = '429: {"type":"GoUsageLimitError","message":"Go usage limit exceeded"}'

const failedTurn = (id: string, parentId: string, stopReason: string, errorMessage?: string) => ({
  type: "message",
  id,
  parentId,
  message: { role: "assistant", content: [], stopReason, ...(errorMessage === undefined ? {} : { errorMessage }) }
})

const piFailures = lines([
  { type: "message", id: "u1", parentId: null, message: { role: "user", content: "Hi" } },
  failedTurn("f1", "u1", "error", usage),
  { type: "message", id: "u2", parentId: "f1", message: { role: "user", content: "Again" } },
  failedTurn("f2", "u2", "error"),
  failedTurn("f3", "f2", "aborted"),
  failedTurn("f4", "f3", "aborted", "Request was aborted"),
  failedTurn("f5", "f4", "error", usage)
])

const circle = lines([
  { type: "message", id: "c1", parentId: "c2", message: { role: "user", content: "one" } },
  { type: "message", id: "c2", parentId: "c1", message: { role: "assistant", content: "two" } }
])

const openCodeTables = [
  `CREATE TABLE session_v2 (id text PRIMARY KEY, directory text NOT NULL, parent_id text, time_archived integer, time_updated integer NOT NULL)`,
  `CREATE TABLE session_message (id text PRIMARY KEY, session_id text NOT NULL, type text NOT NULL, seq integer NOT NULL, data text NOT NULL)`
]

const tool = (id: string, status: string, extra: Readonly<Record<string, unknown>>) => ({
  type: "tool",
  id,
  name: "shell",
  executed: false,
  state: { status, input: { command: "echo hi" }, ...extra }
})

const openCodeRows: ReadonlyArray<readonly [string, string, string, number, unknown]> = [
  ["m1", "ses_new", "user", 1, { text: "Run echo hi", files: [], agents: [] }],
  [
    "m2",
    "ses_new",
    "assistant",
    2,
    {
      content: [
        { type: "reasoning", text: "Should run it." },
        { type: "text", text: "Running it." },
        tool("shell_1", "completed", { content: [{ type: "text", text: "hi\n" }], output: "" }),
        tool("shell_2", "error", { error: "No such command" }),
        tool("shell_3", "running", {})
      ]
    }
  ],
  ["m3", "ses_new", "synthetic", 3, { text: "Instructions from AGENTS.md" }],
  ["m4", "ses_new", "assistant", 4, { content: [{ type: "text", text: "It printed hi." }] }],
  ["m5", "ses_new", "idle", 5, { outcome: "succeeded" }],
  ["m6", "ses_new", "user", 6, "not json"],
  ["m7", "ses_new", "assistant", 7, {}],
  ["m8", "ses_new", "user", 8, { text: null }],
  [
    "m9",
    "ses_new",
    "assistant",
    9,
    {
      content: [
        { type: "tool", id: "shell_4", name: "shell", state: { status: "completed", output: "from output" } },
        { type: "tool", id: "shell_5", name: "shell", state: { status: "error" } },
        { type: "tool", id: "shell_6", name: "shell", state: { status: "completed" } }
      ]
    }
  ],
  ["m10", "ses_new", "assistant", 10, "not json"],
  ["o1", "ses_old", "user", 1, { text: "An older conversation" }],
  ["f1", "ses_fail", "user", 1, { text: "Go" }],
  ["f2", "ses_fail", "idle", 2, { outcome: "failed", error: { type: "api", message: "Go usage limit exceeded" } }],
  ["f3", "ses_fail", "idle", 3, { outcome: "interrupted" }],
  ["f4", "ses_fail", "idle", 4, "not json"],
  ["f5", "ses_fail", "idle", 5, { outcome: "failed", error: null }],
  ["c1", "ses_child", "user", 1, { text: "A subagent's conversation" }]
]

const seeded = (path: string) =>
  Effect.acquireUseRelease(
    Effect.sync(() => new Database(path, { create: true })),
    (database) =>
      Effect.sync(() => {
        openCodeTables.forEach((sql) => database.run(sql))
        database.run(
          "INSERT INTO session_v2 VALUES ('ses_old', '/home/demo', NULL, NULL, 1), ('ses_new', '/home/demo', NULL, NULL, 2), ('ses_child', '/home/demo', 'ses_new', NULL, 3), ('ses_away', '/home/other', NULL, NULL, 4), ('ses_fail', '/home/failing', NULL, NULL, 5)"
        )
        openCodeRows.forEach(([id, session, type, seq, data]) =>
          database.run("INSERT INTO session_message VALUES (?, ?, ?, ?, ?)", [
            id,
            session,
            type,
            seq,
            typeof data === "string" ? data : toJson(data)
          ])
        )
      }),
    (database) => Effect.sync(() => database.close())
  )

const read = (root: string, agent: string, session: Option.Option<string>, cwd: string, limit: number) =>
  Transcript.use((transcripts) => transcripts.read({ agent, session, cwd }, limit)).pipe(
    Effect.provide(Transcript.layer(root))
  )

const failureOf = (transcripts: Transcript["Service"], running: Parameters<Transcript["Service"]["glance"]>[0]) =>
  transcripts.glance(running).pipe(Effect.map((glance) => glance.failure))

describe("reading Pi and OpenCode conversations", () => {
  it.effect("follows a Pi session's current branch: what the person said, the replies and the tools", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const root = yield* fs.makeTempDirectoryScoped()
      const folder = `${root}/.pi/agent/sessions/--home-demo--`
      yield* fs.makeDirectory(folder, { recursive: true })
      const path = `${folder}/2026-11-07T15-23-15-435Z_s1.jsonl`
      yield* fs.writeFileString(path, `${piSession}\n`)

      const transcript = yield* read(root, "pi", Option.some(path), "/home/demo", 100)

      expect(transcript.session).toBe(path)
      expect(transcript.more).toBe(false)
      expect(transcript.items.map(shapeOf)).toEqual([
        "person: Hi",
        "call bash echo hi (call_1|fc_1)",
        "result call_1|fc_1: hi",
        "agent: It said hi.",
        "person: How are you?",
        "agent: Well, thanks.",
        "picture image/png",
        "result : "
      ])
      expect((yield* read(root, "pi", Option.some(path), "/home/demo", 2)).more).toBe(true)
      yield* fs.writeFileString(`${folder}/circle.jsonl`, `${circle}\n`)
      expect(
        (yield* read(root, "pi", Option.some(`${folder}/circle.jsonl`), "/home/demo", 10)).items.map(shapeOf)
      ).toEqual(["person: one", "agent: two"])
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer))
  )

  it.effect(
    "shows a Pi turn that failed as a failed reply with the provider's error, and knows the last turn failed",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const root = yield* fs.makeTempDirectoryScoped()
        const folder = `${root}/.pi/agent/sessions/--home-demo--`
        yield* fs.makeDirectory(folder, { recursive: true })
        const path = `${folder}/failed.jsonl`
        yield* fs.writeFileString(path, `${piFailures}\n`)

        const transcript = yield* read(root, "pi", Option.some(path), "/home/demo", 100)
        const failure = yield* Transcript.use((transcripts) =>
          Effect.all([
            failureOf(transcripts, { agent: "pi", session: Option.some(path), cwd: "/home/demo" }),
            failureOf(transcripts, { agent: "pi", session: Option.some(path), cwd: "/home/demo" })
          ])
        ).pipe(Effect.provide(Transcript.layer(root)))

        expect(transcript.items.map(shapeOf)).toEqual([
          "person: Hi",
          `agent failed: Error: ${usage}`,
          "person: Again",
          "agent failed: The turn failed.",
          "agent failed: Interrupted",
          "agent failed: Request was aborted",
          `agent failed: Error: ${usage}`
        ])
        expect(failure).toEqual([Option.some(`Error: ${usage}`), Option.some(`Error: ${usage}`)])
      }).pipe(Effect.scoped, Effect.provide(BunServices.layer))
  )

  it.effect("knows when a Claude conversation's last turn failed, and finds the file again only now and then", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const root = yield* fs.makeTempDirectoryScoped()
      const id = "9e0c1f8a-2b3d-4e5f-8a9b-0c1d2e3f4a5b"
      yield* fs.makeDirectory(`${root}/.claude/projects/-home-demo`, { recursive: true })
      const path = `${root}/.claude/projects/-home-demo/${id}.jsonl`
      const asked = { type: "user", uuid: "u1", message: { content: "Hi" } }
      const refused = {
        type: "assistant",
        uuid: "a1",
        isApiErrorMessage: true,
        message: { content: [{ type: "text", text: "You've hit your weekly limit" }] }
      }
      const running = { agent: "claude", session: Option.some(id), cwd: "/home/demo" }
      yield* fs.writeFileString(path, `${lines([asked, refused])}\n`)

      const seen = yield* Effect.gen(function* () {
        const transcripts = yield* Transcript
        const failed = yield* failureOf(transcripts, running)
        const spoke = { ...asked, uuid: "u2", timestamp: "2026-11-09T14:30:00.000Z" }
        const after = { type: "system", subtype: "turn_duration", timestamp: "2026-11-09T14:31:00.000Z" }
        yield* fs.writeFileString(path, `${lines([asked, refused, spoke, after])}\n`)
        const answered = yield* failureOf(transcripts, running)
        const unknown = yield* failureOf(transcripts, { ...running, session: Option.some("not-a-uuid") })
        const unnamed = yield* failureOf(transcripts, { ...running, session: Option.none() })
        const active = (yield* transcripts.glance(running)).active
        const silent = (yield* transcripts.glance({ ...running, session: Option.none() })).active
        expect(active).toEqual(Option.some(Date.parse(spoke.timestamp)))
        expect(silent).toEqual(Option.none())

        return { failed, answered, unknown, unnamed }
      }).pipe(Effect.provide(Transcript.layer(root)))

      expect(seen).toEqual({
        failed: Option.some("You've hit your weekly limit"),
        answered: Option.none(),
        unknown: Option.none(),
        unnamed: Option.none()
      })
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer))
  )

  it.effect("reads only Pi's own session files", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const root = yield* fs.makeTempDirectoryScoped()
      const outside = (path: string) => Effect.flip(read(root, "pi", Option.some(path), "/home/demo", 10))

      expect((yield* outside("/etc/passwd")).message).toBe("The Pi session isn't in Pi's sessions folder.")
      expect((yield* outside(`${root}/.pi/agent/sessions/../../x.jsonl`)).message).toBe(
        "The Pi session isn't in Pi's sessions folder."
      )
      expect((yield* outside(`${root}/.pi/agent/sessions/a/b.txt`)).message).toBe(
        "The Pi session isn't in Pi's sessions folder."
      )
      expect((yield* Effect.flip(read(root, "pi", Option.none(), "/home/demo", 10))).message).toBe(
        "Herdr doesn't know this Pi session yet."
      )
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer))
  )

  it.effect("finds the newest OpenCode conversation in the agent's folder and shows its tools", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const root = yield* fs.makeTempDirectoryScoped()
      yield* fs.makeDirectory(`${root}/.local/share/opencode`, { recursive: true })
      yield* seeded(`${root}/.local/share/opencode/opencode.db`)

      const transcript = yield* read(root, "opencode", Option.none(), "/home/demo", 100)

      expect(transcript.session).toBe("ses_new")
      expect(transcript.more).toBe(false)
      expect(transcript.items.map(shapeOf)).toEqual([
        "person: Run echo hi",
        "agent: Running it.",
        "call shell echo hi (shell_1)",
        "result shell_1: hi\n",
        "call shell echo hi (shell_2)",
        "result shell_2 failed: No such command",
        "call shell echo hi (shell_3)",
        "agent: It printed hi.",
        "call shell  (shell_4)",
        "result shell_4: from output",
        "call shell  (shell_5)",
        "result shell_5 failed: The tool failed.",
        "call shell  (shell_6)",
        "result shell_6: "
      ])
      expect((yield* read(root, "opencode", Option.none(), "/home/demo", 2)).more).toBe(true)
      expect((yield* read(root, "opencode", Option.none(), "/home/failing", 10)).items.map(shapeOf)).toEqual([
        "person: Go",
        "agent failed: Error: Go usage limit exceeded",
        "agent failed: Interrupted",
        "agent failed: The turn failed."
      ])
      const failures = yield* Transcript.use((transcripts) =>
        Effect.all([
          failureOf(transcripts, { agent: "opencode", session: Option.none(), cwd: "/home/failing" }),
          failureOf(transcripts, { agent: "opencode", session: Option.none(), cwd: "/home/demo" }),
          failureOf(transcripts, { agent: "codex", session: Option.none(), cwd: "/home/demo" })
        ])
      ).pipe(Effect.provide(Transcript.layer(root)))
      expect(failures).toEqual([Option.some("The turn failed."), Option.none(), Option.none()])
      expect((yield* Effect.flip(read(root, "opencode", Option.none(), "/home/nowhere", 10))).message).toBe(
        "OpenCode hasn't written a conversation in this folder yet."
      )
      expect((yield* Effect.flip(read("/nonexistent-home", "opencode", Option.none(), "/home/demo", 10))).message).toBe(
        "OpenCode's database couldn't be opened."
      )
      const empty = yield* fs.makeTempDirectoryScoped()
      yield* fs.makeDirectory(`${empty}/.local/share/opencode`, { recursive: true })
      yield* fs.writeFileString(`${empty}/.local/share/opencode/opencode.db`, "")
      expect((yield* Effect.flip(read(empty, "opencode", Option.none(), "/home/demo", 10))).message).toBe(
        "OpenCode's database couldn't be read."
      )
      expect((yield* Effect.flip(read(empty, "claude", Option.none(), "/home/demo", 10))).message).toBe(
        "Herdr doesn't know this Claude session yet."
      )
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer))
  )
})
