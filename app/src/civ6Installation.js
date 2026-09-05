import * as fs from "fs";
import * as path from "path";
import { execFileSync } from "child_process";

// Locates the Civ 6 game install (the folder containing Base/). Windows only.

const CIV6_STEAM_DIR = "Sid Meier's Civilization VI";

const regQuery = (key, value) => {
  try {
    const out = execFileSync("reg", ["query", key, "/v", value], { encoding: "utf8", windowsHide: true });
    const m = new RegExp(`${value}\\s+REG_SZ\\s+(.+)`, "i").exec(out);

    return m ? m[1].trim() : null;
  } catch {
    return null;
  }
};

const steamLibraries = () => {
  const root =
    regQuery("HKCU\\Software\\Valve\\Steam", "SteamPath") ||
    regQuery("HKLM\\SOFTWARE\\WOW6432Node\\Valve\\Steam", "InstallPath") ||
    "C:\\Program Files (x86)\\Steam";
  const libs = [root];

  try {
    const vdf = fs.readFileSync(path.join(root, "steamapps", "libraryfolders.vdf"), "utf8");

    for (const m of vdf.matchAll(/"path"\s+"([^"]+)"/g)) {
      libs.push(m[1].replace(/\\\\/g, "\\"));
    }
  } catch {
    // No extra libraries
  }

  return libs;
};

const findSteamCiv6 = () =>
  steamLibraries()
    .map(lib => path.join(lib, "steamapps", "common", CIV6_STEAM_DIR))
    .find(p => fs.existsSync(p)) || null;

const findEpicCiv6 = () => {
  const manifests = path.join(
    process.env.ProgramData || "C:\\ProgramData",
    "Epic",
    "EpicGamesLauncher",
    "Data",
    "Manifests",
  );

  try {
    for (const f of fs.readdirSync(manifests)) {
      if (!f.endsWith(".item")) {
        continue;
      }

      try {
        const item = JSON.parse(fs.readFileSync(path.join(manifests, f), "utf8"));

        if (
          /civilization vi\b/i.test(item.DisplayName || "") &&
          item.InstallLocation &&
          fs.existsSync(item.InstallLocation)
        ) {
          return item.InstallLocation;
        }
      } catch {
        // Malformed manifest
      }
    }
  } catch {
    // No Epic launcher
  }

  return null;
};

// Windows only, find the installation folder for Civ 6
export const findGameInstallDir = dataPath => {
  if (process.platform !== "win32") {
    return null;
  }

  const epic = /\(Epic\)$/i.test(path.basename(dataPath));

  return (epic ? findEpicCiv6() : findSteamCiv6()) || findSteamCiv6() || findEpicCiv6();
};
