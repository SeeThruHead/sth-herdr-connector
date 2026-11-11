import { Array as Arr, Context, Effect, FileSystem, HashMap, Layer, Option, Path, Ref, Schema, Stream } from "effect"
import type { Snapshot } from "@sth-herdr/protocol/Herdr.ts"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import type { Dated, PlainKind } from "./Found.ts"
import { agentProcesses, claudesOf, newestOf, piFolderOf, plainSnapshotOf } from "./Found.ts"
import type { Found } from "./Found.ts"
import type { Proc } from "./Processes.ts"
import { cwdOfLsof, procFromFiles, processesOf } from "./Processes.ts"

export class PlainFailed extends Schema.TaggedError<PlainFailed, { readonly brand: unique symbol }>()("PlainFailed", {
  reason: Schema.String
}) {
  override get message() {
    return this.reason
  }
}

const systemTools = { proc: "/proc", lsof: "lsof", ps: "ps" }

const unread = <A>(fallback: A) => Effect.orElseSucceed(() => fallback)

export class Plain extends Context.Service<
  Plain,
  { snapshot(kind: PlainKind, inside: ReadonlySet<string>): Effect.Effect<Snapshot, PlainFailed> }
>()("sth-herdr/connector/Plain") {
  static readonly layer = (
    home: string,
    tools: { readonly proc: string; readonly lsof: string; readonly ps: string } = systemTools
  ) =>
    Layer.effect(
      Plain,
      Effect.gen(function* () {
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const known = yield* Ref.make(HashMap.empty<string, string>())

        const output = (binary: string, args: ReadonlyArray<string>) =>
          Effect.scoped(
            Effect.flatMap(spawner.spawn(ChildProcess.make(binary, args)), (handle) =>
              handle.stdout.pipe(Stream.decodeText(), Stream.mkString)
            )
          ).pipe(
            Effect.timeout("5 seconds"),
            Effect.mapError(() => new PlainFailed({ reason: `${binary} didn't answer` }))
          )

        const fromProc = (pid: number) =>
          Effect.all([
            fs.readFileString(`${tools.proc}/${pid}/stat`),
            fs.readFileString(`${tools.proc}/${pid}/cmdline`)
          ]).pipe(
            Effect.map(([stat, cmdline]) => Option.toArray(procFromFiles(pid, stat, cmdline))),
            unread<ReadonlyArray<Proc>>([])
          )

        const procFolder = fs.readDirectory(tools.proc).pipe(
          Effect.mapBoth({
            onFailure: () => new PlainFailed({ reason: "ps didn't answer and there's no /proc to read" }),
            onSuccess: (names) => names.filter((name) => /^\d+$/.test(name)).map(Number)
          }),
          Effect.flatMap((pids) => Effect.forEach(pids, fromProc, { concurrency: 16 })),
          Effect.map((found) => found.flat())
        )

        const processes = yield* Effect.cachedWithTTL(
          output(tools.ps, ["-A", "-o", "pid=", "-o", "ppid=", "-o", "args="]).pipe(
            Effect.map(processesOf),
            Effect.catch(() => procFolder),
            Effect.withSpan("Plain.processes")
          ),
          "500 millis"
        )

        const lookUp = (pid: number) =>
          fs.readLink(`${tools.proc}/${pid}/cwd`).pipe(
            Effect.asSome,
            Effect.catch(() =>
              Effect.map(output(tools.lsof, ["-a", "-p", String(pid), "-d", "cwd", "-Fn"]), cwdOfLsof)
            ),
            unread(Option.none<string>())
          )

        const cwdOf = Effect.fnUntraced(function* (proc: Proc) {
          const key = `${proc.pid} ${proc.argv.join(" ")}`
          const memory = yield* Ref.get(known)
          const cached = HashMap.get(memory, key)
          if (Option.isSome(cached)) return cached
          const found = yield* lookUp(proc.pid)
          if (Option.isSome(found)) yield* Ref.update(known, HashMap.set(key, found.value))

          return found
        })

        const datedOf = (folder: string) => (name: string) =>
          fs.stat(path.join(folder, name)).pipe(
            Effect.map((info): ReadonlyArray<Dated> =>
              Option.toArray(Option.map(info.mtime, (at) => ({ file: path.join(folder, name), at: at.getTime() })))
            ),
            unread<ReadonlyArray<Dated>>([])
          )

        const newestPiSession = Effect.fnUntraced(function* (cwd: string) {
          const folder = piFolderOf(home, cwd)
          const names = yield* fs.readDirectory(folder).pipe(unread<ReadonlyArray<string>>([]))
          const dated = yield* Effect.forEach(
            names.filter((name) => name.endsWith(".jsonl")),
            datedOf(folder),
            {
              concurrency: 8
            }
          )

          return newestOf(dated.flat())
        })

        const foundOf = (kind: PlainKind) =>
          Effect.fnUntraced(function* (proc: Proc) {
            const cwd = yield* cwdOf(proc)
            if (Option.isNone(cwd)) return Option.none<Found>()
            const session = kind === "pi" ? yield* newestPiSession(cwd.value) : Option.none<string>()

            return Option.some<Found>({
              pid: proc.pid,
              cwd: cwd.value,
              session,
              name: Option.none(),
              status: "unknown"
            })
          })

        const claudeFolder = `${home}/.claude/sessions`

        const claudes = Effect.fnUntraced(function* (inside: ReadonlySet<string>) {
          const procs = yield* processes
          const names = yield* fs.readDirectory(claudeFolder).pipe(unread<ReadonlyArray<string>>([]))
          const files = yield* Effect.forEach(
            names.filter((name) => name.endsWith(".json")),
            (name) => fs.readFileString(path.join(claudeFolder, name)).pipe(unread("")),
            { concurrency: 8 }
          )

          return plainSnapshotOf("claude", claudesOf(procs, files, inside))
        })

        const others = Effect.fnUntraced(function* (kind: PlainKind, inside: ReadonlySet<string>) {
          const procs = yield* processes
          const found = yield* Effect.forEach(agentProcesses(procs, kind, inside), foundOf(kind), { concurrency: 4 })

          return plainSnapshotOf(kind, Arr.getSomes(found))
        })

        const snapshot = Effect.fn("Plain.snapshot")(function* (kind: PlainKind, inside: ReadonlySet<string>) {
          yield* Effect.annotateCurrentSpan({ "plain.kind": kind })

          return yield* kind === "claude" ? claudes(inside) : others(kind, inside)
        })

        return Plain.of({ snapshot })
      })
    )
}
