import { BunServices } from "@effect/platform-bun"
import { describe, expect, it } from "@effect/vitest"
import { Effect, FileSystem, Option } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import type { Snapshot } from "@sth-herdr/protocol/Herdr.ts"
import { Plain } from "./Plain.ts"

const stayAwhile = Effect.fnUntraced(function* (fs: FileSystem.FileSystem, bin: string, name: string, cwd: string) {
  yield* fs.symlink("/bin/sleep", `${bin}/${name}`)
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const handle = yield* spawner.spawn(ChildProcess.make(`${bin}/${name}`, ["30"], { cwd }))

  return Number(handle.pid)
})

describe("agents found from their processes and files", () => {
  it.live(
    "finds Claude from its process file and Pi and OpenCode from their processes, with Pi's newest session",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const home = yield* fs.makeTempDirectoryScoped({ prefix: "sth-herdr-plain-" })
        const bin = `${home}/bin`
        const work = `${home}/work`
        yield* Effect.all([
          fs.makeDirectory(bin),
          fs.makeDirectory(work),
          fs.makeDirectory(`${home}/.claude/sessions`, { recursive: true })
        ])
        const piFolder = `${home}/.pi/agent/sessions/--${work.slice(1).replaceAll("/", "-")}--`
        yield* fs.makeDirectory(piFolder, { recursive: true })
        yield* fs.writeFileString(`${piFolder}/old.jsonl`, "{}\n")
        yield* Effect.sleep("20 millis")
        yield* fs.writeFileString(`${piFolder}/new.jsonl`, "{}\n")
        yield* fs.writeFileString(`${piFolder}/notes.txt`, "")
        const claude = yield* stayAwhile(fs, bin, "claude", work)
        const pi = yield* stayAwhile(fs, bin, "pi", work)
        const opencode = yield* stayAwhile(fs, bin, "opencode", work)
        yield* fs.writeFileString(
          `${home}/.claude/sessions/${claude}.json`,
          `{"pid":${claude},"sessionId":"s-1","cwd":"${work}","kind":"interactive","status":"idle"}`
        )
        yield* fs.writeFileString(`${home}/.claude/sessions/notes.txt`, "")

        const fakeProc = `${home}/fake-proc`
        yield* fs.makeDirectory(`${fakeProc}/4242`, { recursive: true })
        yield* fs.makeDirectory(`${fakeProc}/7`, { recursive: true })
        yield* fs.makeDirectory(`${fakeProc}/self`, { recursive: true })
        yield* fs.writeFileString(`${fakeProc}/4242/stat`, "4242 (pi) S 1 4242 4242 0 -1")
        yield* fs.writeFileString(`${fakeProc}/4242/cmdline`, "/opt/pi/pi\0--provider\0x\0")
        yield* fs.writeFileString(`${fakeProc}/7/stat`, "7 (kworker/0:1) I 2 0 0 0 -1")
        yield* fs.writeFileString(`${fakeProc}/7/cmdline`, "")
        const blind = yield* Plain.use((plain) => plain.snapshot("pi", new Set())).pipe(
          Effect.provide(Plain.layer(home, { proc: fakeProc, lsof: "/bin/false", ps: "/nonexistent/ps" }))
        )
        expect(blind.panes).toEqual([])
        const withoutPs = yield* Plain.use((plain) => plain.snapshot("pi", new Set())).pipe(
          Effect.provide(Plain.layer(home, { proc: "/proc", lsof: "lsof", ps: "/nonexistent/ps" }))
        )

        const found = yield* Effect.gen(function* () {
          const plain = yield* Plain
          const none = new Set<string>()

          return yield* Effect.all({
            claude: plain.snapshot("claude", none),
            pi: plain.snapshot("pi", none),
            again: plain.snapshot("pi", none),
            opencode: plain.snapshot("opencode", none),
            codex: plain.snapshot("codex", none)
          })
        }).pipe(Effect.provide(Plain.layer(home)))

        const here = (snapshot: Snapshot) => snapshot.panes.filter((pane) => pane.cwd === work)
        expect(here(found.claude).map((pane) => [pane.id, pane.cwd, pane.session])).toEqual([
          [`wclaude:p${claude}`, work, Option.some("s-1")]
        ])
        expect(here(found.pi).map((pane) => [pane.id, pane.cwd])).toEqual([[`wpi:p${pi}`, work]])
        expect(here(withoutPs).map((pane) => pane.id)).toEqual([`wpi:p${pi}`])
        expect(here(found.pi)[0]?.session).toEqual(here(found.again)[0]?.session)
        expect(String(here(found.pi)[0]?.session)).toContain("new.jsonl")
        expect(here(found.opencode).map((pane) => pane.id)).toEqual([`wopencode:p${opencode}`])
        expect(here(found.codex)).toEqual([])
      }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
    20_000
  )

  it.live("finds nothing in a home with no agent folders, and says so when it can't list processes at all", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "sth-herdr-plain-" })
      const found = yield* Plain.use((plain) => plain.snapshot("claude", new Set())).pipe(
        Effect.provide(Plain.layer(home))
      )
      const noPs = yield* Plain.use((plain) => Effect.flip(plain.snapshot("pi", new Set()))).pipe(
        Effect.provide(Plain.layer(home, { proc: `${home}/no-proc`, lsof: "/bin/false", ps: "/nonexistent/ps" }))
      )

      expect(found.panes).toEqual([])
      expect(noPs.message).toBe("ps didn't answer and there's no /proc to read")
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer))
  )
})
