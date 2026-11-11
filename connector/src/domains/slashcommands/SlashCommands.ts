import { Array as Arr, Context, Effect, FileSystem, Layer, Order, Path } from "effect"
import type { SlashCommand } from "@sth-herdr/protocol/Connector.ts"

export const builtIn: ReadonlyArray<SlashCommand> = [
  { name: "clear", description: "Start a new conversation" },
  { name: "compact", description: "Summarise the conversation to free up context" },
  { name: "context", description: "Show what fills the context" },
  { name: "usage", description: "Show plan usage limits" },
  { name: "cost", description: "Show what this session has used" },
  { name: "model", description: "Choose the model" },
  { name: "review", description: "Review a pull request" },
  { name: "init", description: "Write a CLAUDE.md for this project" },
  { name: "memory", description: "Edit Claude's memory files" },
  { name: "status", description: "Show version, model and account" },
  { name: "help", description: "Show help" }
]

const descriptionOf = (text: string): string => {
  const front = text.startsWith("---") ? text.slice(3, text.indexOf("\n---", 3)) : ""
  const line = front.split("\n").find((entry) => entry.startsWith("description:"))

  return (line ?? "")
    .slice("description:".length)
    .trim()
    .replace(/^["']|["']$/g, "")
}

const byName = Order.mapInput(Order.String, (command: SlashCommand) => command.name)

export class SlashCommands extends Context.Service<
  SlashCommands,
  { list(cwd: string): Effect.Effect<ReadonlyArray<SlashCommand>> }
>()("sth-herdr/connector/SlashCommands") {
  static readonly layer = (home: string) =>
    Layer.effect(
      SlashCommands,
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path

        const described = (file: string, name: string) =>
          fs.readFileString(file).pipe(
            Effect.map((text): ReadonlyArray<SlashCommand> => [{ name, description: descriptionOf(text) }]),
            Effect.orElseSucceed(() => [])
          )

        const entries = (folder: string) => fs.readDirectory(folder).pipe(Effect.orElseSucceed(() => []))

        const skills = (folder: string) =>
          Effect.flatMap(entries(folder), (names) =>
            Effect.forEach(names, (name) => described(path.join(folder, name, "SKILL.md"), name))
          )

        const commands = (folder: string) =>
          Effect.flatMap(entries(folder), (names) =>
            Effect.forEach(
              names.filter((name) => name.endsWith(".md")),
              (name) => described(path.join(folder, name), name.slice(0, -3))
            )
          )

        const list = Effect.fn("SlashCommands.list")(function* (cwd: string) {
          const found = yield* Effect.all(
            [
              skills(path.join(home, ".claude", "skills")),
              commands(path.join(home, ".claude", "commands")),
              skills(path.join(cwd, ".claude", "skills")),
              commands(path.join(cwd, ".claude", "commands"))
            ],
            { concurrency: "unbounded" }
          )
          const own = Arr.sort(found.flat(2), byName)

          return Arr.dedupeWith([...builtIn, ...own], (one, other) => one.name === other.name)
        })

        return SlashCommands.of({ list })
      })
    )
}
