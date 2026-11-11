import { describe, expect, it } from "@effect/vitest"
import { Option } from "effect"
import { PaneId, WorkspaceId } from "@sth-herdr/protocol/Herdr.ts"
import {
  claudePids,
  coreSnapshotOf,
  decodeClaudeSession,
  expandHome,
  firstLine,
  isClaudeReady,
  keysOfText,
  mostUrgent,
  newPlace,
  rpcLine,
  runArgs,
  terminalOf
} from "./Core.ts"
import type { CoreSpace, CoreTerminal } from "./Core.ts"

const terminal = (address: string, extra: Partial<CoreTerminal> = {}): CoreTerminal => ({
  address,
  state: "live",
  ...extra
})

const noSessions = () => Option.none<string>()

const snapshot = (terminals: ReadonlyArray<CoreTerminal>, spaces: ReadonlyArray<CoreSpace> = []) =>
  coreSnapshotOf({ version: "0.1.18", terminals, spaces, sessionOf: noSessions })

describe("herdr-core's terminals as Herdr panes", () => {
  it("puts a terminal in the app's space and tab, by where its pane is or by its labels", () => {
    const spaces: ReadonlyArray<CoreSpace> = [
      {
        id: "spA",
        name: "",
        folder: "/code/app",
        tabs: [{ id: "tbA", name: "main", root: { children: [{ content: { terminal: "t1" } }] } }]
      }
    ]
    const found = snapshot(
      [
        terminal("t1", { status: { state: "working", app: "claude-code" } }),
        terminal("t2", { labels: { "herdr.space": "spD", "herdr.tab": "tbD" }, status: { state: "idle", app: "pi" } })
      ],
      spaces
    )

    expect(found.panes.map((pane) => [pane.id, pane.workspace, pane.tab])).toEqual([
      ["wspA:pt1", "wspA", "wspA:ttbA"],
      ["wspD:pt2", "wspD", "wspD:ttbD"]
    ])
    expect(found.workspaces.map((workspace) => [workspace.label, workspace.number, workspace.status])).toEqual([
      ["app", 1, "working"],
      ["wspD", 2, "idle"]
    ])
    expect(found.tabs.map((tab) => [tab.id, tab.label])).toEqual([
      ["wspA:ttbA", "main"],
      ["wspD:ttbD", "2"]
    ])
  })

  it("names an agent from its status report, or from the command it was started with", () => {
    const found = snapshot([
      terminal("t1", { status: { state: "done", app: "claude-code" } }),
      terminal("t2", { argv: ["/opt/bin/codex", "--yolo"] }),
      terminal("t3", { argv: ["vim"] }),
      terminal("t4", { argv: [] })
    ])

    expect(found.panes.map((pane) => [pane.id, Option.getOrNull(pane.agent), pane.status])).toEqual([
      ["wcore:pt1", "claude", "done"],
      ["wcore:pt2", "codex", "unknown"]
    ])
    expect(found.workspaces).toEqual([
      { id: WorkspaceId.make("wcore"), label: "Other terminals", number: 1, status: "done" }
    ])
  })

  it("leaves out finished terminals, and plain programs it can't place", () => {
    const found = snapshot([
      terminal("t1", { state: "finished", status: { state: "idle", app: "claude-code" } }),
      terminal("t2", { labels: { "herdr.space": "spC" } }),
      terminal("t3", { labels: { "herdr.space": "sp C", "herdr.tab": "tbC" }, argv: ["zsh"] }),
      terminal("t5", { labels: { "herdr.space": "spE", "herdr.tab": "t b" }, argv: ["zsh"] }),
      terminal("t/4", { argv: ["claude"] })
    ])

    expect(found.panes).toEqual([])
  })

  it("finds a Claude agent's session by its process", () => {
    const found = coreSnapshotOf({
      version: "0.1.18",
      terminals: [
        terminal("t1", { status: { state: "idle", app: "claude-code" }, foreground: { pid: 7 } }),
        terminal("t2", { status: { state: "idle", app: "pi" }, foreground: { pid: 8 } })
      ],
      spaces: [],
      sessionOf: (pid) => Option.some(`session-${pid}`)
    })

    expect(found.panes.map((pane) => Option.getOrNull(pane.session))).toEqual(["session-7", null])
  })

  it("takes the title the agent reported over the terminal's own", () => {
    const found = snapshot([
      terminal("t1", { status: { state: "working", app: "claude-code", title: "Run tests" }, title: "Claude" }),
      terminal("t2", { status: { state: "working", app: "claude-code" }, title: "Claude", cwd: "/code" })
    ])

    expect(found.panes.map((pane) => [Option.getOrNull(pane.title), pane.cwd])).toEqual([
      ["Run tests", ""],
      ["Claude", "/code"]
    ])
  })
})

describe("addresses between the phone and herdr-core", () => {
  it("gets the terminal back from a pane id", () => {
    expect(terminalOf(PaneId.make("wspA:pt12"))).toBe("t12")
  })

  it("makes a new tab in a space, or a new space", () => {
    expect(newPlace(Option.some(WorkspaceId.make("wspA")), "x-1")).toEqual({ space: "spA", tab: "tbx1" })
    expect(newPlace(Option.none(), "ab")).toEqual({ space: "spab", tab: "tbab" })
  })

  it("ranks statuses as the app does", () => {
    expect(mostUrgent(["idle", "working", "done"])).toBe("done")
    expect(mostUrgent(["idle", "blocked"])).toBe("blocked")
    expect(mostUrgent([])).toBe("unknown")
  })
})

describe("talking to hc", () => {
  it("types plain text as keys, and refuses what it can't type", () => {
    expect(keysOfText("a b/")).toEqual(Option.some(["a", "space", "b", "/"]))
    expect(keysOfText("café")).toEqual(Option.none())
  })

  it("starts an agent kept by the core, in its space and tab", () => {
    expect(runArgs({ name: "demo", cwd: "/code", kind: "claude", place: { space: "spA", tab: "tbB" } })).toEqual([
      "run",
      "--bg",
      "--keep",
      "--no-parent",
      "--json",
      "--name",
      "demo",
      "--cwd",
      "/code",
      "--label",
      "herdr.space=spA",
      "--label",
      "herdr.tab=tbB",
      "--",
      "claude"
    ])
    expect([expandHome("~/code", "/home/me"), expandHome("~", "/home/me"), expandHome("/srv", "/home/me")]).toEqual([
      "/home/me/code",
      "/home/me",
      "/srv"
    ])
  })

  it("writes one JSON-RPC line and reads the first line back", () => {
    expect(JSON.parse(rpcLine("terminal.list", {}))).toEqual({
      jsonrpc: "2.0",
      id: 1,
      method: "terminal.list",
      params: {}
    })
    expect([firstLine("a\nb"), firstLine("")]).toEqual(["a", ""])
  })

  it("reads Claude's session record, and finds the Claude processes to read", () => {
    expect(Option.map(decodeClaudeSession('{"sessionId":"abc"}'), (found) => found.sessionId)).toEqual(
      Option.some("abc")
    )
    expect(decodeClaudeSession("nope")).toEqual(Option.none())
    expect(
      claudePids([
        terminal("t1", { argv: ["claude"], foreground: { pid: 3 } }),
        terminal("t2", { argv: ["claude"] }),
        terminal("t3", { status: { state: "idle", app: "pi" }, foreground: { pid: 4 } })
      ])
    ).toEqual([3])
  })
})

describe("an agent the Herdr app put to sleep", () => {
  const asleep = terminal("t1", {
    labels: { "sth.sleep": "6f1c2d3e-0000-4000-8000-000000000001" },
    status: { state: "idle", app: "claude-asleep" },
    foreground: { pid: 12, name: "zsh" }
  })

  it("is listed as an asleep Claude agent with the session it will resume", () => {
    const [pane] = snapshot([asleep]).panes

    expect([pane?.status, pane?.agent, pane?.session]).toEqual([
      "asleep",
      Option.some("claude"),
      Option.some("6f1c2d3e-0000-4000-8000-000000000001")
    ])
    expect(isClaudeReady(asleep)).toBe(false)
  })

  it("is awake once Claude runs in it again, and ready when Claude is idle", () => {
    const woken = {
      ...asleep,
      labels: {},
      status: { state: "idle", app: "claude-code" },
      foreground: { pid: 13, name: "claude" }
    }

    expect(snapshot([woken]).panes[0]?.status).toBe("idle")
    expect(isClaudeReady(woken)).toBe(true)
    expect(isClaudeReady({ ...woken, status: { state: "working", app: "claude-code" } })).toBe(false)
  })
})
