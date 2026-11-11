import { BunCrypto, BunServices } from "@effect/platform-bun"
import { describe, expect, it } from "@effect/vitest"
import { Duration, Effect, FileSystem, Layer } from "effect"
import { Digest } from "effect/crypto"
import { Hex } from "effect/encoding"
import { Revision } from "@sth-herdr/protocol/Connector.ts"
import { SelfUpdate, TrialFailed, UpdateInstalled } from "./SelfUpdate.ts"

const bin = new URL("../../../fixtures/bin/", import.meta.url).pathname
const platform = Layer.merge(BunServices.layer, BunCrypto.layer)

const revisionOf = (source: string) =>
  Digest.Digest.use((digests) => digests.digest(Digest.sha256, new TextEncoder().encode(source))).pipe(
    Effect.map((digest) => Revision.make(Hex.encode(digest)))
  )

const inDirectory = <A, E>(use: (directory: string) => Effect.Effect<A, E, FileSystem.FileSystem | Digest.Digest>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const directory = yield* fs.makeTempDirectoryScoped()
    yield* fs.writeFileString(`${directory}/sth-herdr-connector.js`, "old bundle")

    return yield* use(directory)
  }).pipe(Effect.scoped, Effect.provide(platform))

const selfIn = (directory: string, bun: string, probeTimeout: Duration.Input = "10 seconds") =>
  SelfUpdate.use(Effect.succeed).pipe(
    Effect.provide(
      SelfUpdate.layer({ file: `${directory}/sth-herdr-connector.js`, bun, probeTimeout }).pipe(Layer.provide(platform))
    )
  )

const contentsOf = (directory: string, suffix: string) =>
  FileSystem.FileSystem.use((fs) => fs.readFileString(`${directory}/sth-herdr-connector.js${suffix}`))

const existsIn = (directory: string, suffix: string) =>
  FileSystem.FileSystem.use((fs) => fs.exists(`${directory}/sth-herdr-connector.js${suffix}`))

const rejectsIn = (directory: string, revision: Revision) =>
  Effect.flatMap(selfIn(directory, "/bin/true"), (self) => self.isRejected(revision))

describe("a connector replacing itself with the hub's bundle", () => {
  it.live("knows the revision it runs and that it isn't on trial", () =>
    inDirectory(
      Effect.fnUntraced(function* (directory) {
        const self = yield* selfIn(directory, "/bin/true")
        const expected = yield* revisionOf("old bundle")
        const rejected = yield* self.isRejected(self.revision)
        yield* self.confirm

        expect(self.revision).toBe(expected)
        expect(self.onTrial).toBe(false)
        expect(rejected).toBe(false)
      })
    )
  )

  it.live("installs a bundle that passes the probe, keeping the old one and starting a trial", () =>
    inDirectory(
      Effect.fnUntraced(function* (directory) {
        const revision = yield* revisionOf("new bundle")
        const self = yield* selfIn(directory, "/bin/true")
        yield* self.install({ revision, source: "new bundle" })
        const files = yield* Effect.all([
          contentsOf(directory, ""),
          contentsOf(directory, ".prev"),
          contentsOf(directory, ".trial")
        ])
        const restarted = yield* selfIn(directory, "/bin/true")
        yield* restarted.confirm
        const stillOnTrial = yield* existsIn(directory, ".trial")

        expect(files).toEqual(["new bundle", "old bundle", revision])
        expect(restarted.onTrial).toBe(true)
        expect(restarted.revision).toBe(revision)
        expect(stillOnTrial).toBe(false)
      })
    )
  )

  it.live("puts the old bundle back when the new one doesn't reach the hub, and won't take it again", () =>
    inDirectory(
      Effect.fnUntraced(function* (directory) {
        const revision = yield* revisionOf("new bundle")
        const self = yield* selfIn(directory, "/bin/true")
        yield* self.install({ revision, source: "new bundle" })
        const trial = yield* selfIn(directory, "/bin/true")
        yield* trial.rollBack
        const running = yield* contentsOf(directory, "")
        const rejected = yield* rejectsIn(directory, revision)
        const again = yield* Effect.flip(trial.rollBack)

        expect(running).toBe("old bundle")
        expect(rejected).toBe(true)
        expect(again.reason).toContain("sth-herdr-connector.js.trial")
      })
    )
  )

  it.live("refuses a bundle that doesn't match its hash, or fails, hangs or can't start in the probe", () =>
    inDirectory(
      Effect.fnUntraced(function* (directory) {
        const revision = yield* revisionOf("new bundle")
        const bundle = { revision, source: "new bundle" }
        const attempt = (bun: string, probeTimeout?: Duration.Input) =>
          Effect.flatMap(selfIn(directory, bun, probeTimeout), (self) => Effect.flip(self.install(bundle)))
        const mismatch = yield* Effect.flatMap(selfIn(directory, "/bin/true"), (self) =>
          Effect.flip(self.install({ revision, source: "x" }))
        )
        const refusals = yield* Effect.all([
          attempt("/bin/false"),
          attempt(`${bin}slow`, "200 millis"),
          attempt("/nonexistent/bun")
        ])
        const running = yield* contentsOf(directory, "")
        const leftOver = yield* existsIn(directory, ".next")
        const rejected = yield* rejectsIn(directory, revision)

        expect(mismatch.message).toBe("connector update failed: the bundle didn't match its hash")
        expect(refusals.map((error) => error.reason)).toEqual(
          Array.from({ length: 3 }, () => "the new connector couldn't reach the hub, so it was set aside")
        )
        expect(running).toBe("old bundle")
        expect(leftOver).toBe(false)
        expect(rejected).toBe(true)
      })
    )
  )

  it.live("says what went wrong when it can't write the new bundle or keep the old one", () =>
    inDirectory(
      Effect.fnUntraced(function* (directory) {
        const fs = yield* FileSystem.FileSystem
        const revision = yield* revisionOf("new bundle")
        const self = yield* selfIn(directory, "/bin/true")
        yield* fs.makeDirectory(`${directory}/sth-herdr-connector.js.next`)
        const unwritable = yield* Effect.flip(self.install({ revision, source: "new bundle" }))
        yield* fs.remove(`${directory}/sth-herdr-connector.js.next`, { recursive: true })
        yield* fs.makeDirectory(`${directory}/sth-herdr-connector.js.prev/inside`, { recursive: true })
        const unkept = yield* Effect.flip(self.install({ revision, source: "new bundle" }))
        const running = yield* contentsOf(directory, "")

        expect(unwritable._tag).toBe("UpdateFailed")
        expect(unkept._tag).toBe("UpdateFailed")
        expect(running).toBe("old bundle")
      })
    )
  )

  it("says which build it installed or gave up on", () => {
    const revision = Revision.make("ab12cd3".padEnd(64, "0"))

    expect(new UpdateInstalled({ revision }).message).toBe(
      "installed connector ab12cd3; exiting so the service manager starts it"
    )
    expect(new TrialFailed({ revision }).message).toBe(
      "connector ab12cd3 didn't reach the hub in time; the previous one is back in place"
    )
  })
})
