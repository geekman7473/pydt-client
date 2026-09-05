-- ===========================================================================
--	AutoHotseat override of UI/FrontEnd/IntroScreen.lua
--
--	Identical to the stock file except for one thing: when an automatic
--	hotseat load is pending ([Debug] PlayNowSave is set in AppOptions.txt),
--	the delay before the copyright notice auto-accepts drops from 5 s to a
--	fraction of a second. Normal launches keep the stock behaviour.
-- ===========================================================================
include("InputSupport");

-- ===========================================================================
--	Action Hotkeys
-- ===========================================================================

local m_actionHotkeyAccept		:number = Input.GetActionId("Accept");
local m_actionHotkeyAcceptAlt	:number = Input.GetActionId("AcceptAlt");

local NO_ACCEPT_TIMER			:number = -1;									-- accept timer not running value.
local ACCEPT_DELAY				:number = UI.IsFinalRelease() and 5 or 0.1;		-- Delay times (release and debug) before accept button is visible and auto-accept is checked.
local m_acceptDelayTimer		:number = NO_ACCEPT_TIMER;						-- Time remaining before accept button should be shown.

-- AutoHotseat: shorten the wait when a save is queued for automatic loading.
do
	local pending = Options.GetAppOption("Debug", "PlayNowSave");
	-- "AUTOHOTSEAT_SESSION" is the driver's leftover session marker, not a save.
	if pending ~= nil and pending ~= "" and pending ~= "AUTOHOTSEAT_SESSION" then
		ACCEPT_DELAY = 0.1;
		print("AutoHotseat: intro screen override active, accept delay shortened.");
	else
		print("AutoHotseat: intro screen override loaded (no pending save).");
	end
end


-- ===========================================================================
--	Accept EULA
-- ===========================================================================
-- savedAccept (optional) - Is this accept action because the player accepted this version previously?  Assumes false if nil.
function AcceptEULA( savedAccept : boolean )
	Controls.CopyrightAccept:SetHide( true );
	Events.UserAcceptsEULA();

	if(savedAccept == nil or not savedAccept) then
		-- We just accepted the copyright notice for the first time for this version.
		local currentVersion = UI.GetAppVersion();
		Options.SetUserOption("Interface", "CopyrightAccept", currentVersion);
		Options.SaveOptions();
	end
end


-- ===========================================================================
--	Context Functions
-- ===========================================================================
function OnShow()
	-- Wait a small amount of time before presenting.  This is a legal requirement for our third party software logos.
	Controls.CopyrightAccept:SetHide( true );

	m_acceptDelayTimer = ACCEPT_DELAY;
	ContextPtr:SetUpdate( OnUpdateDelay );
end

-- ===========================================================================
function OnUpdateDelay(fDTime)
	if(m_acceptDelayTimer ~= NO_ACCEPT_TIMER) then
		m_acceptDelayTimer = m_acceptDelayTimer - fDTime;
		if(m_acceptDelayTimer < 0) then
			m_acceptDelayTimer = NO_ACCEPT_TIMER;
			ContextPtr:ClearUpdate();

			Controls.CopyrightAccept:SetHide( false );
			local currentVersion = UI.GetAppVersion();
			local acceptedVersion = Options.GetUserOption("Interface", "CopyrightAccept");
			if(currentVersion == acceptedVersion and currentVersion ~= "") then
				AcceptEULA(true);
			end
		end
	end
end


-- ===========================================================================
--	Hotkey
-- ===========================================================================
function OnInputActionTriggered( actionId:number )
	if	actionId == m_actionHotkeyAccept or
		actionId == m_actionHotkeyAcceptAlt then
			AcceptEULA();
	end
end

-- ===========================================================================
--	UI Callback
-- ===========================================================================
function OnAccept()
	AcceptEULA();
end

-- ===========================================================================
function OnRequestClose()
    Events.UserConfirmedClose();
end

-- ===========================================================================
function Startup()
	Input.SetActiveContext( InputContext.Startup );

    Controls.CopyrightAccept:RegisterCallback( Mouse.eLClick, OnAccept );
    Controls.CopyrightAccept:RegisterCallback( Mouse.eMouseEnter, function() UI.PlaySound("Main_Menu_Mouse_Over"); end);

	Controls.CopyrightAccept:SetHide( Automation.IsActive() );
    Controls.CopyrightText:SetHide(false);

	Events.InputActionTriggered.Add( OnInputActionTriggered );
    Events.UserRequestClose.Add( OnRequestClose );

	-- Manually call OnShow because SetActiveContext does not appear to call it normally.
	OnShow();
end
Startup();
