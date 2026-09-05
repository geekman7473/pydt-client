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
-- Delay before pressing Start Turn. Stock BuildTurnControls calls SetPause(true) when the
-- prompt appears and OnOk calls SetPause(false); SetPause only acts when GetWantsPause()
-- differs from the request, and that flag round-trips through Network.BroadcastPlayerInfo.
-- Pressing too early (0.2 s did it) skips the unpause and the game stays paused: no orders
-- can be given. A human never clicks that fast.
local AUTO_START_DELAY	:number = 1.0;
-- After pressing, keep making sure the game is unpaused while the pause flag settles.
local UNPAUSE_WATCH		:number = 4.0;
local m_countdown		:number = 0;
local m_ticking			:boolean = false;
local m_unpauseLeft		:number = 0;

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
local function LocalPlayerWantsPause()
	local localPlayerID = Game.GetLocalPlayer();
	local config = PlayerConfigurations[localPlayerID];
	return config ~= nil and config:GetWantsPause();
end

local function AutoHotseat_OnUpdate( fDeltaTime:number )
	if m_ticking then
		m_countdown = m_countdown - fDeltaTime;
		if m_countdown > 0 then
			return;
		end
		m_ticking = false;

		if StartTurnAvailable() then
			Log("Auto-pressing Start Turn.");
			OnOk();		-- stock global: SetPause(false), LuaEvents.PlayerChange_Close, dequeue popup
			m_unpauseLeft = UNPAUSE_WATCH;
			return;		-- keep updating for the unpause watch below
		end

		Log("Start Turn not available (waiting or password); leaving the prompt up.");
		ContextPtr:ClearUpdate();
		return;
	end

	if m_unpauseLeft > 0 then
		m_unpauseLeft = m_unpauseLeft - fDeltaTime;
		if not ContextPtr:IsHidden() then
			-- Prompt is back (next player change); the stock flow owns the pause again.
			m_unpauseLeft = 0;
		elseif LocalPlayerWantsPause() then
			Log("Game still paused after Start Turn; unpausing.");
			SetPause(false);		-- stock global, safe to call repeatedly
		end
		if m_unpauseLeft <= 0 then
			ContextPtr:ClearUpdate();
		end
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
