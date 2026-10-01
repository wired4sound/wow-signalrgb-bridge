# WoW to SignalRGB Bridge

Drives SignalRGB Pro lighting from real World of Warcraft events. Target game: **WoW Forever** (Blizzard's Classic+, beta in 2026). Windows only (the screen beacon reader uses PowerShell and Win32 capture).

Personal setup notes, if present, are in `CLAUDE.local.md` (git-ignored).

## Why this exists

SignalRGB's built-in WoW integration screen-scrapes the default UI's health/mana bars. It breaks with UI changes, only works on the primary display at a supported resolution, and fails on ultrawide setups where WoW runs in part of the screen. Addons are sandboxed (no file or network I/O), and Forever uses the Midnight-era restricted API, where the player's health and mana are **secret values** for addons.

Two inputs:

```
SignalBeacon addon strip (top-left of game) -> tools/beacon-reader.ps1 (PrintWindow, 10 Hz) -> src/beacon.js ┐
Logs/WoWCombatLog-*.txt (2-13s late) -> watcher -> parser -> tracker ─────────────────────────────────────┤
                                                                     rules -> controller -> SignalRGB API ┘
```

The beacon owns player state (health, mana, dead, ghost, combat) and encounter start/end while it is healthy; matching combat log events are dropped (`BeaconTracker.shouldDropLogEvent`). After 10s without a good reading (logout, Alt+Z, minimized) the beacon is marked down and the combat log takes over.

## Commands

```
start-bridge.cmd                   # double-click: bridge + opens the settings page
node src/index.js [--open]         # live: beacon + combat log + settings page on http://127.0.0.1:17700/
node src/index.js --dry-run        # never calls SignalRGB or writes its Effects folder
node src/index.js --replay <file>  # instant replay of a saved log through the rules (no beacon)
node src/index.js --no-beacon --logs <dir> --config <file>
node tools/srgb.js status|list|apply <name> [preset]|presets <name>|brightness <n>|flash <name> [ms]
node tools/fake-log.js --dir <Logs> --speed 2   # scripted fight for dry-run testing
node tools/layout.js               # SignalRGB layout from the registry + which zone each device lands in
node tools/wiring-test.js          # red band sweeping the layout: shows LED order / mirrored chains
node tools/identify-test.js        # static color per zone (rainbow on bars and strips)
node tools/led-count-test.js [secs] [fine|confirm]   # colored LED blocks to count LEDs per fan
node tools/worklight.js [#rrggbb]  # everything one color until stopped
node tools/anonymize-log.js <file> [--me <name>]    # fake names/GUIDs before sharing a combat log
node tools/lua-check.js            # rough block/paren balance check of the addon Lua
powershell -ExecutionPolicy Bypass -File tools\beacon-reader.ps1 [-ImagePath shot.png]
powershell -ExecutionPolicy Bypass -File tools\restart-signalrgb.ps1
npm test                           # 47 tests (use test/fixtures/rules.json, not the live rules.json) incl. a real (anonymized) Forever log fixture and the reader on generated PNGs
```

No npm dependencies. Node 18+ (global `fetch`).

Stop the running bridge with `POST /api/shutdown` (header `X-Bridge: 1`) or Ctrl+C / closing its window. A hard kill skips the baseline restore and leaves the last effect on the lights.

## Layout

- `src/index.js`: CLI; starts `BridgeApp` + the web server; replay mode.
- `src/app.js`: the running bridge. Wires log + beacon to the rule engine, owns settings (`config.json`), rules (`rules.json`) and effect designs (`effects.json`) with hot reload, effect pings, activity log, `getState()` for the UI.
- `src/server.js`: settings page + JSON API, 127.0.0.1 only. Host header must be 127.0.0.1/localhost; all writes need `X-Bridge: 1` (CSRF guard). `GET /api/effect-ping`, `/api/gauge.bmp` and `/api/w.bmp` are the exceptions (loaded as `<img>` from SignalRGB).
- `src/beacon.js`: `BeaconReader` (spawns and restarts the PowerShell reader, parses JSON lines) and `BeaconTracker` (readings -> synthetic events, 5% hysteresis, 10s grace, handoff).
- `src/effects.js`: 12 fixed effect slots (`death, ghost, lowHealth, health, mana, lowMana, bossFight, victory, wipe, bloodlust, combat, crit`, names `WoW ...`; `health` and `mana` are live gauges with `source`) plus the zone compositor `WoW Bridge`; validation, HTML generator, installer. Names are fixed because a new file needs a SignalRGB restart.
- `src/patterns.js`: pattern renderer shared by generated effects and UI previews (UMD, plain ES2015): solid, breathe, pulse (sin^2 heartbeat), mix, wave, flash, sweep, sparkle, gauge, gaugeFade.
- `src/zones.js`, `src/srgb-layout.js`: zones, ambience grading, layout reading/checking (see Zones).
- `src/parser.js`, `src/watcher.js`, `src/tracker.js`: combat log (see verified facts). Watcher reads the startup file from its end.
- `src/rules.js`: matches events against rules (WeakAuras-style). `clearOn` inherits the rule's spell filter unless `anySpell: true`. `zones` says where a rule shows.
- `src/controller.js`: priority stack; highest priority wins, ties go to most recent; baseline when empty. Coalesced with `setImmediate`, rate limited. With no fixed baseline (`followManual`), re-reads the current effect when leaving baseline so manual SignalRGB changes stick, but skips that read for `settleMs` (500) after its own apply. `reapply()` re-sends the showing effect; `setOverride()` keeps the compositor applied.
- `src/signalrgb.js`: the only file that knows the SignalRGB API. Keep it that way.
- `src/hue.js`: ceiling alerts straight through the Hue Bridge (v1 REST, own key from `node tools/hue-pair.js <ip>` in git-ignored `hue.local.json`; `node tools/hue-pair.js test` flashes). For Hue lights left out of SignalRGB: rules whose `zones` name `ceiling` directly flash `hue.lights` (config) and restore each light's saved state; one alert at a time.
- `ui/`: settings page (vanilla JS): Effects (live canvas previews, autosave, preview on lights), Rules (with Where), Settings (thresholds, zones, ceiling, game world colors), Activity. Light and dark themes.
- `addons/SignalBeacon/`: beacon addon, v0.3. Also turns on combat logging at login. `/beacon` toggles, `/beacon test` reports which values are secret.
- `addons/CursorCoords/`: small cursor coordinates addon.
- `test/fixtures/forever-sample.txt`: 425 real Forever beta lines (a boss kill and a player death), anonymized with `tools/anonymize-log.js`.

## Beacon strip (addon v0.3, layout 3)

Anchored TOPLEFT of UIParent, strata TOOLTIP, blocks 4 UI units wide x 4 tall, two rows:
- row 1: `[magenta marker][flags: R=dead-or-ghost G=combat B=encounter][result: green=kill, white=wipe, black=none, held 3s][health bar 64 units: red fill on blue]`
- row 2: `[yellow marker][flags2: R=ghost G=has mana bar][black spare][mana bar: cyan fill on green]`

The reader finds the magenta marker in the top-left 400x200px, measures the unit width from it, samples each row's middle, and reports `{ok,hp,dead,ghost,combat,encounter,won,wiped,hasMana,mana,layout,barPx,amb}`. Layouts 1 and 2 (addon 0.1/0.2) are still decoded. At a typical 1440p UI scale the bars are ~76px, ~1.3% resolution. "Has mana" comes from the class (PRIEST, MAGE, WARLOCK, DRUID, SHAMAN, PALADIN, HUNTER), which is never secret.

Beacon events: `HEALTH_AVAILABLE/UNAVAILABLE` (bracket the live beacon, for the health gauge), `PLAYER_DIED` (corpse), `PLAYER_GHOST` (released), `PLAYER_ALIVE`, `PLAYER_LOW_HEALTH_START/END`, `PLAYER_LOW_MANA_START/END` (`lowManaThreshold`, default 0.2), `MANA_AVAILABLE/UNAVAILABLE` (bracket the gauge), `PLAYER_COMBAT_START/END`, `ENCOUNTER_START/END/WIN/WIPE`.

If `UnitIsDeadOrGhost` is secret the addon tracks death from events: `PLAYER_DEAD` sets; `PLAYER_UNGHOST` or entering combat clears; after `PLAYER_ALIVE` (ambiguous: release or resurrect) the next `UNIT_HEALTH` more than 1.5s later clears. ENCOUNTER_END `success` may be secret; then the bridge uses the combat log's late win/wipe.

## Zones (compositor)

While the beacon is live and `zones.enabled`, the controller's `override` keeps one effect applied: **WoW Bridge** (generated by `renderCompositorHtml`, bakes every design, the zone rects and the room light color). Rule switching then happens inside that effect: each zone draws its own highest-priority active rule whose `zones` include it; a zone with no rule shows **ambience** (the WoW world's colors). With `zones.ceiling.enabled` false the ceiling shows a fixed room light color (zone index 31). Previews (priority >= 1000) and rules pointing at stock SignalRGB effects bypass the override. In whole-effect mode (`controller.wholeFilter`) rules that don't cover the whole PC (e.g. Health Gauge on `radiator` only) are skipped, so a part-only rule never takes over every light. Gauge designs poll `/api/gauge.bmp?source=<source>` per distinct source (`mana`, `health`). Outside the game (beacon down) the bridge falls back to whole-effect switching and the baseline.

- Zones (`src/zones.js`, 320x200 canvas), one per fan: `ceiling`, `topLeft`, `topMiddle`, `topRight` (3 fans above the AIO), `radiator` (the AIO's own fans, electrically parallel), `rear`, `rightTop`, `rightBottom`, `floorLeft`, `floorRight`, `strip`; groups `all`, `pc`. Old keys `back` and `bottom` still expand to the right and floor fans (`LEGACY`). Keys are stable (rules use them); labels are display names. `DEFAULT_RECTS` match the author's proportional layout; `DEFAULT_PARTS` adds extra areas to a zone (the hidden front strip, vertical at the right edge). Override with `zones.rects` in config.json. With `zones.fromLayout` (default on) the areas come from the SignalRGB layout instead, matched by device name (`DEVICE_ZONES`: "Top Left", "Cooling Fans", "Side Strip", "Front Strip" as a strip part, ...), re-read every 30s; the author runs with it off and lines devices up by hand on `node tools/identify-test.js 600` (each zone in its own color). Live gauges draw across their own area, not the canvas slice under it.
- SignalRGB does not always write layout edits to the registry right away (seen 9/28: edits in its UI were not in the registry even after a restart; saving as a new named layout did write them). `tools/restart-signalrgb.ps1` asks it to close before force-killing it.
- `src/srgb-layout.js` reads the layout from SignalRGB's registry settings: `HKCU\Software\WhirlwindFX\SignalRgb\lighting\endpoint\<id>` (alias, scale, rotation) + `\position` (x, y = top-left of the LED grid, canvas units), and `devices\<device>` ("Channel N" = JSON component list: ComponentId, LedCount, Width, Height). `node tools/layout.js` prints it and flags devices outside their zone; the bridge logs the same warnings at startup.
- Ambience: the reader averages 4 vertical slices of the game view (8% to 68% of the height) and adds `amb` to every reading; `Ambience` grades it (gain, saturation, floor) and eases it. Slices map left to right onto the canvas (4 x 80px).
- Ceiling left out (`zones.ceiling.enabled` false, one-click "Ceiling: daylight" button): the ceiling shows `zones.ceiling.color` (default `#ffffff`, daylight at 100%), and the compositor also stays on **outside the game**, where idle PC zones show the normal color (`zones.normalColor`, or read from SignalRGB's Solid Color settings via `readSolidColor()`: QColor blob in `HKCU\...\SignalRgb\effects\Solid Color.html\color`, shown at 50% when Breathing is on at speed 0). Handing the cans back to the Hue app needs the Hue device disabled in SignalRGB; SignalRGB's API has no device endpoints.
- Channel into the effect: `GET /api/w.bmp?k=` returns a BMP whose width-1 is a 12-bit word: `z0`..`z5` = 2 zones x 5-bit design index (0 = ambience, 1..29 = `Object.values(effects)` order, 30 = normal color, 31 = room light), `a<i>h`/`a<i>l` = ambience color i (`R<<4|G>>4`, `(G&15)<<8|B`). `GET /api/gauge.bmp?source=mana`: width-1 = mana in 0.1% steps, height 2 = none. The effect loads its images one at a time through a queue (many parallel loads kept SignalRGB from ever running a frame), polls zones and gauges every 100ms, ambience every 200ms, and pings `z=` and `amb=` back so `/api/state` shows what it really draws.

## Verified facts

Client and log (Forever beta, 9/2026):
- TOC interface number `16001`. Beta client exe `_classic_beta_\WowB.exe`; Logs and AddOns under `_classic_beta_`.
- `UnitHealth("player")` and mana are secret **even out of combat** (`issecretvalue` true, arithmetic errors with "tainted by ForceTaint_Strong"). A `StatusBar` accepts secret min/max/value and draws correctly. `UnitIsDeadOrGhost` and `UnitAffectingCombat` are readable. `LoggingCombat(true)` works from an addon at login.
- Combat log writes are buffered: lines reach disk 2 to 13s after their in-game timestamp. A corpse revive writes no combat log event at all. The beacon measured 78-83ms for low health start/end.
- The client has built-in Razer Chroma support (`ChromaEffectsEnable` CVar, loads `RzChromatic64.dll`), not usable with SignalRGB.
- Header: `COMBAT_LOG_VERSION,22,ADVANCED_LOG_ENABLED,1,BUILD_VERSION,1.60.1,PROJECT_ID,18`.
- Timestamp: `9/26/2026 19:26:23.477-4  EVENT,...` (full year, ms, TZ offset, two spaces).
- **Advanced block is 19 fields** (retail 17). Front: `infoGUID, ownerGUID, currentHP, maxHP, attackPower, spellPower, armor, absorb`; back: `powerType, currentPower, maxPower, powerCost, positionX, positionY, uiMapID, facing, level`. Parser learns the length from the most common `SPELL_CAST_SUCCESS` remainder.
- Damage suffix: `amount, baseAmount, overkill, school, resisted, blocked, absorbed, critical, glancing, crushing` (+ optional `ST`/`AOE`). Heal: `amount, baseAmount, overhealing, absorbed, critical`. `ENVIRONMENTAL_DAMAGE` type comes after the advanced block. `SPELL_ABSORBED` is base-only.

Screen capture:
- GDI `CopyFromScreen` reads whatever window is on top; `PrintWindow(hwnd, PW_CLIENTONLY|PW_RENDERFULLCONTENT)` captures WoW even when covered (~39ms for a 2560x1440 client). The reader costs ~0.5% CPU on a 16-thread CPU.

SignalRGB 2.5.74, API base `http://127.0.0.1:16038/api/v1` (needs Pro):
- `GET /lighting`, `GET /lighting/effects` (ids are store ids or filenames; resolve by name case-insensitively), `GET .../presets`.
- `POST /lighting/effects/{id}/apply` returns in 2 to 18ms; `GET /lighting` shows the change only after 64 to 117ms.
- User effects: `%USERPROFILE%\Documents\WhirlwindFX\Effects\*.html`. New files are only discovered at startup (restart via `tools/restart-signalrgb.ps1`, ~5s). **Edits to an existing file load the next time the effect is applied** (~0.5s end to end from the settings page).
- Effect pages (WebKit): `<img>` requests to localhost work (and their natural size is readable); `fetch`, XHR and `<script src>` to localhost are blocked. So designs are baked into the file, live values arrive as image sizes, and effects report back via an image ping (`/api/effect-ping?name&v&frames&level&z&amb&error`, every 3s).
- SignalRGB's log (`%LOCALAPPDATA%\WhirlwindFX\SignalRgb\Logs`) does not record effect JS errors. Effects run in its Ultralight engine.
- **SignalRGB's effect engine can stall**: after a long idle stretch it still reported an effect as active (and "Activated" it in the log) but ran nothing, so the lights froze on the last frame and no effect pinged. A SignalRGB restart fixed it. The bridge's watchdog (`watchdog.enabled`, `staleMs` 15000) re-applies a silent bridge effect, then restarts SignalRGB (at most every 10 minutes). `node tools/check-effects.js` shows when each effect last reported; `node tools/run-effect.js "<name>"` runs an effect file with a fake canvas to catch runtime errors.
- Hue through SignalRGB (PhilipsHue.js add-on): Entertainment API stream in RGB, 16-bit per channel, no brightness scaling. Streamed white is much dimmer than a Hue white scene (Energize uses the bulbs' white LEDs). When stream frames don't reach a bulb it shows its stored Hue state for a moment (seen 9/29 as 1 s flashes to Energize while other bulbs on the bridge kept dropping off Zigbee); the bridge's event stream showed no stream stop. When SignalRGB goes idle it stops the stream (~26 s after "System is now Idle"). `tools/hue-watch.js` (polled state, lags 1-4 min) and `tools/hue-events.js` (live v2 events) watch the Hue Bridge with the key SignalRGB saved.
- Fans chained through their pass-through plugs are usually electrically parallel (every fan shows the channel's first LEDs); use one fan component per chained set, or give each fan its own channel for per-fan control.
- Not yet verified: `PATCH .../presets`, `PATCH /lighting/global_brightness`.
