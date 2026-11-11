# sth-herdr-connector

Connects the agents on one machine to a hub, outbound only, so a phone or web app can see and talk to them.

It reads the [Herdr](https://github.com/herdrdev/herdr) TUI and the Herdr desktop app (herdr-core, `hc`) on the
machine it runs on, plus Claude Code, Codex, OpenCode and Pi sessions running outside them. It reports every agent
(name, folder, status, including agents the app put to sleep) to the hub. The hub can then:

- send a prompt (waking a sleeping agent first)
- send keys
- read the screen or the conversation
- start an agent
- open a live terminal

The connector opens no port. It keeps one WebSocket to the hub and does what the hub asks over it.

This repository holds the connector and the protocol it speaks (`protocol/`). The hub is a separate, private
program; anyone can write a compatible hub or client from the protocol.

## Install

```sh
brew install seethruhead/tap/sth-herdr-connector
```

The formula installs a prebuilt binary from this repository's releases (macOS arm64 and x64, Linux x64 and arm64).

## Configure

The connector reads two files, or the matching environment variables:

| File | Variable | What |
|---|---|---|
| `~/.config/sth-herdr/hub` | `HERDR_HUB_URL` | The hub's connector address, `wss://<hub>/connector` |
| `~/.config/sth-herdr/token` | `HERDR_HUB_TOKEN_FILE` (another path) | This machine's token |

Make the token on the machine itself, and give the hub only its hash (SHA-256, unpadded base64url). The token never
has to leave the machine:

```sh
umask 077
mkdir -p ~/.config/sth-herdr
printf 'wss://hub.example/connector\n' > ~/.config/sth-herdr/hub
openssl rand -base64 48 | tr -d '\n=' | tr '+/' '-_' > ~/.config/sth-herdr/token
openssl dgst -sha256 -binary < ~/.config/sth-herdr/token | openssl base64 -A | tr '+/' '-_' | tr -d '='; echo
```

Check that it reaches the hub, then run it as a service:

```sh
HERDR_CONNECTOR_PROBE=1 sth-herdr-connector
brew services start sth-herdr-connector
```

The connector finds `herdr` and `hc` on the service's PATH (Homebrew's bin, the system paths, then
`~/.local/bin`). `HERDR_BIN`, `HERDR_SESSION`, `HERDR_CORE_BIN`, `HERDR_CORE_SESSION` and `HERDR_SOURCES` (a
comma-separated list of `herdr`, `herdr-core`, `claude`, `codex`, `opencode`, `pi`) override what it finds.

## Build from source

```sh
bun install
bun run check
bun build --compile connector/src/app/server.ts --outfile sth-herdr-connector
```

## Protocol

See [protocol/README.md](protocol/README.md).
