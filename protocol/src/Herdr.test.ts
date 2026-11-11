import { describe, expect, it } from "@effect/vitest"
import { Schema } from "effect"
import { HubCommand } from "./Connector.ts"
import { AgentName, Directory, MachineName, PaneId, TabId, WorkspaceId } from "./Herdr.ts"

const accepts = <A>(schema: Schema.Codec<A, string>, value: string) => Schema.is(schema)(value)

describe("the names hub and connector agree on", () => {
  it("takes Herdr's own ids and refuses anything else", () => {
    expect([accepts(WorkspaceId, "w1"), accepts(TabId, "w1:t2"), accepts(PaneId, "w1:pH")]).toEqual([true, true, true])
    expect([accepts(PaneId, "w1:t2"), accepts(PaneId, "../w1:p1"), accepts(TabId, "w1")]).toEqual([false, false, false])
  })

  it("takes short lowercase machine and agent names", () => {
    expect([accepts(MachineName, "office-mac"), accepts(AgentName, "review_2")]).toEqual([true, true])
    expect([accepts(MachineName, "Mac"), accepts(AgentName, "2fast"), accepts(MachineName, "")]).toEqual([
      false,
      false,
      false
    ])
  })

  it("takes a folder only as an absolute or home path", () => {
    expect([accepts(Directory, "~/code/x"), accepts(Directory, "/srv/x"), accepts(Directory, "code/x")]).toEqual([
      true,
      true,
      false
    ])
  })

  it("refuses a command with a key Herdr would not know", () => {
    const decode = Schema.decodeUnknownOption(HubCommand)
    const command = { _tag: "SendKeys", id: "019a4b5e-0000-7000-8000-000000000001", pane: "w1:p1" }

    expect(decode({ ...command, keys: ["esc", "enter"] })._tag).toBe("Some")
    expect(decode({ ...command, keys: ["rm -rf"] })._tag).toBe("None")
    expect(decode({ ...command, keys: [] })._tag).toBe("None")
  })
})
