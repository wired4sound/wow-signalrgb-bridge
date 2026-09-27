# WoW Lighting Bridge

Switches SignalRGB Pro effects on real World of Warcraft events (WoW Forever), with a local settings page for colors, patterns and rules.

```
SignalBeacon addon (strip in the corner) --screen capture, ~0.1s--> bridge --> SignalRGB --> RGB gear
WoW combat log file -----------------------------file tail, 2-13s--> bridge
```

- **Screen beacon (fast):** the `SignalBeacon` addon draws a tiny strip in the top-left corner of the game: health bar, dead, in combat, boss fight, boss kill or wipe. The bridge reads it straight from the WoW window about 10 times a second, even while other windows cover the game. Used for low health, death, revive, combat and boss start and end.
- **Combat log (slow):** WoW writes the log file 2 to 13 seconds late. Used for buffs like Bloodlust, crits, and as the fallback whenever the beacon isn't visible.

No npm install needed. Requires Node 18+ and Windows (the beacon reader uses PowerShell).

## Start

Double-click **`start-bridge.cmd`**. It starts the bridge and opens the settings page at <http://127.0.0.1:17700/>. Close the window, or click **Stop bridge** on the settings page, to stop it; your normal SignalRGB effect is restored either way.

From a terminal: `npm start` (same thing), or `node src/index.js` without opening the browser.

## First-time setup

1. **SignalRGB:** signed in to Pro and running. Turn off SignalRGB's built-in World of Warcraft integration so it doesn't fight the bridge.
2. **Addon:** copy `addons/SignalBeacon` into `World of Warcraft\<flavor>\Interface\AddOns\` (for the beta, `_classic_beta_`), then `/reload` in game. You should see a tiny two-row strip (pink and yellow markers, red and cyan bars) in the very top-left corner. `/beacon test` shows what the addon can read.
3. **Combat log:** System > Network > enable **Advanced Combat Logging**, and type `/combatlog` in game each session.
4. **Effects:** the bridge writes its effects (`WoW Death`, `WoW Low Health`, ...) into `Documents\WhirlwindFX\Effects`. SignalRGB only notices new effect files when it starts, so the first time use **Settings > Install effects** (it restarts SignalRGB for you).

## The settings page

- **Effects:** every bridge effect with a live preview. **Where it shows** picks Everywhere, PC only, Ceiling only, or one part (it updates every rule using that effect). Pick a pattern (Solid, Breathe, Heartbeat, Breathing mix, Color wave, Flash, Sweep, Sparkle), colors, speed and brightness. Changes save automatically and update your lights within about a second if that effect is showing. **Preview on lights** shows it for 5 seconds. A green *running in SignalRGB* badge means SignalRGB itself reported drawing it.
- **Rules:** which effect each game event shows, its priority and how long it lasts. You can also point a rule at any other installed SignalRGB effect. **Edit as JSON** for the full rule format.
- **Settings:** low health threshold, screen beacon on or off, your normal effect (follow SignalRGB, or a fixed one), Logs folder, character name.
- **Activity:** what the bridge saw and did, newest first.

## Zones: ceiling vs PC

While you play, the bridge keeps one SignalRGB effect on, **WoW Bridge**, and draws each part of the room separately: the ceiling (the Hue cans in the top band of the SignalRGB layout) and the PC parts (radiator fans, rear fan, back fans, bottom fans, strip). Each rule's **Where** (Rules tab) says which parts it lights. A part with nothing to show follows the colors of the game world, sampled from the WoW window. By default the big moments (death, ghost, boss kill or wipe, Bloodlust) light everything and the rest stay on the PC, so the mana gauge lives on the fans while the ceiling follows the world. Tune the world colors under **Settings > Game world colors**, untick **Include the ceiling lights** to keep the room lights on a steady color of your choice (black = off), or turn zones off to go back to switching whole effects.

**Your own layout:** the zones are rectangles on SignalRGB's 320x200 layout canvas. The defaults expect room lights (e.g. Hue bulbs) in a top band and the PC below it: a full-width radiator bar, a fan on the left, fans on the right, floor fans at the bottom right, and a strip along the bottom. Arrange your SignalRGB layout like that, or set `zones.rects` in `config.json` (`{ "ceiling": [x, y, w, h], ... }`). Run `node tools/layout.js` to see where each of your devices lands; the bridge also warns at startup when a device is outside every zone. `node tools/identify-test.js` paints each zone a different color so you can check it on the real hardware.

## In game

- `/beacon` hides or shows the strip (hidden = the bridge falls back to the combat log).
- `/beacon test` prints which game values the addon can read. Forever hides some values from addons ("secret values"); health always is, which is why it's drawn as a bar.
- Hiding the UI (Alt+Z) or a loading screen hides the strip; the bridge keeps the last state for 10 seconds, then uses the combat log until the strip comes back.

## Rules

Each rule in `rules.json` shows an effect until `durationMs` passes or a `clearOn` event arrives (whichever is first). The highest `priority` wins; when nothing is active, your normal effect returns.

| Field | Meaning |
|---|---|
| `event` | Combat log subevent or synthetic event, string or array |
| `spellId` / `spellName` | Either matches. Names are safer until Forever spell IDs are confirmed |
| `source` / `dest` | `any`, `player`, `notPlayer`, `mine` (you + pets), `group`, `hostile`, `friendly` |
| `critical`, `auraType`, `minAmount` | Extra filters |
| `encounterId` / `encounterName` | For encounter events (combat log only; the beacon doesn't know boss names) |
| `effect`, `preset` | SignalRGB effect name and optional preset |
| `priority` | Default 50 |
| `durationMs` | Timed effect, or max lifetime when `clearOn` is set |
| `clearOn` | Matchers that end the effect. They inherit the rule's spell filter unless `"anySpell": true` |
| `cooldownMs` | Ignore retriggers within this window |
| `enabled` | `false` to disable |

**Synthetic events:** `PLAYER_DIED`, `PLAYER_ALIVE`, `PLAYER_LOW_HEALTH_START`, `PLAYER_LOW_HEALTH_END`, `PLAYER_COMBAT_START`, `PLAYER_COMBAT_END` (beacon only), `ENCOUNTER_START`, `ENCOUNTER_END`, `ENCOUNTER_WIN`, `ENCOUNTER_WIPE`, `PLAYER_IDENTIFIED`.

## Testing without the game

```
npm test                                   # 37 tests, incl. the beacon reader on generated screenshots
node tools/fake-log.js --speed 2           # scripted Ragnaros fight into sandbox/Logs
node src/index.js --dry-run --logs sandbox/Logs --no-beacon --open
node src/index.js --replay <file>          # run any saved log through the rules instantly
node tools/lua-check.js                    # rough structure check of the addon Lua
node tools/srgb.js status|list|apply <name>|flash <name> [ms]
powershell -ExecutionPolicy Bypass -File tools\beacon-reader.ps1   # print live beacon readings
```

## Files

- `src/app.js`: the running bridge (log + beacon -> rules -> controller), settings and state for the UI
- `src/server.js`: settings page and JSON API on 127.0.0.1
- `src/beacon.js`: runs the beacon reader, turns readings into events, hands off to the combat log
- `src/effects.js`, `src/patterns.js`: effect designs, the shared pattern renderer, SignalRGB effect file generator
- `src/parser.js`, `src/watcher.js`, `src/tracker.js`: combat log parsing, tailing, player state
- `src/rules.js`, `src/controller.js`: rule matching; priority stack, rate limiting, baseline restore
- `src/signalrgb.js`: all SignalRGB API calls (isolated, since the API may change)
- `ui/`: the settings page
- `addons/SignalBeacon/`: the beacon addon; `addons/CursorCoords/`: cursor coordinates addon
- `tools/beacon-reader.ps1`: screen reader for the beacon; `tools/restart-signalrgb.ps1`: restarts SignalRGB
- `effects.json`, `rules.json`, `config.json`: your settings (the settings page edits these)
