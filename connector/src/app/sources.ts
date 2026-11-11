import { Context, Effect, FileSystem, Layer, Option, Path } from "effect"
import type { ChildProcessSpawner } from "effect/process"
import type { Ability } from "@sth-herdr/protocol/Herdr.ts"
import { appAbilities, multiplexerAbilities, readOnly, sourceOf } from "../domains/agents/Source.ts"
import type { Source } from "../domains/agents/Source.ts"
import { Herdr } from "../domains/herdr/Herdr.ts"
import { insideOf, isPlainKind, plainKinds } from "../domains/plain/Found.ts"
import type { PlainKind } from "../domains/plain/Found.ts"
import { Plain } from "../domains/plain/Plain.ts"

export type SourceSettings = {
  readonly host: "herdr" | "herdr-core"
  readonly sources: Option.Option<string>
  readonly binary: Option.Option<string>
  readonly session: Option.Option<string>
  readonly coreBinary: Option.Option<string>
  readonly coreSession: Option.Option<string>
  readonly home: string
}

const isOldCoreLauncher = (settings: SourceSettings): boolean => settings.host === "herdr-core"

export const tuiBinaryOf = (settings: SourceSettings): string =>
  isOldCoreLauncher(settings) ? "herdr" : Option.getOrElse(settings.binary, () => "herdr")

export const tuiSessionOf = (settings: SourceSettings): Option.Option<string> =>
  isOldCoreLauncher(settings) ? Option.none() : settings.session

export const coreBinaryOf = (settings: SourceSettings, found: (binary: string) => boolean): string => {
  if (Option.isSome(settings.coreBinary)) return settings.coreBinary.value
  if (isOldCoreLauncher(settings) && Option.isSome(settings.binary)) return settings.binary.value
  const installed = `${settings.home}/.local/bin/hc`

  return found(installed) ? installed : "hc"
}

const coreSessionOf = (settings: SourceSettings): Option.Option<string> =>
  isOldCoreLauncher(settings) ? Option.orElse(settings.coreSession, () => settings.session) : settings.coreSession

export const sourceNamesOf = (settings: SourceSettings, found: (binary: string) => boolean): ReadonlyArray<string> => {
  if (Option.isSome(settings.sources))
    return settings.sources.value
      .split(",")
      .map((name) => name.trim())
      .filter((name) => name !== "")
  if (isOldCoreLauncher(settings)) return ["herdr-core"]
  const core = found(coreBinaryOf(settings, found)) ? ["herdr-core"] : []

  return ["herdr", ...core, ...plainKinds]
}

export const hostSource = <E, R>(name: string, abilities: ReadonlyArray<Ability>, layer: Layer.Layer<Herdr, E, R>) =>
  Effect.scoped(Effect.map(Layer.build(layer), (context) => sourceOf(name, abilities, Context.get(context, Herdr))))

export const plainSource = (kind: PlainKind, inside: ReadonlySet<string>) =>
  Plain.useSync((plain): Source => readOnly(kind, plain.snapshot(kind, inside)))

type SourceNeeds = ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path | Plain

export const sourcesOf = (
  settings: SourceSettings,
  names: ReadonlyArray<string>,
  found: (binary: string) => boolean
): ReadonlyArray<Effect.Effect<Source, never, SourceNeeds>> => {
  const inside = insideOf(names)
  const build = (name: string): ReadonlyArray<Effect.Effect<Source, never, SourceNeeds>> => {
    if (name === "herdr")
      return [
        hostSource(
          "herdr",
          multiplexerAbilities,
          Herdr.layer({ binary: tuiBinaryOf(settings), session: tuiSessionOf(settings), home: settings.home })
        )
      ]
    if (name === "herdr-core")
      return [
        hostSource(
          "herdr-core",
          appAbilities,
          Herdr.core({ binary: coreBinaryOf(settings, found), session: coreSessionOf(settings), home: settings.home })
        )
      ]
    if (isPlainKind(name)) return [plainSource(name, inside)]

    return []
  }

  return names.flatMap(build)
}
