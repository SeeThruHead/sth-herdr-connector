import { describe, expect, it } from "@effect/vitest"
import { Option, Schema } from "effect"
import { RawSnapshot, snapshotOf } from "./Raw.ts"

const raw = Schema.decodeUnknownSync(RawSnapshot)(
  await Bun.file(new URL("../../../fixtures/snapshot.json", import.meta.url)).json()
)

describe("Herdr's snapshot as the hub sees it", () => {
  it("keeps every workspace, tab and pane with their status", () => {
    const snapshot = snapshotOf(raw)

    expect(snapshot.workspaces.map((workspace) => [workspace.id, workspace.label])).toEqual([
      ["w1", "project-1"],
      ["w2", "project-2"]
    ])
    expect(snapshot.tabs.map((tab) => tab.id)).toEqual(["w1:t2", "w2:t1", "w2:t2"])
    expect(snapshot.panes.map((pane) => [pane.id, pane.status])).toEqual([
      ["w1:pH", "working"],
      ["w1:pY", "unknown"],
      ["w2:p1", "unknown"],
      ["w2:p2", "idle"],
      ["w2:p3", "unknown"]
    ])
  })

  it("names an agent by its Herdr name, a plain pane by its label, and carries the agent's session", () => {
    const [agent, labelled, plain] = snapshotOf(raw).panes

    expect(agent?.agent).toEqual(Option.some("claude"))
    expect(agent?.name).toEqual(Option.some("reviewer"))
    expect(Option.isSome(agent?.session ?? Option.none())).toBe(true)
    expect(labelled?.name).toEqual(Option.some("helper"))
    expect(plain?.agent).toEqual(Option.none())
    expect(plain?.cwd).toBe("/home/user/code/project-3")
  })

  it("falls back to the pane's own folder, then to none", () => {
    const panes = snapshotOf(raw).panes

    expect(panes.map((pane) => pane.cwd).slice(3)).toEqual(["/home/user/code/project-4", ""])
    expect(Schema.encodeSync(RawSnapshot)(raw).result.snapshot.panes.length).toBe(5)
  })

  it("reads a status Herdr adds later as unknown instead of failing", () => {
    const later = Schema.decodeSync(RawSnapshot)({
      result: {
        snapshot: {
          version: "9.9.9",
          workspaces: [{ workspace_id: "w1", label: "a", number: 1, agent_status: "dreaming" }],
          tabs: [],
          panes: [],
          agents: []
        }
      }
    })

    expect(snapshotOf(later).workspaces[0]?.status).toBe("unknown")
  })
})
