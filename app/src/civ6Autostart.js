import electron from "electron";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execFileSync } from "child_process";
import { default as log } from "electron-log";
import { RPC_INVOKE } from "./rpcChannels.js";

// Auto-starting Civ 6 straight into the downloaded hotseat save.
//
// Civ 6 has a hidden [Debug] PlayNowSave option in AppOptions.txt that makes the main
// menu load a single save. Stock behaviour loads it as single player (useless for a
// hotseat save), so we ship the "AutoHotseat" front-end mod (see app/mods/AutoHotseat)
// which intercepts that option, loads the save as HOTSEAT and presses Start for you.
//
// Lifecycle: the mod and PlayNowSave are scoped to one PYDT turn.
//   prepareAutostart  - before launch: install the mod and set PlayNowSave <save>; with the
//                       intro-skip setting on, also set PlayIntroVideo 0.
//   revertAutostart   - after the turn (or any time nothing is pending): blank PlayNowSave
//                       at once; once Civ 6 is no longer running also remove the mod, so
//                       normal play sessions see a stock game. (Removing while the game
//                       runs would pull files out from under it.)
// PlayIntroVideo is deliberately NOT restored: it is a plain user preference that the
// player can flip back in the game's own options, and re-applying it on every launch is
// simpler than tracking an original value across client restarts and game exits.
// All path knowledge is centralised here and is cross-platform (incl. Proton).

const MOD_NAME = "AutoHotseat";
const CIV6_DATA_DIR = "Sid Meier's Civilization VI";
const EXIT_POLL_MS = 10 * 1000;
const EXIT_POLL_MAX_MS = 6 * 60 * 60 * 1000;

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

const optionRe = key => new RegExp(`^${key}\\b[ \\t]*([^\\r\\n]*)`, "m");

/** Current value of "Key Value" in AppOptions.txt text, "" if blank, null if the key is absent. */
export const getAppOption = (text, key) => {
  const m = optionRe(key).exec(text);

  return m ? m[1].trim() : null;
};

/**
 * Set "Key Value" in AppOptions.txt text. Keys are unique across sections, one per line.
 * If the key is missing it is appended to the given section (created if needed).
 */
export const setAppOption = (text, section, key, value) => {
  const line = `${key} ${value}`.trimEnd();
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const keyRe = optionRe(key);

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

// ---------------------------------------------------------------------------------------
// Mod files
// ---------------------------------------------------------------------------------------

const writeFileForced = (file, data) => {
  try {
    fs.writeFileSync(file, data);
  } catch (err) {
    if (err.code !== "EPERM" && err.code !== "EACCES") {
      throw err;
    }

    // Windows refuses to overwrite a read-only file (OneDrive can leave them that way).
    fs.chmodSync(file, 0o666);
    fs.writeFileSync(file, data);
  }
};

/**
 * Make dst mirror src, touching as little as possible: files with identical content are
 * left alone, differing ones are overwritten in place, stale files are removed best-effort.
 * Never removes directories. Returns the number of files written.
 */
const syncDir = (src, dst) => {
  fs.mkdirSync(dst, { recursive: true });

  const wanted = new Set();
  let written = 0;

  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    wanted.add(entry.name);

    if (entry.isDirectory()) {
      written += syncDir(s, d);
      continue;
    }

    const data = fs.readFileSync(s);

    if (fs.existsSync(d) && fs.readFileSync(d).equals(data)) {
      continue;
    }

    writeFileForced(d, data);
    written++;
  }

  for (const entry of fs.readdirSync(dst, { withFileTypes: true })) {
    if (!wanted.has(entry.name) && !entry.isDirectory()) {
      try {
        fs.rmSync(path.join(dst, entry.name), { force: true });
      } catch (err) {
        log.warn(`Could not remove stale mod file ${entry.name}: ${err.message}`);
      }
    }
  }

  return written;
};

/**
 * Install or refresh the bundled mod at <dataPath>/Mods/AutoHotseat. Does not delete and
 * re-create the folder: on Windows that fails with EPERM whenever OneDrive or a running
 * Civ 6 holds a handle inside it, and it churns the sync client for nothing.
 */
export const installMod = dataPath => {
  const source = modSourceDir();

  if (!fs.existsSync(path.join(source, `${MOD_NAME}.modinfo`))) {
    throw new Error(`Bundled ${MOD_NAME} mod not found at ${source}`);
  }

  const target = path.join(dataPath, "Mods", MOD_NAME);
  const written = syncDir(source, target);

  if (written) {
    log.info(`Civ 6 autostart mod: ${written} file(s) updated in ${target}`);
  }

  return target;
};

const modTarget = dataPath => path.join(dataPath, "Mods", MOD_NAME);

/** Civ 6 only sees a mod if its .modinfo is there; an empty folder is invisible to it. */
const isModInstalled = dataPath => fs.existsSync(path.join(modTarget(dataPath), `${MOD_NAME}.modinfo`));

/** Delete every file under dir, then the directories, ignoring failures. */
const removeTree = dir => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      removeTree(p);
    } else {
      try {
        fs.rmSync(p, { force: true });
      } catch (err) {
        if (err.code === "EPERM" || err.code === "EACCES") {
          fs.chmodSync(p, 0o666);
          fs.rmSync(p, { force: true });
        } else {
          throw err;
        }
      }
    }
  }

  try {
    fs.rmdirSync(dir);
  } catch {
    // OneDrive keeps directory handles open on synced folders, so the folder itself often
    // cannot be removed right away. Files are what matter; an empty folder is harmless.
  }
};

/**
 * Remove the mod. Returns true when Civ 6 can no longer see it (the .modinfo is gone), even
 * if OneDrive left the empty folder behind.
 */
const removeMod = dataPath => {
  const target = modTarget(dataPath);

  if (!fs.existsSync(target)) {
    return true;
  }

  try {
    removeTree(target);
  } catch (err) {
    log.warn(`Could not remove ${target}: ${err.message}`);
  }

  if (fs.existsSync(target) && !isModInstalled(dataPath)) {
    log.info(`Civ 6 autostart: mod files removed; empty folder ${target} left behind (locked by OneDrive?)`);
  }

  return !isModInstalled(dataPath);
};

// ---------------------------------------------------------------------------------------
// Is Civ 6 running? (needed because the game rewrites AppOptions.txt from memory on exit)
// ---------------------------------------------------------------------------------------

/** true / false, or null when the process list can't be read. */
export const isCiv6Running = () => {
  try {
    if (process.platform === "win32") {
      const out = execFileSync("tasklist", ["/FO", "CSV", "/NH"], { encoding: "utf8", windowsHide: true });

      return /^"CivilizationVI[^"]*\.exe"/im.test(out);
    }

    // macOS: "Civilization VI"; native Linux: "CivilizationVI"; Proton: "CivilizationVI*.exe".
    const out = execFileSync("ps", ["-axo", "comm="], { encoding: "utf8" });

    return /civilization ?vi\b|\bciv6\b/i.test(out);
  } catch (err) {
    log.warn(`Could not read process list: ${err.message}`);

    return null;
  }
};

// ---------------------------------------------------------------------------------------
// Public operations
// ---------------------------------------------------------------------------------------

/**
 * Prepare Civ 6 for a turn. Never throws; returns { ok, message }.
 *
 * @param {{ dataPath: string; savePath: string; autoStart?: boolean; skipIntroVideo?: boolean }} arg
 *   dataPath is the Civ 6 user data folder (parent of Saves/ and Mods/), savePath the
 *   .Civ6Save to load. autoStart installs the mod and sets PlayNowSave; skipIntroVideo sets
 *   PlayIntroVideo 0 (persistently). Both default to true; either can be used alone.
 */
export const prepareAutostart = ({ dataPath, savePath, autoStart = true, skipIntroVideo = true }) => {
  try {
    if (!autoStart && !skipIntroVideo) {
      return { ok: true, message: "Civ 6 autostart: nothing requested" };
    }

    const appOptionsPath = findAppOptionsPath(dataPath);

    if (!appOptionsPath) {
      return {
        ok: false,
        message: `AppOptions.txt not found for ${dataPath} (has the game been run once?)`,
      };
    }

    cancelPendingRevert();

    let text = readOptions(appOptionsPath);
    const notes = [];

    if (skipIntroVideo && getAppOption(text, "PlayIntroVideo") !== "0") {
      text = setAppOption(text, "Video", "PlayIntroVideo", "0");
      notes.push("PlayIntroVideo=0");
    }

    if (autoStart) {
      const target = installMod(dataPath);
      const gameSavePath = toGamePath(savePath, dataPath);

      text = setAppOption(text, "Debug", "PlayNowSave", gameSavePath);
      notes.push(`mod at ${target}`, `PlayNowSave=${gameSavePath}`);
    }

    writeOptions(appOptionsPath, text);

    const message = `Civ 6 autostart armed: ${notes.join(", ")} in ${appOptionsPath}`;
    log.info(message);

    return { ok: true, message };
  } catch (err) {
    const message = `Civ 6 autostart setup failed: ${err.message}`;
    log.error(message);

    return { ok: false, message };
  }
};

/** Blank PlayNowSave in the given file if it is set. Returns true if a write happened. */
const blankPlayNowSave = appOptionsPath => {
  const text = readOptions(appOptionsPath);

  if (!getAppOption(text, "PlayNowSave")) {
    return false;
  }

  writeOptions(appOptionsPath, setAppOption(text, "Debug", "PlayNowSave", ""));

  return true;
};

/**
 * Undo the turn-scoped changes: blank PlayNowSave now; if Civ 6 is not running, also remove
 * the mod. PlayIntroVideo is left alone on purpose (see the header comment). Never throws.
 *
 * @param {{ dataPath: string; waitForExit?: boolean }} arg With waitForExit, a revert that
 *   found the game running is retried automatically every few seconds until it has exited.
 * @returns {{ ok: boolean; complete: boolean; message: string }} complete=false means the
 *   game was running and the mod removal is still pending.
 */
export const revertAutostart = ({ dataPath, waitForExit = false }) => {
  try {
    const appOptionsPath = findAppOptionsPath(dataPath);
    const notes = [];

    if (appOptionsPath && blankPlayNowSave(appOptionsPath)) {
      notes.push("PlayNowSave blanked");
    }

    const modPresent = isModInstalled(dataPath);

    if (!modPresent) {
      cancelPendingRevert();

      return { ok: true, complete: true, message: `Civ 6 autostart: nothing to revert${fmt(notes)}` };
    }

    if (isCiv6Running()) {
      if (waitForExit) {
        schedulePendingRevert(dataPath);
        notes.push("Civ 6 is running; mod removal will happen when it exits");
      } else {
        notes.push("Civ 6 is running; mod removal deferred");
      }

      const message = `Civ 6 autostart revert pending${fmt(notes)}`;
      log.info(message);

      return { ok: true, complete: false, message };
    }

    const modGone = removeMod(dataPath);
    notes.push(modGone ? "mod removed" : "mod removal failed (will retry)");

    if (modGone) {
      cancelPendingRevert();
    } else if (waitForExit) {
      schedulePendingRevert(dataPath);
    }

    const message = `Civ 6 autostart reverted${fmt(notes)}`;
    log.info(message);

    return { ok: true, complete: modGone, message };
  } catch (err) {
    const message = `Civ 6 autostart revert failed: ${err.message}`;
    log.error(message);

    return { ok: false, complete: false, message };
  }
};

const fmt = notes => (notes.length ? `: ${notes.join("; ")}` : "");

// One pending revert at a time is plenty: it re-reads everything from disk when it fires.
let pendingRevert = null;

const cancelPendingRevert = () => {
  if (pendingRevert) {
    clearInterval(pendingRevert.timer);
    pendingRevert = null;
  }
};

const schedulePendingRevert = dataPath => {
  if (pendingRevert) {
    return;
  }

  const startedAt = Date.now();

  pendingRevert = {
    timer: setInterval(() => {
      if (Date.now() - startedAt > EXIT_POLL_MAX_MS) {
        log.warn("Civ 6 autostart: gave up waiting for the game to exit; will retry on the next games poll");
        cancelPendingRevert();
        return;
      }

      if (isCiv6Running() === true) {
        return;
      }

      log.info("Civ 6 autostart: game has exited, reverting");
      revertAutostart({ dataPath, waitForExit: false });
    }, EXIT_POLL_MS),
  };
};

electron.ipcMain.handle(RPC_INVOKE.CIV6_AUTOSTART_PREPARE, (e, arg) => prepareAutostart(arg));
electron.ipcMain.handle(RPC_INVOKE.CIV6_AUTOSTART_REVERT, (e, arg) => revertAutostart(arg));
