import { BunServices } from "@effect/platform-bun"
import { describe, expect, it } from "@effect/vitest"
import { Effect, FileSystem, Layer } from "effect"
import { Uploads, safeName, withAttached } from "./Uploads.ts"

const inFolder = (folder: string) => Uploads.layer(folder).pipe(Layer.provide(BunServices.layer))

const saved = (folder: string, files: Parameters<Uploads["Service"]["save"]>[0]) =>
  Effect.gen(function* () {
    const uploads = yield* Uploads

    return yield* uploads.save(files)
  }).pipe(Effect.provide(inFolder(folder)))

describe("saving what the phone sends on the machine", () => {
  it.effect("writes each file into the uploads folder and gives back where", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const root = yield* fs.makeTempDirectoryScoped()
      const paths = yield* saved(`${root}/uploads`, [
        { name: "image.png", base64: "aGk=" },
        { name: "../../notes v2.txt", base64: "eW8=" }
      ])
      const contents = yield* Effect.forEach(paths, (path) => fs.readFileString(path))

      expect(paths.map((path) => path.split("/").at(-1)?.replace(/^\d+-/, ""))).toEqual([
        "0-image.png",
        "1-notes-v2.txt"
      ])
      expect(contents).toEqual(["hi", "yo"])
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer))
  )

  it.effect("does nothing when there are no files", () =>
    Effect.gen(function* () {
      const paths = yield* saved("/nonexistent/never", [])

      expect(paths).toEqual([])
    })
  )

  it.effect("says why when a file can't be read or saved", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const root = yield* fs.makeTempDirectoryScoped()
      yield* fs.writeFileString(`${root}/taken`, "")

      const garbled = yield* Effect.flip(saved(root, [{ name: "a.png", base64: "!!!" }]))
      const noFolder = yield* Effect.flip(saved(`${root}/taken/uploads`, [{ name: "a.png", base64: "aGk=" }]))
      yield* fs.makeDirectory(`${root}/blocked/0-0-a.png`, { recursive: true })
      const noFile = yield* Effect.flip(saved(`${root}/blocked`, [{ name: "a.png", base64: "aGk=" }]))

      expect(garbled.reason).toBe("a.png isn't a file the phone could send.")
      expect(noFolder.reason).toBe("Couldn't make the uploads folder on this machine.")
      expect(noFile.reason).toBe("Couldn't save a.png on this machine.")
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer))
  )

  it("keeps a file's name to safe characters", () => {
    expect(safeName("IMG 0042.HEIC")).toBe("IMG-0042.HEIC")
    expect(safeName("..")).toBe("file")
    expect(safeName("dir/")).toBe("file")
  })

  it("adds the saved paths under the prompt so the agent opens them", () => {
    expect(withAttached("Look", [])).toBe("Look")
    expect(withAttached("Look", ["/a.png", "/b.png"])).toBe("Look\n\n[Attached: /a.png]\n[Attached: /b.png]")
  })
})
