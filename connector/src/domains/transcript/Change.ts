import { Option, Schema } from "effect"
import type { Change } from "@sth-herdr/protocol/Transcript.ts"

const ClaudePair = Schema.Struct({ old_string: Schema.String, new_string: Schema.String })
const PiPair = Schema.Struct({ oldText: Schema.String, newText: Schema.String })
const Pair = Schema.Union([ClaudePair, PiPair])
type Pair = typeof Pair.Type

const Target = Schema.Union([Schema.Struct({ file_path: Schema.String }), Schema.Struct({ path: Schema.String })])
const Edits = Schema.Struct({ edits: Schema.Array(Pair) })
const Written = Schema.Struct({ content: Schema.String })

const decodeTarget = Schema.decodeUnknownOption(Target)
const decodePair = Schema.decodeUnknownOption(Pair)
const decodeEdits = Schema.decodeUnknownOption(Edits)
const decodeWritten = Schema.decodeUnknownOption(Written)

const editing = new Set(["edit", "multiedit", "write"])

const diffLimit = 4000

const linesOf = (text: string): ReadonlyArray<string> => (text === "" ? [] : text.replace(/\n$/, "").split("\n"))

const oldOf = (pair: Pair): string => ("old_string" in pair ? pair.old_string : pair.oldText)

const newOf = (pair: Pair): string => ("new_string" in pair ? pair.new_string : pair.newText)

const marked = (mark: string, text: string): ReadonlyArray<string> => linesOf(text).map((line) => `${mark} ${line}`)

const clipped = (lines: ReadonlyArray<string>): string => {
  const text = lines.join("\n")

  return text.length > diffLimit ? `${text.slice(0, diffLimit)}\n…` : text
}

const fileOf = (input: unknown): Option.Option<string> =>
  Option.map(decodeTarget(input), (target) => ("file_path" in target ? target.file_path : target.path))

const pairsOf = (input: unknown): ReadonlyArray<Pair> =>
  Option.match(decodeEdits(input), {
    onSome: (found) => found.edits,
    onNone: () => Option.toArray(decodePair(input))
  })

const fromPairs = (file: string, pairs: ReadonlyArray<Pair>): Change => ({
  file,
  added: pairs.reduce((sum, pair) => sum + linesOf(newOf(pair)).length, 0),
  removed: pairs.reduce((sum, pair) => sum + linesOf(oldOf(pair)).length, 0),
  diff: clipped(
    pairs.flatMap((pair, at) => [...(at === 0 ? [] : ["…"]), ...marked("-", oldOf(pair)), ...marked("+", newOf(pair))])
  )
})

const fromWrite = (file: string, content: string): Change => ({
  file,
  added: linesOf(content).length,
  removed: 0,
  diff: clipped(marked("+", content))
})

export const changeOf = (tool: string, input: unknown): Option.Option<Change> => {
  if (!editing.has(tool.toLowerCase())) return Option.none()

  return Option.flatMap(fileOf(input), (file) => {
    const pairs = pairsOf(input)
    if (pairs.length > 0) return Option.some(fromPairs(file, pairs))

    return Option.map(decodeWritten(input), (written) => fromWrite(file, written.content))
  })
}
