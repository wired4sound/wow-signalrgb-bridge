-- CursorCoords: live mouse coordinates next to the cursor.
--   Screen = physical pixels, top-left origin (matches Windows)
--   UI     = WoW UI units, bottom-left origin (what SetPoint uses)
--   Map    = world map percent, only while hovering the open map
-- /cc toggles, /cc print writes the current values to chat.

local frame = CreateFrame("Frame", "CursorCoordsFrame", UIParent)
frame:SetFrameStrata("TOOLTIP")
frame:SetAllPoints(UIParent)

local text = frame:CreateFontString(nil, "OVERLAY")
text:SetFont(STANDARD_TEXT_FONT, 12, "OUTLINE")
text:SetJustifyH("LEFT")

local current = ""

local function Read()
  local x, y = GetCursorPosition()
  local scale = UIParent:GetEffectiveScale()
  local ux, uy = x / scale, y / scale

  local pw, ph = GetPhysicalScreenSize()
  local sw, sh = GetScreenWidth() * scale, GetScreenHeight() * scale
  local px = math.floor(x / sw * pw + 0.5)
  local py = math.floor((1 - y / sh) * ph + 0.5)

  local out = string.format("Screen %d, %d\nUI %.0f, %.0f", px, py, ux, uy)

  local map = WorldMapFrame and WorldMapFrame.ScrollContainer
  if map and WorldMapFrame:IsShown() and map:IsMouseOver() and map.GetNormalizedCursorPosition then
    local mx, my = map:GetNormalizedCursorPosition()
    if mx and mx >= 0 and mx <= 1 and my >= 0 and my <= 1 then
      out = out .. string.format("\nMap %.1f, %.1f", mx * 100, my * 100)
    end
  end
  return out, ux, uy
end

frame:SetScript("OnUpdate", function()
  local out, ux, uy = Read()
  current = out
  text:SetText(out)
  text:ClearAllPoints()
  -- Flip to the left side near the right edge so it stays on screen.
  if ux > GetScreenWidth() - 160 then
    text:SetPoint("BOTTOMRIGHT", UIParent, "BOTTOMLEFT", ux - 12, uy + 6)
  else
    text:SetPoint("BOTTOMLEFT", UIParent, "BOTTOMLEFT", ux + 18, uy + 6)
  end
end)

SLASH_CURSORCOORDS1 = "/cc"
SLASH_CURSORCOORDS2 = "/cursorcoords"
SlashCmdList.CURSORCOORDS = function(msg)
  msg = (msg or ""):lower()
  if msg == "print" then
    print("|cff33ff99CursorCoords|r " .. (Read():gsub("\n", "  |  ")))
  elseif frame:IsShown() then
    frame:Hide()
    print("|cff33ff99CursorCoords|r off")
  else
    frame:Show()
    print("|cff33ff99CursorCoords|r on")
  end
end
