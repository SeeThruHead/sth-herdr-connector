import { describe, expect, it } from "@effect/vitest"
import { itemsOf, pictureLimit, summaryOf } from "./Claude.ts"

const transcript = await Bun.file(new URL("../../../fixtures/transcript.jsonl", import.meta.url)).text()

describe("reading a Claude transcript", () => {
  it("turns each line into what a person reads, in order, skipping meta lines, thinking and junk", () => {
    expect(itemsOf(transcript).map((item) => item._tag)).toEqual([
      "Said",
      "ToolCall",
      "ToolResult",
      "Picture",
      "ToolResult",
      "Said",
      "Said",
      "Picture",
      "Said",
      "ToolResult",
      "ToolResult",
      "Said"
    ])
  })

  it("shows a tool that returned nothing, and cuts a long result short", () => {
    const results = itemsOf(transcript).filter((item) => item._tag === "ToolResult")

    expect(results[2]).toMatchObject({ call: "toolu_3", text: "" })
    expect(results[3]?._tag === "ToolResult" && results[3].text.length).toBe(4002)
  })

  it("keeps who said what, with the agent's markdown as written", () => {
    const said = itemsOf(transcript).flatMap((item) => (item._tag === "Said" ? [[item.who, item.markdown]] : []))

    expect(said).toEqual([
      ["person", "Read the notes and summarise them."],
      ["agent", "The notes have **two** lines."],
      ["person", "Here is a screenshot"],
      ["person", "/clear"],
      ["agent", "plain string from the agent"]
    ])
  })

  it("names a tool call by its tool and its main argument", () => {
    const call = itemsOf(transcript).find((item) => item._tag === "ToolCall")

    expect(call).toMatchObject({ tool: "Read", summary: "/home/user/notes.md", id: "toolu_1" })
  })

  it("shows a tool's text, whether it failed, and the images it returned", () => {
    const items = itemsOf(transcript)

    expect(items.filter((item) => item._tag === "ToolResult").slice(0, 2)).toMatchObject([
      { call: "toolu_1", text: "line one\nline two", failed: false },
      { call: "toolu_2", text: "command not found", failed: true }
    ])
    expect(items.filter((item) => item._tag === "Picture")).toMatchObject([
      { mediaType: "image/png", base64: "iVBORw0KGgo=" },
      { mediaType: "image/jpeg", base64: "/9j/4AAQ" }
    ])
  })

  it("leaves out a picture too large for a phone and says so", () => {
    const huge = JSON.stringify({
      type: "user",
      uuid: "big",
      message: {
        content: [
          { type: "image", source: { type: "base64", media_type: "image/png", data: "A".repeat(pictureLimit + 1) } }
        ]
      }
    })

    expect(itemsOf(huge)).toMatchObject([{ _tag: "Said", markdown: "_An image too large to show here._" }])
  })

  it("summarises a call by the first argument a person would recognise", () => {
    expect(summaryOf({ command: "ls -la\nsecond line" })).toBe("ls -la")
    expect(summaryOf({ command: "ls", description: "List files" })).toBe("List files")
    expect(summaryOf({ pattern: "", url: "https://example.com" })).toBe("https://example.com")
    expect(summaryOf({ other: 3 })).toBe("")
  })

  it("shows a message sent while the agent was working, and ignores other attachments", () => {
    const lines = [
      JSON.stringify({
        type: "attachment",
        uuid: "q1",
        attachment: { type: "queued_command", prompt: "That one didn't show up.", commandMode: "prompt" }
      }),
      JSON.stringify({ type: "attachment", uuid: "q2", attachment: { type: "hook_success" } }),
      JSON.stringify({
        type: "attachment",
        uuid: "q3",
        attachment: {
          type: "queued_command",
          prompt: [
            { type: "text", text: "with a picture" },
            { type: "image", source: { type: "base64", media_type: "image/png", data: "AA==" } }
          ]
        }
      })
    ].join("\n")

    expect(itemsOf(lines)).toEqual([
      { _tag: "Said", id: "q1", who: "person", markdown: "That one didn't show up.", queued: true },
      { _tag: "Said", id: "q3-0", who: "person", markdown: "with a picture", queued: true },
      { _tag: "Picture", id: "q3-1", mediaType: "image/png", base64: "AA==" }
    ])
  })

  it("shows a pasted message as the text that was pasted, without Claude's paste markers", () => {
    const lines = [
      JSON.stringify({
        type: "user",
        uuid: "p1",
        message: {
          content: [
            {
              type: "text",
              text: '\n\n<pasted_content id="e259">\nSee it twice.\nAnd paste.\n</pasted_content id="e259">\n'
            }
          ]
        }
      }),
      JSON.stringify({
        type: "user",
        uuid: "p2",
        message: { content: 'before <pasted_content id="a1">\npasted\n</pasted_content id="a1"> after' }
      })
    ].join("\n")

    expect(itemsOf(lines)).toEqual([
      { _tag: "Said", id: "p1-0", who: "person", markdown: "See it twice.\nAnd paste." },
      { _tag: "Said", id: "p2", who: "person", markdown: "before pasted after" }
    ])
  })

  it("leaves out background task notices and reminders Claude Code adds to a message", () => {
    const lines = [
      JSON.stringify({
        type: "user",
        uuid: "n1",
        message: {
          content: "<task-notification>\n<task-id>b1</task-id>\n<status>completed</status>\n</task-notification>"
        }
      }),
      JSON.stringify({
        type: "user",
        uuid: "n2",
        message: { content: "Look again.\n<system-reminder>\nUse the tools.\n</system-reminder>" }
      })
    ].join("\n")

    expect(itemsOf(lines)).toEqual([{ _tag: "Said", id: "n2", who: "person", markdown: "Look again." }])
  })

  it("shows the files sent with a message by name, above the message", () => {
    const lines = [
      JSON.stringify({
        type: "user",
        uuid: "u1",
        message: {
          content:
            "Look at this\n\n[Attached: /Users/demo/.cache/sth-herdr/uploads/1762-0-image.png]\n[Attached: /x/1762-1-a.pdf]"
        }
      }),
      JSON.stringify({ type: "user", uuid: "u2", message: { content: "[Attached: /x/1762-0-b.png]" } })
    ].join("\n")

    expect(itemsOf(lines).map((item) => (item._tag === "Said" ? [item.id, item.markdown] : []))).toEqual([
      ["u1-f0", "📎 image.png"],
      ["u1-f1", "📎 a.pdf"],
      ["u1", "Look at this"],
      ["u2-f0", "📎 b.png"]
    ])
  })

  it("shows a slash command as what you typed, and what it printed under it", () => {
    const esc = String.fromCodePoint(27)
    const lines = [
      JSON.stringify({
        type: "system",
        subtype: "local_command",
        uuid: "c1",
        content:
          "<command-name>/context</command-name>\n<command-message>context</command-message>\n<command-args></command-args>"
      }),
      JSON.stringify({
        type: "system",
        subtype: "local_command",
        uuid: "c2",
        content: `<local-command-stdout> ${esc}[1mContext Usage${esc}[22m\n94k tokens</local-command-stdout>`
      }),
      JSON.stringify({
        type: "system",
        subtype: "local_command",
        uuid: "c3",
        content: "<local-command-stdout></local-command-stdout>"
      }),
      JSON.stringify({
        type: "user",
        uuid: "c4",
        message: { content: "<command-name>/review</command-name><command-args>the diff</command-args>" }
      }),
      JSON.stringify({
        type: "user",
        uuid: "c5",
        message: { content: "<local-command-stderr>no such thing</local-command-stderr>" }
      }),
      JSON.stringify({
        type: "system",
        subtype: "local_command",
        uuid: "c6",
        content: "<command-name>/clear</command-name>"
      })
    ].join("\n")

    expect(itemsOf(lines)).toEqual([
      { _tag: "Said", id: "c1", who: "person", markdown: "/context" },
      { _tag: "Said", id: "c2", who: "agent", markdown: "```\nContext Usage\n94k tokens\n```" },
      { _tag: "Said", id: "c4", who: "person", markdown: "/review the diff" },
      { _tag: "Said", id: "c5", who: "agent", markdown: "```\nno such thing\n```" },
      { _tag: "Said", id: "c6", who: "person", markdown: "/clear" }
    ])
  })

  it("marks a stopped turn as interrupted, on the agent's side", () => {
    const lines = [
      JSON.stringify({
        type: "user",
        uuid: "i1",
        message: { content: [{ type: "text", text: "[Request interrupted by user]" }] }
      }),
      JSON.stringify({ type: "user", uuid: "i2", message: { content: "[Request interrupted by user for tool use]" } })
    ].join("\n")

    expect(itemsOf(lines)).toEqual([
      { _tag: "Said", id: "i1-0", who: "agent", markdown: "Interrupted", failed: true },
      { _tag: "Said", id: "i2", who: "agent", markdown: "Interrupted", failed: true }
    ])
  })

  it("shows an API error as a failed reply with Claude's own words", () => {
    const lines = [
      JSON.stringify({
        type: "assistant",
        uuid: "e1",
        isApiErrorMessage: true,
        error: "rate_limit",
        message: {
          content: [
            { type: "text", text: "You've hit your weekly limit" },
            { type: "tool_use", id: "t1", name: "x", input: {} }
          ]
        }
      }),
      JSON.stringify({ type: "assistant", uuid: "e2", isApiErrorMessage: true, message: { content: "" } }),
      JSON.stringify({ type: "assistant", uuid: "e3", isApiErrorMessage: true, message: { content: "API Error: 500" } })
    ].join("\n")

    expect(itemsOf(lines)).toEqual([
      { _tag: "Said", id: "e1", who: "agent", markdown: "You've hit your weekly limit", failed: true },
      { _tag: "Said", id: "e2", who: "agent", markdown: "The turn failed.", failed: true },
      { _tag: "Said", id: "e3", who: "agent", markdown: "API Error: 500", failed: true }
    ])
  })
})
