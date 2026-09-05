# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Fork of `luc-github/ESP3D-WEBUI` (the generic upstream WebUI for ESP3D, supporting Marlin/Repetier/
Smoothieware/GRBL/grblHAL), maintained specifically for FluidNC. Default branch here is `3.0-FluidNCDev`.
This is the exact repo/release FluidNC's own `build-release.py` pulls the WebUI3 bundle from
(`https://github.com/michmela44/ESP3D-WEBUI/releases/latest/download/index.html.gz`). `origin` is your own
fork (`WaldemarFech/ESP3D-WEBUI`), `upstream` is `michmela44/ESP3D-WEBUI`.

Do **not** confuse this with `luc-github/ESP3D-WEBUI` (the true original) — that repo has no FluidNC target
at all (only `GRBL`/`grblHAL` under `src/targets/CNC/`), so a FluidNC-specific bug here won't exist there,
and fixes belong in *this* fork, not further upstream.

The companion FluidNC firmware repo (the C++ ESP32 firmware this WebUI talks to) is a sibling checkout at
`../FluidNC` — useful as read-only reference (e.g. for exact realtime status-report field names in
`FluidNC/src/Report.cpp`). Changes in this repo should not require firmware changes unless truly unavoidable
— nearly everything this WebUI needs is already exposed over the existing WebSocket/HTTP API.

## Build & dev commands

- `npm install`
- `npm run type-check` — `tsc --noEmit`
- `npm run build` — webpack prod build, produces `dist/index.html.gz` (a single gzipped file — this *is*
  what gets uploaded to a board's flash filesystem, see below)
- `npm run dev` — webpack dev server + local mock server (`npm run front` + `npm run server` concurrently)
- `npm run lint` / `npm run lint:fix` — eslint on `src --ext .ts,.tsx`
- Ignore the README's `npm run dev-<system>-<firmware>` / `npm run <system>-<firmware>` / `npm run buildall`
  commands — those describe the upstream project and don't exist in this fork's `package.json`. This fork's
  webpack config is hardcoded to one target (`config/targets/CNC/FluidNC/index.js` is the only target config
  present) — plain `npm run build` / `npm run dev` always builds/serves the FluidNC CNC target, nothing to
  select.

There is no unit/integration test suite (`npm test` is a stub). Validation is: build, then verify against a
real (or at least reachable) FluidNC board.

## Testing against a real board

- The board serves its local flash filesystem over HTTP. List files: `GET /files?action=list&filename=all&path=/`.
  Fetch a specific file directly: `GET /<filename>` (e.g. `/index.html.gz`, `/preferences.json`).
- To upload a file: multipart `POST /files` with fields `path` (target dir, e.g. `/`), `<filename>S` (the
  file size in bytes, as text) and `myfiles[]` (the file itself, filename with no leading slash matches what
  gets saved).
- **`curl -F` was unreliable for this** on at least one Windows curl build (8.17.0, mingw) — sometimes
  silently failed to transfer, sometimes reported a spurious error 26 on a transfer that had actually
  succeeded. `python3` + `requests` worked reliably every time:
  ```python
  requests.post(url, data={"path": "/", f"{name}S": str(len(data))},
                 files={"myfiles[]": (name, data, "application/octet-stream")})
  ```
- Always verify an upload actually landed by re-fetching the file and comparing a hash (`sha256sum`) against
  the local build — don't trust the HTTP status code alone given the curl flakiness above.
- The board's live `preferences.json` (distinct from this repo's default `preferences.json` template files)
  can be fetched/edited/re-uploaded the same way, useful for testing a settings/keymap change without going
  through the Settings UI by hand.
- Browser cache is aggressive — hard-refresh (Ctrl+F5) after every upload before judging a change.

## Architecture: the three-layer target system

Nearly everything (translations, default settings/preferences) is assembled from three layers, generic to
specific:

1. **Base** (`src/targets/`) — generic, not tied to any machine type
2. **Target** (`src/targets/CNC/`) — CNC-family generic (also has `GRBL`/`grblHAL`-flavored bits, mostly
   irrelevant here)
3. **Sub-target** (`src/targets/CNC/FluidNC/`) — FluidNC-specific; almost all real feature work happens here
   (`preferences.json` is the default settings/keymap template, `translations/en.json` and `style/` are
   FluidNC-specific)

**Preferences/settings merge correctly.** `src/targets/index.js` does
`mergeJSON(mergeJSON(base, target), subTarget)` (`mergeJSON` in `src/components/Helpers/arrays.ts`) — a real
recursive deep merge where list items are matched by `id`, and the more-specific layer's `value` wins/extends.
A FluidNC-specific `preferences.json` entry correctly overrides the same `id` from the CNC/base layer.

**Translations do not merge the same way — this has caused real bugs, watch out.**
`src/components/Translations/index.ts` builds `baseLangRessource` via plain object spread:
`{...LangRessourceSubTarget, ...LangRessourceTarget, ...LangRessourceBase}`. Object spread means the
*last*-spread object wins on key collision — so the generic **base** bundle
(`src/targets/translations/en.json`) actually overrides FluidNC-specific translations
(`src/targets/CNC/translations/en.json`), the *opposite* of how preferences merge. If you add a translation
override, grep the base bundle for that id first — otherwise it's silently dead code (this happened: a PR
here had to remove several dead `btn+X`/`btn-X`/etc. overrides for exactly this reason).
`languages/lang-*.json` (non-English packs) are separate flat files, not part of this merge chain — no
cross-layer collision risk there, but plain duplicate-JSON-key mistakes within one file are still possible
and silently resolve to whichever occurrence was parsed last.

## Settings/macros UI: the generic list editor

Settings sections like `keymap` and `macros` are `"type": "list"` entries in `preferences.json`, rendered/
edited generically by `src/components/Controls/Fields/ItemsList.tsx`, using
`src/tabs/interface/importHelper.ts`'s `formatItem()` to decide — per sub-field *name*, via a `switch(key)`,
not a declarative schema — what UI control to render (`type` becomes a `<select>` with a hardcoded options
array, `action` becomes a plain text input, etc.). To add a new dropdown option (e.g. a new macro type), edit
that switch's options array, add the actual behavior in the relevant panel's execution switch, and add a
translation string (`"SNNN"` numbering, see below).

**Macros**: `src/components/Panels/Macros.tsx`, `processMacro(action, type)`. Types: `FS` (filesystem
command via `[ESP700]`), `SD` (play a file), `URI` (`window.open()`, or a silent `fetch()` if the action is
prefixed with the literal string `"[SILENT]"` — legacy/undocumented), `URI_SILENT` (always a silent
background `fetch()`, no tab — the discoverable way to do this). `silentFetch()` in the same file is the
shared fire-and-forget GET helper — reuse it for anything hitting an external HTTP endpoint (e.g. a Tasmota
smart plug) without opening/navigating a tab. Works cross-origin even without CORS response headers on the
target, since a simple GET is still sent by the browser regardless (CORS only blocks *reading* the response).

**Keyboard shortcuts**: `keymap` list, matched against real keydown events in `src/pages/dashboard/index.tsx`
(`keyboardEventHandlerDown`). Collects *every* matching action for a keypress (not just the first/last), so
one key can legitimately be bound to two different actions and both fire. Recording a shortcut (`shortkey`
field type, `src/components/Controls/Fields/Input.tsx`) and matching one at runtime both build the key string
the same way — modifier prefixes (`Control+`/`Alt+`/`Shift+`/`Meta+`) based on whichever modifiers are
actually held, then the key itself. A binding's required modifiers are exactly whatever was physically held
when it was recorded, which can vary by keyboard layout for the same *character* (e.g. producing `#` needs
Shift on a US layout but not a German one) — a default keybinding baked into `preferences.json` for one
layout may simply need re-recording by users on a different layout; that's inherent to how recording/matching
works, not something to special-case.

Translation IDs follow existing conventions: sequential numeric `"SNNN"` IDs (check the current highest
number in `src/targets/translations/en.json` before picking a new one), or the literal button/action `id`
string itself (looked up via `T(id)`) for anything wired to a specific button element.

## Jog panel

`src/components/Panels/JogCNC.tsx` is the FluidNC jog controls — the largest, most FluidNC-specific file.
Notable: X/Y and Z have **independent** jog-distance selectors (own radio group, own state, own keyboard
shortcuts) — this used to be one shared control, so don't assume "the" distance means a single value; it's
`currentJogDistanceXY` / `currentJogDistanceZ` module-level state.

## Fork status snapshot (informational — verify current state with `gh`/`git`, this will go stale)

At last check, this fork was ~144 commits ahead of upstream `luc-github/ESP3D-WEBUI` `3.1` and ~36 behind —
the "ahead" is essentially the entire FluidNC target (doesn't exist upstream at all), the "behind" commits
were general build-tooling/infra (brotli compression, HTTPS/WSS detection, language-pack manifests), nothing
FluidNC-affecting.

Two PRs were opened against `michmela44/ESP3D-WEBUI` from this work:
- [#17](https://github.com/michmela44/ESP3D-WEBUI/pull/17) — fixes jog-distance keyboard shortcuts broken by
  the XY/Z split (upstream issue #14), the incomplete-shortcut validation bug, tooltip improvements.
- [#18](https://github.com/michmela44/ESP3D-WEBUI/pull/18) — adds the `URI_SILENT` macro type.

Check their current state (`gh pr view 17/18 --repo michmela44/ESP3D-WEBUI`) before assuming they're still
open/unmerged/unchanged.
