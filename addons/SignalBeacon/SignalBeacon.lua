-- SignalBeacon: a small strip in the top-left corner for the bridge to read off the screen.
--
-- Addons can't write files or talk to the network, and in Forever the player's health
-- is a secret value (no math, no comparisons). A StatusBar can still display a secret,
-- so the bridge measures the bar instead of reading a number.
--
-- Layout, two rows, all blocks the same width (pure colors so capture is easy):
--   row 1: [marker: magenta]
--          [flags:  R = dead or ghost, G = in combat, B = boss encounter active]
--          [result: green = boss killed, white = wipe, black = none (shown RESULT_SECS after ENCOUNTER_END)]
--          [health: red fill on a blue track, BAR_W wide]
--   row 2: [marker: yellow]
--          [flags2: R = ghost (released), G = has a mana bar]
--          [spare: black]
--          [mana: cyan fill on a green track, BAR_W wide]

local UNIT_W, BAR_W, H = 4, 64, 4
local RESULT_SECS = 3
local MANA = (Enum and Enum.PowerType and Enum.PowerType.Mana) or 0
-- Classes with a mana pool (Druids keep theirs in forms). Class is never secret.
local MANA_CLASSES = { PRIEST = true, MAGE = true, WARLOCK = true, DRUID = true, SHAMAN = true, PALADIN = true, HUNTER = true }

local f = CreateFrame("Frame", "SignalBeaconFrame", UIParent)
f:SetFrameStrata("TOOLTIP")
f:SetFrameLevel(9999)
f:SetPoint("TOPLEFT", UIParent, "TOPLEFT", 0, 0)
f:SetSize(UNIT_W * 3 + BAR_W, H * 2)

local function solid(parent, layer, r, g, b)
  local t = parent:CreateTexture(nil, layer)
  t:SetColorTexture(r, g, b, 1)
  return t
end

local marker = solid(f, "ARTWORK", 1, 0, 1)
marker:SetPoint("TOPLEFT", f, "TOPLEFT", 0, 0)
marker:SetSize(UNIT_W, H)

local flags = solid(f, "ARTWORK", 0, 0, 0)
flags:SetPoint("TOPLEFT", marker, "TOPRIGHT", 0, 0)
flags:SetSize(UNIT_W, H)

local result = solid(f, "ARTWORK", 0, 0, 0)
result:SetPoint("TOPLEFT", flags, "TOPRIGHT", 0, 0)
result:SetSize(UNIT_W, H)

local bar = CreateFrame("StatusBar", nil, f)
bar:SetPoint("TOPLEFT", result, "TOPRIGHT", 0, 0)
bar:SetSize(BAR_W, H)
bar:SetStatusBarTexture("Interface/Buttons/WHITE8x8")
bar:SetStatusBarColor(1, 0, 0, 1)
local track = solid(bar, "BACKGROUND", 0, 0, 1)
track:SetAllPoints(bar)

local marker2 = solid(f, "ARTWORK", 1, 1, 0)
marker2:SetPoint("TOPLEFT", marker, "BOTTOMLEFT", 0, 0)
marker2:SetSize(UNIT_W, H)

local flags2 = solid(f, "ARTWORK", 0, 0, 0)
flags2:SetPoint("TOPLEFT", marker2, "TOPRIGHT", 0, 0)
flags2:SetSize(UNIT_W, H)

local spare = solid(f, "ARTWORK", 0, 0, 0)
spare:SetPoint("TOPLEFT", flags2, "TOPRIGHT", 0, 0)
spare:SetSize(UNIT_W, H)

local manaBar = CreateFrame("StatusBar", nil, f)
manaBar:SetPoint("TOPLEFT", spare, "TOPRIGHT", 0, 0)
manaBar:SetSize(BAR_W, H)
manaBar:SetStatusBarTexture("Interface/Buttons/WHITE8x8")
manaBar:SetStatusBarColor(0, 1, 1, 1)
local manaTrack = solid(manaBar, "BACKGROUND", 0, 1, 0)
manaTrack:SetAllPoints(manaBar)

local _, playerClass = UnitClass("player")
local hasMana = MANA_CLASSES[playerClass] or false

local state = { dead = false, ghost = false, combat = false, encounter = false, won = false, wiped = false }
local resultTimer

-- Any of these may be secret values in Forever. If testing one errors, keep the
-- event-driven value instead.
local function test(fn)
  local ok, v = pcall(fn)
  if ok then return v end
  return nil
end

-- readable.dead is false when UnitIsDeadOrGhost returns a secret. Then death is tracked
-- from events only: PLAYER_DEAD sets it; PLAYER_UNGHOST or entering combat clears it.
-- PLAYER_ALIVE is ambiguous (it fires on release to ghost and on a resurrect before
-- release), so after it the next health change more than 1.5s later counts as alive:
-- a ghost's health doesn't change, a resurrected player regenerates.
local readable = { dead = nil, ghost = nil, combat = nil, result = nil }
local aliveSince

local function refreshDead()
  local v = test(function() return UnitIsDeadOrGhost("player") and true or false end)
  readable.dead = v ~= nil
  if v ~= nil then state.dead = v end
  local g = test(function() return UnitIsGhost("player") and true or false end)
  readable.ghost = g ~= nil
  if g ~= nil then state.ghost = g end
  if not state.dead then state.ghost = false end
  return v ~= nil
end

local function refreshCombat()
  local v = test(function() return UnitAffectingCombat("player") and true or false end)
  readable.combat = v ~= nil
  if v ~= nil then state.combat = v end
end

local function drawFlags()
  flags:SetColorTexture(state.dead and 1 or 0, state.combat and 1 or 0, state.encounter and 1 or 0, 1)
  if state.won then result:SetColorTexture(0, 1, 0, 1)
  elseif state.wiped then result:SetColorTexture(1, 1, 1, 1)
  else result:SetColorTexture(0, 0, 0, 1) end
  flags2:SetColorTexture(state.ghost and 1 or 0, hasMana and 1 or 0, 0, 1)
end

local function drawHealth()
  bar:SetMinMaxValues(0, UnitHealthMax("player"))
  bar:SetValue(UnitHealth("player"))
  -- Mana may be secret too; the bar displays it either way.
  manaBar:SetMinMaxValues(0, UnitPowerMax("player", MANA))
  manaBar:SetValue(UnitPower("player", MANA))
end

local function showResult(won)
  if resultTimer then resultTimer:Cancel() end
  state.won, state.wiped = won, not won
  resultTimer = C_Timer.NewTimer(RESULT_SECS, function()
    state.won, state.wiped = false, false
    resultTimer = nil
    drawFlags()
  end)
end

f:SetScript("OnEvent", function(_, event, ...)
  if event == "PLAYER_DEAD" then
    state.dead = true
    state.ghost = false
    aliveSince = nil
  elseif event == "PLAYER_ALIVE" then
    if not refreshDead() and state.dead then
      aliveSince = GetTime()
      if not readable.ghost then state.ghost = true end -- most likely a release
    end
    refreshCombat()
  elseif event == "PLAYER_UNGHOST" then
    if not refreshDead() then state.dead = false end
    state.ghost = false
    aliveSince = nil
  elseif event == "PLAYER_ENTERING_WORLD" then
    playerClass = select(2, UnitClass("player"))
    hasMana = MANA_CLASSES[playerClass] or false
    refreshDead()
    refreshCombat()
    -- The bridge also tails the combat log (buffs, crits, fallback). Turn it on so
    -- /combatlog isn't needed every session.
    if LoggingCombat and not LoggingCombat() then
      if pcall(LoggingCombat, true) and LoggingCombat() then
        print("SignalBeacon: combat logging turned on for the lighting bridge.")
      end
    end
  elseif event == "PLAYER_REGEN_DISABLED" then
    state.combat = true
    if not readable.dead then state.dead = false end -- ghosts can't enter combat
  elseif event == "PLAYER_REGEN_ENABLED" then
    state.combat = false
  elseif event == "UNIT_HEALTH" then
    if aliveSince and GetTime() - aliveSince > 1.5 then
      state.dead = false
      state.ghost = false
      aliveSince = nil
    end
  elseif event == "ENCOUNTER_START" then
    state.encounter = true
  elseif event == "ENCOUNTER_END" then
    state.encounter = false
    local success = select(5, ...)
    -- "and true or false" forces a real boolean inside pcall, so a secret can't leak out.
    local won = test(function() return (success == 1 or success == true) and true or false end)
    readable.result = won ~= nil
    if won ~= nil then showResult(won) end
  end
  drawFlags()
  drawHealth()
end)

for _, e in ipairs({
  "PLAYER_ENTERING_WORLD", "PLAYER_DEAD", "PLAYER_ALIVE", "PLAYER_UNGHOST",
  "PLAYER_REGEN_DISABLED", "PLAYER_REGEN_ENABLED", "ENCOUNTER_START", "ENCOUNTER_END",
}) do
  f:RegisterEvent(e)
end
f:RegisterUnitEvent("UNIT_HEALTH", "player")
f:RegisterUnitEvent("UNIT_MAXHEALTH", "player")
f:RegisterUnitEvent("UNIT_POWER_UPDATE", "player")
f:RegisterUnitEvent("UNIT_MAXPOWER", "player")
f:RegisterUnitEvent("UNIT_DISPLAYPOWER", "player")

-- Safety net in case an event is missed.
local elapsed = 0
f:SetScript("OnUpdate", function(_, dt)
  elapsed = elapsed + dt
  if elapsed < 0.25 then return end
  elapsed = 0
  refreshDead()
  drawFlags()
  drawHealth()
end)

local function yesno(v)
  if v == nil then return "not checked yet" end
  return v and "yes" or "NO (secret)"
end

SLASH_SIGNALBEACON1 = "/beacon"
SlashCmdList.SIGNALBEACON = function(msg)
  msg = strtrim(msg or ""):lower()
  if msg == "test" then
    refreshDead()
    refreshCombat()
    local hpSecret = test(function() return issecretvalue and issecretvalue(UnitHealth("player")) or false end)
    local mpSecret = test(function() return issecretvalue and issecretvalue(UnitPower("player", MANA)) or false end)
    print("SignalBeacon v0.3 readable values:")
    print("  health: " .. (hpSecret and "secret" or "readable") .. ", mana: " .. (mpSecret and "secret" or "readable")
      .. " (both shown as bars, that's fine)")
    print("  dead/ghost: " .. yesno(readable.dead) .. ", ghost: " .. yesno(readable.ghost)
      .. ", combat: " .. yesno(readable.combat) .. ", boss result: " .. yesno(readable.result))
    print(string.format("  state: dead=%s ghost=%s combat=%s encounter=%s, class %s (mana bar: %s)",
      tostring(state.dead), tostring(state.ghost), tostring(state.combat), tostring(state.encounter),
      tostring(playerClass), hasMana and "yes" or "no"))
    print("  combat logging: " .. (LoggingCombat and (LoggingCombat() and "on" or "OFF") or "unavailable"))
    return
  end
  f:SetShown(not f:IsShown())
  print("SignalBeacon " .. (f:IsShown() and "shown" or "hidden") .. ". /beacon test shows which game values are readable.")
end
