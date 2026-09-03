-- ===========================================================================
--	AutoHotseat: in-game PlayerChange wrapper
--
--	Loads the stock hotseat "player change" popup (Save Game / Start Turn)
--	and auto-presses Start Turn whenever the popup is shown with the Start
--	Turn button enabled. The button is disabled while the popup is in
--	"Please Wait" mode or while a hotseat password has not been entered, so
--	those cases are left alone.
--
--	Only active in sessions the front-end driver auto-loaded: it sets
--	[Debug] PlayNowSave to the sentinel below in the staging room right
--	before pressing Start (the engine drops option keys it does not know, so
--	the mod reuses the one it already owns). We read the marker once here and
--	blank it again so nothing persists. A hotseat game the player set up by
--	hand gets the stock popup, untouched. Nothing is written to the save.
-- ===========================================================================
include("PlayerChange");

local SESSION_SENTINEL	:string = "AUTOHOTSEAT_SESSION";
local AUTO_START_DELAY	:number = 0.2;		-- let the popup finish queueing before dismissing it
local m_countdown		:number = 0;
local m_ticking			:boolean = false;

local function Log( msg:string )
	print("AutoHotseat: " .. tostring(msg));
end

-- ===========================================================================
local function StartTurnAvailable()
	-- PopupAlphaIn is hidden in "Please Wait" mode and shown when the
	-- Save/Start Turn box is actually up.
	if Controls.PopupAlphaIn:IsHidden() then
		return false;
	end
	if Controls.OkButton:IsHidden() or Controls.OkButton:IsDisabled() then
		return false;		-- disabled = hotseat password required
	end
	return true;
end

-- ===========================================================================
local function AutoHotseat_OnUpdate( fDeltaTime:number )
	if not m_ticking then
		return;
	end
	m_countdown = m_countdown - fDeltaTime;
	if m_countdown > 0 then
		return;
	end
	m_ticking = false;
	ContextPtr:ClearUpdate();

	if StartTurnAvailable() then
		Log("Auto-pressing Start Turn.");
		OnOk();		-- stock global: unpause, LuaEvents.PlayerChange_Close, dequeue popup
	else
		Log("Start Turn not available (waiting or password); leaving the prompt up.");
	end
end

-- ===========================================================================
local function IsAutoHotseatSession()
	if not GameConfiguration.IsHotseat() then
		return false;
	end
	local marker = Options.GetAppOption("Debug", "PlayNowSave");
	if marker ~= SESSION_SENTINEL then
		return false;
	end
	-- Consume it so it never leaks into a later launch.
	pcall(function()
		Options.SetAppOption("Debug", "PlayNowSave", "");
		Options.SaveOptions();
	end);
	return true;
end

-- ===========================================================================
--	Hook: ShowTurnControls (stock code calls it by global name from both
--	OnShow and BuildTurnControls, so redefining the global covers both paths)
-- ===========================================================================
if not IsAutoHotseatSession() then
	Log("Not an auto-loaded session (no session marker); PlayerChange wrapper inactive.");
else
	local BASE_ShowTurnControls = ShowTurnControls;
	function ShowTurnControls()
		BASE_ShowTurnControls();

		if not StartTurnAvailable() then
			return;		-- "Please Wait" mode or password; the stock prompt stays
		end
		Log("Player-change prompt shown with Start Turn enabled; pressing in " .. tostring(AUTO_START_DELAY) .. "s.");
		m_countdown = AUTO_START_DELAY;
		m_ticking = true;
		ContextPtr:SetUpdate( AutoHotseat_OnUpdate );
	end

	Log("PlayerChange wrapper active.");
end
