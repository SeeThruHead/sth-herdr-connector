import { describe, expect, it } from "@effect/vitest"
import { Option } from "effect"
import { changeOf } from "./Change.ts"

describe("what an edit changed", () => {
  it("counts the lines a Claude edit took out and put in, with the diff", () => {
    expect(changeOf("Edit", { file_path: "/a.ts", old_string: "one\ntwo", new_string: "three" })).toEqual(
      Option.some({ file: "/a.ts", added: 1, removed: 2, diff: "- one\n- two\n+ three" })
    )
  })

  it("adds up every edit in a multi-edit and a Pi edit", () => {
    const multi = changeOf("MultiEdit", {
      file_path: "/b.ts",
      edits: [
        { old_string: "a", new_string: "b\nc" },
        { old_string: "d", new_string: "" }
      ]
    })
    expect(Option.map(multi, (change) => [change.added, change.removed, change.diff])).toEqual(
      Option.some([2, 2, "- a\n+ b\n+ c\n…\n- d"])
    )
    expect(
      Option.map(changeOf("edit", { path: "/c.ts", oldText: "x", newText: "y" }), (change) => change.file)
    ).toEqual(Option.some("/c.ts"))
  })

  it("counts a written file as all new lines, and ignores other tools", () => {
    expect(Option.map(changeOf("Write", { file_path: "/d.md", content: "a\nb\n" }), (change) => change.added)).toEqual(
      Option.some(2)
    )
    expect(changeOf("Bash", { command: "ls" })).toEqual(Option.none())
    expect(changeOf("Edit", { old_string: "a", new_string: "b" })).toEqual(Option.none())
  })
})
