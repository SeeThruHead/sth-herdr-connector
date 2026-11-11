import { BunServices } from "@effect/platform-bun"
import { describe, expect, it } from "@effect/vitest"
import { Effect, FileSystem } from "effect"
import { SlashCommands, builtIn } from "./SlashCommands.ts"

describe("the slash commands an agent on this machine knows", () => {
  it.effect("lists Claude's own, then the person's and the project's skills and commands by name", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const home = yield* fs.makeTempDirectoryScoped()
      const project = yield* fs.makeTempDirectoryScoped()
      yield* fs.makeDirectory(`${home}/.claude/skills/handoff`, { recursive: true })
      yield* fs.makeDirectory(`${home}/.claude/skills/empty`, { recursive: true })
      yield* fs.makeDirectory(`${home}/.claude/commands`, { recursive: true })
      yield* fs.makeDirectory(`${project}/.claude/skills/clear`, { recursive: true })
      yield* fs.writeFileString(
        `${home}/.claude/skills/handoff/SKILL.md`,
        '---\nname: handoff\ndescription: "Deliver a file"\n---\n# Handoff'
      )
      yield* fs.writeFileString(`${home}/.claude/commands/ship.md`, "Ship it with no front matter")
      yield* fs.writeFileString(`${home}/.claude/commands/notes.txt`, "not a command")
      yield* fs.writeFileString(`${project}/.claude/skills/clear/SKILL.md`, "---\ndescription: mine\n---")

      const commands = yield* Effect.gen(function* () {
        const slash = yield* SlashCommands

        return yield* slash.list(project)
      }).pipe(Effect.provide(SlashCommands.layer(home)))

      expect(commands.slice(0, builtIn.length)).toEqual(builtIn)
      expect(commands.slice(builtIn.length)).toEqual([
        { name: "handoff", description: "Deliver a file" },
        { name: "ship", description: "" }
      ])
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer))
  )
})
