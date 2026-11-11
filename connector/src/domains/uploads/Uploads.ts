import { Clock, Context, Effect, FileSystem, Layer, Path, Result, Schema } from "effect"
import { Base64 } from "effect/encoding"
import type { Upload } from "@sth-herdr/protocol/Connector.ts"

export class UploadFailed extends Schema.TaggedError<UploadFailed, { readonly brand: unique symbol }>()(
  "UploadFailed",
  { reason: Schema.String }
) {}

const failed = (reason: string) => new UploadFailed({ reason })

export const attachedLine = (path: string): string => `[Attached: ${path}]`

export const withAttached = (text: string, paths: ReadonlyArray<string>): string =>
  paths.length === 0 ? text : [text, "", ...paths.map(attachedLine)].join("\n")

export const safeName = (name: string): string => {
  const base = name.replace(/^.*[/\\]/, "")
  const safe = base
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^[.-]+/, "")
    .slice(-80)

  return safe === "" ? "file" : safe
}

export class Uploads extends Context.Service<
  Uploads,
  { save(files: ReadonlyArray<Upload>): Effect.Effect<ReadonlyArray<string>, UploadFailed> }
>()("sth-herdr/connector/Uploads") {
  static readonly layer = (folder: string) =>
    Layer.effect(
      Uploads,
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path

        const saveOne = Effect.fnUntraced(function* (stamp: number, file: Upload, index: number) {
          const bytes = yield* Result.match(Base64.decode(file.base64), {
            onFailure: () => Effect.fail(failed(`${file.name} isn't a file the phone could send.`)),
            onSuccess: Effect.succeed
          })
          const target = path.join(folder, `${stamp}-${index}-${safeName(file.name)}`)
          yield* fs
            .writeFile(target, bytes)
            .pipe(Effect.mapError(() => failed(`Couldn't save ${file.name} on this machine.`)))

          return target
        })

        const save = Effect.fn("Uploads.save")(function* (files: ReadonlyArray<Upload>) {
          if (files.length === 0) return []
          yield* fs
            .makeDirectory(folder, { recursive: true })
            .pipe(Effect.mapError(() => failed("Couldn't make the uploads folder on this machine.")))
          const stamp = yield* Clock.currentTimeMillis

          return yield* Effect.forEach(files, (file, index) => saveOne(stamp, file, index))
        })

        return Uploads.of({ save })
      })
    )
}
