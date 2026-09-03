import electron from "electron";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { default as log } from "electron-log";
import { RPC_INVOKE } from "./rpcChannels.js";

// Auto-starting Civ 6 straight into the downloaded hotseat save.
//
// Civ 6 has a hidden [Debug] PlayNowSave option in AppOptions.txt that makes the main
// menu load a single save. Stock behaviour loads it as single player (useless for a
// hotseat save), so we ship the "AutoHotseat" front-end mod (see app/mods/AutoHotseat)
// which intercepts that option, loads the save as HOTSEAT and presses Start for you.
//
// This module installs/refreshes that mod into the user's Mods folder and manages the
// PlayNowSave entry. It is cross-platform; all path knowledge is centralised here.

const MOD_NAME = "AutoHotseat";
const CIV6_DATA_DIR = "Sid Meier's Civilization VI";

const modSourceDir = () =>
  electron.app.isPackaged
    ? path.join(process.resourcesPath, "mods", MOD_NAME)
    : path.join(electron.app.getAppPath(), "mods", MOD_NAME);

// Matches a Proton prefix data path like
// ~/.local/share/Steam/steamapps/compatdata/289070/pfx/drive_c/users/steamuser/Documents/My Games/...
const PROTON_RE = /^(.*[\\/]pfx[\\/]drive_c)[\\/]users[\\/]([^\\/]+)[\\/]/i;

const localAppData = () => process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");

const uniqueExisting = candidates => {
  const seen = new Set();
  const result = [];

  for (const c of candidates) {
    const n = path.normalize(c);

    if (!seen.has(n)) {
      seen.add(n);
      result.push(n);
    }
  }

  return result.find(p => fs.existsSync(p)) || null;
};

/**
 * Locate AppOptions.txt for the Civ 6 install whose user data folder (the one containing
 * Saves/ and Mods/) is dataPath. Returns null if it can't be found - the game writes it on
 * first run, so a missing file means the game has never been launched.
 */
export const findAppOptionsPath = dataPath => {
  const dataDirName = path.basename(dataPath);
  const proton = PROTON_RE.exec(dataPath);

  if (proton) {
    const [, driveC, user] = proton;
    const firaxis = path.join(driveC, "users", user, "AppData", "Local", "Firaxis Games");

    return uniqueExisting([
      path.join(firaxis, dataDirName, "AppOptions.txt"),
      path.join(firaxis, CIV6_DATA_DIR, "AppOptions.txt"),
    ]);
  }

  switch (process.platform) {
    case "win32":
      return uniqueExisting([
        path.join(localAppData(), "Firaxis Games", dataDirName, "AppOptions.txt"),
        path.join(localAppData(), "Firaxis Games", CIV6_DATA_DIR, "AppOptions.txt"),
      ]);

    case "darwin":
      // ~/Library/Application Support/Sid Meier's Civilization VI/AppOptions.txt, with the
      // Saves/Mods folder one level below it.
      return uniqueExisting([
        path.join(path.dirname(dataPath), "AppOptions.txt"),
        path.join(dataPath, "AppOptions.txt"),
      ]);

    default:
      // Native (Aspyr) Linux keeps everything under ~/.local/share/aspyr-media/<game>/
      return uniqueExisting([
        path.join(dataPath, "AppOptions.txt"),
        path.join(path.dirname(dataPath), "AppOptions.txt"),
      ]);
  }
};

/**
 * Convert a host path into the form the game itself will understand. Only Proton needs
 * translation (host path inside the prefix -> C:\ path with backslashes).
 */
export const toGamePath = (hostPath, dataPath) => {
  const proton = PROTON_RE.exec(dataPath);

  if (proton) {
    const driveC = proton[1];
    const normalized = path.normalize(hostPath);

    if (normalized.toLowerCase().startsWith(path.normalize(driveC).toLowerCase())) {
      return `C:${normalized.slice(driveC.length).replace(/\//g, "\\")}`;
    }
  }

  return path.normalize(hostPath);
};

/**
 * Set "Key Value" in AppOptions.txt text. Keys are unique across sections, one per line.
 * If the key is missing it is appended to the given section (created if needed).
 */
export const setAppOption = (text, section, key, value) => {
  const line = `${key} ${value}`.trimEnd();
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const keyRe = new RegExp(`^${key}\\b[^\\r\\n]*`, "m");

  if (keyRe.test(text)) {
    // Function replacer so "$" in a path isn't treated as a replacement pattern.
    return text.replace(keyRe, () => line);
  }

  const sectionRe = new RegExp(`^\\[${section}\\][^\\r\\n]*`, "m");
  const sectionMatch = sectionRe.exec(text);

  if (sectionMatch) {
    const insertAt = sectionMatch.index + sectionMatch[0].length;

    return `${text.slice(0, insertAt)}${eol}${line}${text.slice(insertAt)}`;
  }

  const sep = text.length && !text.endsWith("\n") ? eol : "";

  return `${text}${sep}${eol}[${section}]${eol}${line}${eol}`;
};

const readOptions = appOptionsPath => fs.readFileSync(appOptionsPath, "utf8");

const writeOptions = (appOptionsPath, text) => fs.writeFileSync(appOptionsPath, text, "utf8");

/**
 * Copy the bundled mod into <dataPath>/Mods/AutoHotseat, replacing whatever is there.
 */
export const installMod = dataPath => {
  const source = modSourceDir();

  if (!fs.existsSync(path.join(source, `${MOD_NAME}.modinfo`))) {
    throw new Error(`Bundled ${MOD_NAME} mod not found at ${source}`);
  }

  const modsDir = path.join(dataPath, "Mods");
  const target = path.join(modsDir, MOD_NAME);

  fs.mkdirSync(modsDir, { recursive: true });
  fs.rmSync(target, { recursive: true, force: true });
  fs.cpSync(source, target, { recursive: true });

  return target;
};

/**
 * Install the mod and point PlayNowSave at the save. Never throws; returns { ok, message }.
 *
 * @param {{ dataPath: string; savePath: string }} arg dataPath is the Civ 6 user data
 *   folder (parent of Saves/ and Mods/), savePath the .Civ6Save to load.
 */
export const prepareAutostart = ({ dataPath, savePath }) => {
  try {
    const appOptionsPath = findAppOptionsPath(dataPath);

    if (!appOptionsPath) {
      return {
        ok: false,
        message: `AppOptions.txt not found for ${dataPath} (has the game been run once?)`,
      };
    }

    const modTarget = installMod(dataPath);
    const gameSavePath = toGamePath(savePath, dataPath);

    let text = readOptions(appOptionsPath);
    text = setAppOption(text, "Debug", "PlayNowSave", gameSavePath);
    // The ~3 minute cinematic would otherwise play before the mod gets a chance to run.
    text = setAppOption(text, "Video", "PlayIntroVideo", "0");
    writeOptions(appOptionsPath, text);

    const message = `Civ 6 autostart armed: mod at ${modTarget}, PlayNowSave=${gameSavePath} in ${appOptionsPath}`;
    log.info(message);

    return { ok: true, message };
  } catch (err) {
    const message = `Civ 6 autostart setup failed: ${err.message}`;
    log.error(message);

    return { ok: false, message };
  }
};

/**
 * Blank PlayNowSave so a later plain launch shows the normal main menu. The mod does this
 * itself when it consumes the option; this is the safety net for when it never ran.
 */
export const clearAutostart = ({ dataPath }) => {
  try {
    const appOptionsPath = findAppOptionsPath(dataPath);

    if (!appOptionsPath) {
      return { ok: false, message: "AppOptions.txt not found" };
    }

    const text = readOptions(appOptionsPath);

    if (!/^PlayNowSave[ \t]+\S/m.test(text)) {
      return { ok: true, message: "PlayNowSave already clear" };
    }

    writeOptions(appOptionsPath, setAppOption(text, "Debug", "PlayNowSave", ""));
    log.info(`Civ 6 autostart cleared in ${appOptionsPath}`);

    return { ok: true, message: "PlayNowSave cleared" };
  } catch (err) {
    const message = `Civ 6 autostart clear failed: ${err.message}`;
    log.error(message);

    return { ok: false, message };
  }
};

/**
 * Install/refresh the mod only, without arming PlayNowSave. Called when the user turns the
 * setting on, so the Mods folder mirrors the checkbox right away. Never throws.
 */
export const installAutostartMod = ({ dataPath }) => {
  try {
    if (!fs.existsSync(dataPath)) {
      return { ok: false, message: `Civ 6 data folder not found: ${dataPath} (has the game been run once?)` };
    }

    const target = installMod(dataPath);
    const message = `Civ 6 autostart mod installed to ${target}`;
    log.info(message);

    return { ok: true, message };
  } catch (err) {
    const message = `Civ 6 autostart mod install failed: ${err.message}`;
    log.error(message);

    return { ok: false, message };
  }
};

/**
 * Remove the mod from <dataPath>/Mods and blank PlayNowSave. Called when the user turns the
 * setting off, so Civ 6 is left exactly as it was before. Never throws.
 */
export const uninstallAutostart = ({ dataPath }) => {
  try {
    const target = path.join(dataPath, "Mods", MOD_NAME);
    const wasInstalled = fs.existsSync(target);

    fs.rmSync(target, { recursive: true, force: true });

    // Best effort; AppOptions.txt may legitimately not exist yet.
    const cleared = clearAutostart({ dataPath });

    const message = wasInstalled
      ? `Civ 6 autostart mod removed from ${target} (${cleared.message})`
      : `Civ 6 autostart mod was not installed at ${target} (${cleared.message})`;
    log.info(message);

    return { ok: true, message };
  } catch (err) {
    const message = `Civ 6 autostart uninstall failed: ${err.message}`;
    log.error(message);

    return { ok: false, message };
  }
};

electron.ipcMain.handle(RPC_INVOKE.CIV6_AUTOSTART_PREPARE, (e, arg) => prepareAutostart(arg));
electron.ipcMain.handle(RPC_INVOKE.CIV6_AUTOSTART_CLEAR, (e, arg) => clearAutostart(arg));
electron.ipcMain.handle(RPC_INVOKE.CIV6_AUTOSTART_INSTALL, (e, arg) => installAutostartMod(arg));
electron.ipcMain.handle(RPC_INVOKE.CIV6_AUTOSTART_UNINSTALL, (e, arg) => uninstallAutostart(arg));
