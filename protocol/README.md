# The connector protocol

The connector and the hub talk [Effect RPC](https://effect.website) over one WebSocket, as newline-delimited JSON.
Every message is described by an Effect `Schema` in this package, so a hub or a client in TypeScript can import the
schemas and get the same encoding and validation. Anything else can follow the JSON shapes the schemas define.

- `src/Connector.ts`: the RPC group (`ConnectorRpcs`) and every command, outcome and payload.
- `src/Herdr.ts`: what a machine looks like: workspaces, tabs, panes (agents) and their status.
- `src/Transcript.ts`: a conversation as items: what was said, tool calls and results, pictures.

## Connecting

The connector opens a WebSocket to `wss://<hub>/connector` (`connectorPath`) with
`Authorization: Bearer <token>`. The hub hashes the token (SHA-256, unpadded base64url), finds the machine whose
hash matches, and refuses anything else with `ConnectorRefused`. The `ConnectorAuth` middleware provides the
authenticated machine (`ConnectedMachine`) to every handler.

## The calls the connector makes

| RPC | What |
|---|---|
| `Attach` | Sends the connector's version and a first snapshot, then streams `HubCommand`s back for as long as the connection lives. |
| `Report` | Sends a new snapshot whenever something changed (polled every second, unchanged snapshots are not sent). |
| `Answer` | Answers a command by its `CommandId` with an `Outcome`. |
| `ScreenOutput` | Streams a live terminal's output for a screen the hub opened. |
| `Probe` | Checks the token and the connection; the connector's `HERDR_CONNECTOR_PROBE=1` mode does only this. |
| `LatestConnector`, `DownloadConnector` | Let a hub serve connector bundles to connectors that update themselves. A hub may answer `None` and refuse. |

## Snapshots

A `Snapshot` lists the machine's workspaces, tabs and panes. A pane is one terminal:

- **Where and what:** its id, its workspace and tab, the agent running in it (`claude`, `codex`, `pi`, `opencode`, ...), its name, folder and title.
- **Status:** `working`, `blocked` (waiting for the person), `done`, `idle`, `asleep` (put to sleep by the Herdr app, woken by the next prompt), `errored` or `unknown`.
- **Optional:**
  - `session`: the agent's own session id, used to read its conversation.
  - `source`: which program reported the pane.
  - `abilities`: what the hub may do with it: prompt, keys, screen.
  - `failure`: the last turn's error, when it failed.
  - `active`: when it last spoke, epoch milliseconds, from its conversation.

## Commands the hub sends

Each `HubCommand` carries a `CommandId` (UUID v7), and the connector answers each one exactly once:

| Command | What it asks | Answer |
|---|---|---|
| `ReadPane` | Read a pane's screen (text or ANSI). | `PaneText` |
| `Prompt` | Send a prompt, with up to four files (base64). A sleeping agent is woken first. | `Done`, or `Refused` with a reason |
| `SendKeys` | Send keys. | `Done`, or `Refused` |
| `SendText` | Type text. | `Done`, or `Refused` |
| `StartAgent` | Start an agent. | `Started` with its pane |
| `ReadTranscript` | Read an agent's conversation. | `TranscriptRead` |
| `ListCommands` | List an agent's slash commands. | `CommandsListed` |
| `OpenScreen`, `ScreenInput`, `ResizeScreen`, `CloseScreen` | Drive a live terminal; its output comes back through `ScreenOutput`. | `Done` |

Files sent with a prompt are written to `~/.cache/sth-herdr/uploads/` on the machine, and their paths are attached
to the prompt.

## Compatibility

The schemas are the contract. A change that adds an optional field keeps old connectors and hubs working; anything
else is a new major version of the connector.
