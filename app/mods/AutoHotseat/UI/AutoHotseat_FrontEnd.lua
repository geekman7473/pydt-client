-- ===========================================================================
--	AutoHotseat front-end driver
--
--	Loaded from the UI/Test.lua shim, which overrides an empty debug context that
--	FrontEnd.xml loads on Windows alongside the main menu (ID "Test",
--	visible, no controls). FrontEndActions only support ImportFiles, not
--	ReplaceUIScript, so hijacking this harmless context is the least
--	invasive way to run our own code in the front end without copying
--	MainMenu.lua or StagingRoom.lua wholesale.
--
--	Behaviour:
--	  1. On load, read [Debug] PlayNowSave from AppOptions.txt and clear it
--	     in memory. The stock main menu also reads this key in its OnShow
--	     (loads the save as SINGLE player and hides the menu), so we must
--	     consume it first. This context loads after MainMenu's Initialize()
--	     but before its OnShow(), so the stock menu never sees the value.
--	  2. Once the main menu is visible, call
--	     Network.LoadGame(save, ServerType.SERVER_TYPE_HOTSEAT), the same
--	     call the Hotseat > Load Game button makes.
--	  3. When the staging room is raised, ready up and Network.LaunchGame(),
--	     mirroring StagingRoom.lua's OnReadyButton for hotseat.
-- ===========================================================================

-- Session marker for UI/PlayerChange_AutoHotseat.lua, so it can tell an auto-loaded
-- (PYDT) session from a hotseat game the player set up by hand, where the mod must
-- stay inert. The engine drops user/app option keys it does not know (verified:
-- Options.SetUserOption on a custom key reads back as nil), so the marker reuses the
-- one string option this mod already owns: right before pressing Start we set
-- [Debug] PlayNowSave to this sentinel. The stock main menu only reads PlayNowSave in
-- its OnShow, long gone by then. The in-game wrapper blanks it again on load, and any
-- front-end load that finds the sentinel (crash, alt-F4) just clears it and idles.
-- Options are engine-side and shared by both Lua states, so nothing touches the game
-- configuration or the save file.
local SESSION_SENTINEL			:string = "AUTOHOTSEAT_SESSION";

local MENU_SETTLE_DELAY		:number = 0.1;		-- seconds the main menu must be visible before we load
local MENU_WAIT_TIMEOUT		:number = 20;		-- give up waiting for the menu and load anyway
local STAGING_LAUNCH_DELAY	:number = 0.4;		-- seconds after the staging room appears before pressing Start

local STATE_IDLE			:string = "IDLE";
local STATE_WAIT_MENU		:string = "WAIT_MENU";
local STATE_LOADING			:string = "LOADING";
local STATE_LAUNCH_COUNTDOWN:string = "LAUNCH_COUNTDOWN";
local STATE_DONE			:string = "DONE";

local m_state			:string = STATE_IDLE;
local m_savePath		:string = nil;
local m_elapsed			:number = 0;
local m_menuVisibleFor	:number = 0;
local m_countdown		:number = 0;

-- ===========================================================================
local function Log( msg:string )
	print("AutoHotseat: " .. tostring(msg));
end

-- ===========================================================================
local function ReadAndClearSaveOption()
	local save = Options.GetAppOption("Debug", "PlayNowSave");
	if save == nil or save == "" then
		return nil;
	end
	Log("PlayNowSave = '" .. tostring(save) .. "'");
	Options.SetAppOption("Debug", "PlayNowSave", "");
	Options.SaveOptions();
	local after = Options.GetAppOption("Debug", "PlayNowSave");
	Log("PlayNowSave after clear = '" .. tostring(after) .. "'");
	if save == SESSION_SENTINEL then
		Log("That was a stale session marker, not a save; idle.");
		return nil;
	end
	return save;
end

-- ===========================================================================
--	NOTE: Options.Get*Option returns *nothing* (zero values, not nil) for a key the
--	engine does not know, so always assign the result to a local before use.
local function SetSessionMarker()
	Options.SetAppOption("Debug", "PlayNowSave", SESSION_SENTINEL);
	Options.SaveOptions();
	local readback = Options.GetAppOption("Debug", "PlayNowSave");
	Log("Session marker: PlayNowSave = '" .. tostring(readback) .. "'");
	return readback == SESSION_SENTINEL;
end

-- ===========================================================================
local function FileNameFromPath( path:string )
	local name = string.match(path, "([^\\/]+)$") or path;
	name = string.gsub(name, "%.[Cc][Ii][Vv]6[Ss][Aa][Vv][Ee]$", "");
	return name;
end

-- ===========================================================================
local function IsMainMenuVisible()
	local menu = ContextPtr:LookUpControl("/FrontEnd/MainMenu");
	if menu == nil then
		return false;
	end
	return not menu:IsHidden();
end

-- ===========================================================================
--	Save lookup. The stock load menu passes Network.LoadGame an entry that
--	came back from UI.QuerySaveGameList; a raw path string is accepted but
--	does not set up the multiplayer session, so we mirror the menu: query
--	the hotseat save list and hand over the matching entry.
-- ===========================================================================
local QUERY_TIMEOUT			:number = 8;		-- seconds to wait for all save-list queries
local m_queryPlan			:table = {};		-- remaining {directory, options} queries to try
local m_queryID				:number = nil;		-- id of the in-flight query
local m_queryElapsed		:number = 0;

local function NormalizePath( p:string )
	if p == nil then return ""; end
	p = string.gsub(p, "/", "\\");
	return string.lower(p);
end

local function DirNameFromPath( path:string )
	return string.match(path, "^(.*)[\\/][^\\/]+$") or "";
end

local function DoLoad( save )
	-- Same as LoadGameMenu::OnLoadYes / MainMenu::OnResumeGame.
	Network.LeaveGame();
	local result = Network.LoadGame(save, ServerType.SERVER_TYPE_HOTSEAT);
	return result ~= false;
end

local function FinishWithFallbacks()
	-- No save-list match. Try the two direct forms before giving up.
	Log("No save-list entry matched; trying direct file-entry table.");
	local entry :table = {};
	entry.Location		= SaveLocations.LOCAL_STORAGE;
	entry.Type			= Network.GetGameConfigurationSaveType();
	entry.Directory		= SaveDirectories.DEFAULT;
	entry.IsAutosave	= false;
	entry.IsQuicksave	= false;
	entry.Name			= FileNameFromPath(m_savePath);
	entry.Path			= m_savePath;
	if DoLoad(entry) then
		Log("Network.LoadGame(table) accepted; waiting for staging room.");
		return;
	end

	Log("Trying plain path string.");
	if DoLoad(m_savePath) then
		Log("Network.LoadGame(string) accepted; waiting for staging room.");
		return;
	end

	Log("ERROR: could not load '" .. m_savePath .. "'. Normal main menu stays up.");
	m_state = STATE_DONE;
	ContextPtr:ClearUpdate();
end

local function RunNextQuery()
	local step = table.remove(m_queryPlan, 1);
	if step == nil then
		m_queryID = nil;
		FinishWithFallbacks();
		return;
	end
	local gameType = Network.GetGameConfigurationSaveType();
	Log("Querying save list: dir='" .. tostring(step.directory) .. "' options=" .. tostring(step.options) .. " type=" .. tostring(gameType));
	m_queryElapsed = 0;
	m_queryID = UI.QuerySaveGameList( SaveLocations.LOCAL_STORAGE, gameType, step.options, SaveFileTypes.GAME_STATE, step.directory );
end

local function OnFileListQueryResults( fileList:table, id:number )
	if m_queryID == nil or id ~= m_queryID then
		return;		-- someone else's query (the main menu runs one too)
	end
	UI.CloseFileListQuery( id );
	m_queryID = nil;

	local wantPath = NormalizePath(m_savePath);
	local wantName = string.lower(FileNameFromPath(m_savePath));
	Log("Query returned " .. tostring(#fileList) .. " entries.");

	local match = nil;
	for _, entry in ipairs(fileList) do
		if not entry.IsDirectory then
			if entry.Path ~= nil and NormalizePath(entry.Path) == wantPath then
				match = entry; break;
			end
		end
	end
	if match == nil then
		for _, entry in ipairs(fileList) do
			if not entry.IsDirectory and entry.Name ~= nil and string.lower(entry.Name) == wantName then
				match = entry; break;
			end
		end
	end

	if match ~= nil then
		Log("Matched save entry: Name='" .. tostring(match.Name) .. "' Path='" .. tostring(match.Path) .. "' Type=" .. tostring(match.Type) .. " IsAutosave=" .. tostring(match.IsAutosave));
		if DoLoad(match) then
			Log("Network.LoadGame(entry) accepted; waiting for staging room.");
		else
			Log("Network.LoadGame(entry) returned false.");
			FinishWithFallbacks();
		end
		return;
	end

	for i, entry in ipairs(fileList) do
		if i > 5 then break; end
		Log("  candidate: Name='" .. tostring(entry.Name) .. "' Path='" .. tostring(entry.Path) .. "' IsDirectory=" .. tostring(entry.IsDirectory));
	end
	RunNextQuery();
end

local function StartHotseatLoad()
	m_state = STATE_LOADING;
	Log("Starting hotseat load of '" .. m_savePath .. "'");

	-- Same preparation the Hotseat menu button + HostGame screen perform.
	LuaEvents.ChangeMPLobbyMode("HOTSEAT");
	GameConfiguration.SetToDefaults(GameModeTypes.HOTSEAT);

	local allSaves = SaveLocationOptions.NORMAL + SaveLocationOptions.AUTOSAVE + SaveLocationOptions.QUICKSAVE + SaveLocationOptions.LOAD_METADATA;
	m_queryPlan = {
		{ directory = DirNameFromPath(m_savePath),	options = allSaves },					-- the file's own folder
		{ directory = "",							options = SaveLocationOptions.AUTOSAVE + SaveLocationOptions.LOAD_METADATA },	-- Saves\Hotseat\auto
		{ directory = "",							options = SaveLocationOptions.NORMAL + SaveLocationOptions.QUICKSAVE + SaveLocationOptions.LOAD_METADATA },	-- Saves\Hotseat
	};
	RunNextQuery();
end

-- ===========================================================================
local function LaunchFromStagingRoom()
	m_state = STATE_DONE;
	ContextPtr:ClearUpdate();

	if not GameConfiguration.IsHotseat() then
		Log("Session is not hotseat; leaving the staging room for the player.");
		return;
	end

	-- Mirror StagingRoom.lua: SetLocalReady(true) + OnReadyButton's hotseat branch.
	local localPlayerID :number = Network.GetLocalPlayerID();
	local localPlayerConfig = PlayerConfigurations[localPlayerID];
	if localPlayerConfig ~= nil then
		localPlayerConfig:SetReady(true);
		Network.BroadcastPlayerInfo();
	end

	-- Mark this session as auto-loaded so the in-game PlayerChange wrapper activates.
	-- Never let this block the launch: a failure here just leaves the wrapper inactive.
	local ok, stored = pcall(SetSessionMarker);
	if not ok then
		Log("Could not set session marker: " .. tostring(stored));
	elseif not stored then
		Log("Session marker did not stick; in-game auto Start Turn will stay inactive.");
	end

	Log("Launching hotseat game (Network.LaunchGame).");
	Network.LaunchGame();
end

-- ===========================================================================
local function OnStagingRoomShown()
	if m_state == STATE_LOADING then
		Log("Staging room raised; launching in " .. tostring(STAGING_LAUNCH_DELAY) .. "s.");
		m_countdown = STAGING_LAUNCH_DELAY;
		m_state = STATE_LAUNCH_COUNTDOWN;
	end
end

-- ===========================================================================
local function OnUpdate( fDeltaTime:number )
	if m_state == STATE_WAIT_MENU then
		m_elapsed = m_elapsed + fDeltaTime;
		if IsMainMenuVisible() then
			m_menuVisibleFor = m_menuVisibleFor + fDeltaTime;
		else
			m_menuVisibleFor = 0;
		end
		if m_menuVisibleFor >= MENU_SETTLE_DELAY then
			StartHotseatLoad();
		elseif m_elapsed >= MENU_WAIT_TIMEOUT then
			Log("Main menu not detected after " .. tostring(MENU_WAIT_TIMEOUT) .. "s; loading anyway.");
			StartHotseatLoad();
		end

	elseif m_state == STATE_LOADING and m_queryID ~= nil then
		m_queryElapsed = m_queryElapsed + fDeltaTime;
		if m_queryElapsed >= QUERY_TIMEOUT then
			Log("Save list query timed out.");
			UI.CloseFileListQuery( m_queryID );
			m_queryID = nil;
			RunNextQuery();
		end

	elseif m_state == STATE_LAUNCH_COUNTDOWN then
		m_countdown = m_countdown - fDeltaTime;
		if m_countdown <= 0 then
			LaunchFromStagingRoom();
		end
	end
end

-- ===========================================================================
function Initialize()
	-- Also clears a stale session marker, so whatever the player starts by hand next
	-- gets the stock in-game prompt.
	m_savePath = ReadAndClearSaveOption();
	if m_savePath == nil then
		Log("No PlayNowSave set; idle.");
		return;
	end

	LuaEvents.JoiningRoom_ShowStagingRoom.Add( OnStagingRoomShown );
	LuaEvents.HostGame_ShowStagingRoom.Add( OnStagingRoomShown );
	LuaEvents.FileListQueryResults.Add( OnFileListQueryResults );

	m_state = STATE_WAIT_MENU;
	m_elapsed = 0;
	m_menuVisibleFor = 0;
	ContextPtr:SetUpdate( OnUpdate );
	Log("Armed; waiting for the main menu.");
end
Initialize();
