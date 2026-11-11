import { describe, expect, it } from "@effect/vitest"
import { Option } from "effect"
import {
  agentProcesses,
  claudeStatusOf,
  claudesOf,
  insideOf,
  isPlainKind,
  kindOf,
  newestOf,
  piFolderOf,
  plainSnapshotOf
} from "./Found.ts"
import type { Proc } from "./Processes.ts"
import { ancestorsOf, baseName, commandOf, cwdOfLsof, processesOf, tableOf } from "./Processes.ts"

const ps = [
  "    1     0 /sbin/init",
  "  100     1 /usr/bin/herdr server",
  "  110   100 /usr/bin/zsh",
  "  120   110 /home/demo/.local/share/mise/installs/claude/latest/claude --dangerously-skip-permissions",
  "  200     1 /usr/bin/zsh",
  "  210   200 /home/demo/.local/share/mise/installs/claude/latest/claude",
  "  220   200 /home/demo/.local/share/mise/installs/claude/latest/claude daemon run",
  "  300     1 /Users/demo/.local/bin/herdr-core hold --socket /tmp/x.sock",
  "  310   300 /opt/pi/pi --provider opencode-go",
  "  400   200 /opt/pi/pi",
  "  500   200 /opt/opencode/bin/opencode",
  "  501   500 /opt/opencode/bin/opencode.exe",
  "  600   200 node /opt/codex/bin/codex",
  "not a process line"
].join("\n")

const procs = processesOf(ps)

const named = (argv: ReadonlyArray<string>): string => commandOf({ pid: 1, ppid: 0, argv })

const claudeFile = (pid: number, extra: Record<string, unknown>) =>
  JSON.stringify({ pid, sessionId: `s-${pid}`, cwd: `/home/demo/p${pid}`, kind: "interactive", ...extra })

describe("the machine's processes", () => {
  it("reads ps lines into pid, parent and arguments", () => {
    expect(procs.length).toBe(13)
    expect(procs[3]).toEqual({
      pid: 120,
      ppid: 110,
      argv: ["/home/demo/.local/share/mise/installs/claude/latest/claude", "--dangerously-skip-permissions"]
    })
  })

  it("names a process by its program, looking through node and bun", () => {
    expect([
      named(["/usr/bin/herdr", "server"]),
      named(["node", "/opt/codex/bin/codex"]),
      named(["bun"]),
      named([])
    ]).toEqual(["herdr", "codex", "", ""])
    expect(baseName("/a/b/")).toBe("b")
  })

  it("walks a process's ancestors and stops at a loop", () => {
    const loop: ReadonlyArray<Proc> = [
      { pid: 2, ppid: 3, argv: ["a"] },
      { pid: 3, ppid: 2, argv: ["b"] }
    ]
    const table = tableOf(procs)
    const child = table.get(120)

    expect(child === undefined ? [] : ancestorsOf(table, child).map((found) => found.pid)).toEqual([110, 100, 1])
    expect(ancestorsOf(tableOf(loop), { pid: 9, ppid: 2, argv: [] }).map((found) => found.pid)).toEqual([2, 3])
  })

  it("reads a working folder from lsof's answer", () => {
    expect(cwdOfLsof("p310\nfcwd\nn/Users/demo/api\n")).toEqual(Option.some("/Users/demo/api"))
    expect(cwdOfLsof("p310\n")).toEqual(Option.none())
  })
})

describe("agents started outside a multiplexer", () => {
  const inside = insideOf(["herdr", "herdr-core", "claude"])

  it("finds each agent's own process, leaving out those inside Herdr or the Herdr app and their helpers", () => {
    expect(agentProcesses(procs, "pi", inside).map((found) => found.pid)).toEqual([400])
    expect(agentProcesses(procs, "opencode", inside).map((found) => found.pid)).toEqual([500])
    expect(agentProcesses(procs, "codex", inside).map((found) => found.pid)).toEqual([600])
    expect(agentProcesses(procs, "pi", new Set()).map((found) => found.pid)).toEqual([310, 400])
    expect(Option.getOrNull(kindOf({ pid: 1, ppid: 0, argv: ["/usr/bin/zsh"] }))).toBeNull()
  })

  it("finds live interactive Claudes from Claude's own process files", () => {
    const files = [
      claudeFile(120, { status: "busy", name: "inside", nameSource: "user" }),
      claudeFile(210, { status: "busy", name: "api", nameSource: "user" }),
      claudeFile(220, { kind: "bg" }),
      claudeFile(999, {}),
      claudeFile(400, {}),
      "{broken"
    ]

    expect(claudesOf(procs, files, inside)).toEqual([
      { pid: 210, cwd: "/home/demo/p210", session: Option.some("s-210"), name: Option.some("api"), status: "working" }
    ])
    expect(claudesOf(procs, [claudeFile(210, { name: "api-3f", nameSource: "derived" })], inside)[0]?.name).toEqual(
      Option.none()
    )
  })

  it("reads Claude's status words", () => {
    expect([claudeStatusOf("busy"), claudeStatusOf("idle"), claudeStatusOf("waiting"), claudeStatusOf(null)]).toEqual([
      "working",
      "idle",
      "blocked",
      "unknown"
    ])
  })

  it("shows the agents of one kind as one workspace and tab named for it", () => {
    const found = [
      { pid: 210, cwd: "/home/demo/api", session: Option.none(), name: Option.none(), status: "idle" as const },
      { pid: 211, cwd: "/home/demo/web", session: Option.none(), name: Option.none(), status: "working" as const }
    ]
    const snapshot = plainSnapshotOf("pi", found)

    expect(snapshot.workspaces).toEqual([{ id: "wpi", label: "Pi", number: 0, status: "working" }])
    expect(snapshot.tabs).toEqual([{ id: "wpi:tpi", workspace: "wpi", label: "Pi", number: 0, status: "working" }])
    expect(snapshot.panes.map((pane) => pane.id)).toEqual(["wpi:p210", "wpi:p211"])
    expect(plainSnapshotOf("codex", [])).toEqual({ herdrVersion: "", workspaces: [], tabs: [], panes: [] })
    const quiet = { pid: 7, cwd: "/", session: Option.none(), name: Option.none(), status: "unknown" as const }
    expect(plainSnapshotOf("codex", [quiet]).workspaces[0]?.status).toBe("unknown")
  })

  it("knows where Pi keeps a folder's sessions and picks the newest", () => {
    expect(piFolderOf("/home/demo", "/home/demo/code")).toBe("/home/demo/.pi/agent/sessions/--home-demo-code--")
    expect(
      newestOf([
        { file: "a", at: 1 },
        { file: "b", at: 3 },
        { file: "c", at: 2 }
      ])
    ).toEqual(Option.some("b"))
    expect(newestOf([])).toEqual(Option.none())
    expect([isPlainKind("pi"), isPlainKind("tmux")]).toEqual([true, false])
  })
})
