-- ===========================================================================
--	AutoHotseat shim.
--
--	FrontEndActions only support ImportFiles, which replaces a stock file of
--	the same name. The stock FrontEnd.xml loads an empty Firaxis debug
--	context from UI/Test.lua next to the main menu, so overriding that file is
--	our way into the front end. All real logic lives in AutoHotseat_FrontEnd.lua.
-- ===========================================================================
include("AutoHotseat_FrontEnd");
