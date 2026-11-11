import { Array as Arr, Option } from "effect"

export type Proc = { readonly pid: number; readonly ppid: number; readonly argv: ReadonlyArray<string> }

const row = /^\s*(\d+)\s+(\d+)\s+(\S.*)$/

const procOf = (line: string): Option.Option<Proc> =>
  Option.map(Option.fromNullishOr(row.exec(line)), (found) => ({
    pid: Number(found[1]),
    ppid: Number(found[2]),
    argv: String(found[3]).trim().split(/\s+/)
  }))

export const processesOf = (text: string): ReadonlyArray<Proc> => Arr.getSomes(text.split("\n").map(procOf))

const statLine = /\)\s+\S+\s+(\d+)/

export const procFromFiles = (pid: number, stat: string, cmdline: string): Option.Option<Proc> => {
  const argv = cmdline.split("\0").filter((part) => part !== "")
  if (argv.length === 0) return Option.none()

  return Option.map(Option.fromNullishOr(statLine.exec(stat.slice(stat.lastIndexOf(")")))), (found) => ({
    pid,
    ppid: Number(found[1]),
    argv
  }))
}

const cwdLine = /^n(\/.*)$/m

export const cwdOfLsof = (text: string): Option.Option<string> =>
  Option.flatMap(Option.fromNullishOr(cwdLine.exec(text)), (found) => Option.fromNullishOr(found[1]))

export const baseName = (path: string): string => path.split("/").findLast((part) => part !== "") ?? path

const wrappers: ReadonlySet<string> = new Set(["node", "bun", "deno"])

export const commandOf = (proc: Proc): string => {
  const first = baseName(proc.argv[0] ?? "")
  if (!wrappers.has(first)) return first

  return baseName(proc.argv[1] ?? "")
}

export type Table = ReadonlyMap<number, Proc>

export const tableOf = (procs: ReadonlyArray<Proc>): Table => new Map(procs.map((proc) => [proc.pid, proc]))

export const ancestorsOf = (table: Table, proc: Proc): ReadonlyArray<Proc> =>
  Arr.unfold({ at: proc.ppid, left: table.size }, ({ at, left }) =>
    left === 0
      ? Option.none()
      : Option.map(
          Option.fromNullishOr(table.get(at)),
          (parent) => [parent, { at: parent.ppid, left: left - 1 }] as const
        )
  )

export const isInside = (table: Table, proc: Proc, names: ReadonlySet<string>): boolean =>
  ancestorsOf(table, proc).some((ancestor) => names.has(commandOf(ancestor)))
