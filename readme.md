[![Build Status](https://github.com/pydt/client/actions/workflows/client-dist.yml/badge.svg)](https://github.com/pydt/client/actions/workflows/client-dist.yml)

# PYDT Electron Client

## Dev Setup

* `npm install`
* `npm run build` (or `watch`) to build HTML/JS
* `npm run electron` to start the client!

If you have an api-url.txt in the parent directory (created when deploying the API), it will use that, otherwise it will use the "production" URL.

## Civ 6 Auto-Start

Two per-game settings on the Civilization 6 tab, both on by default and independent of each other:

* **Auto-start directly into the downloaded save** installs the bundled `app/mods/AutoHotseat` mod into the Civ 6
  `Mods` folder and sets `[Debug] PlayNowSave` in `AppOptions.txt` before launching, so Civ 6 boots straight into the
  hotseat save.
* **Skip the intro video** sets `[Video] PlayIntroVideo 0` each time a turn is launched. This one is a plain user
  preference and is deliberately not restored afterwards.

The mod and `PlayNowSave` are scoped to the turn: when the Play screen is left (after submitting or on cancel) or the
setting is turned off, `PlayNowSave` is blanked at once, and as soon as Civ 6 exits the mod folder is removed. The
removal waits for the exit so files are not pulled out from under a running game. As a safety net, every games poll
that finds no Civ 6 turn waiting runs the same revert. The mod source lives in the
[civ6-autostart-game](../civ6-autostart-game) repo; copy `mod/AutoHotseat` here when it changes.
`app/src/civ6Autostart.js` owns the per-platform `AppOptions.txt` lookup (Windows, macOS, native Linux, Proton).

## Prod Packaging / Deployment

* `npm run dist`


# License

<a rel="license" href="http://creativecommons.org/licenses/by-nc-sa/4.0/"><img alt="Creative Commons License" style="border-width:0" src="https://i.creativecommons.org/l/by-nc-sa/4.0/88x31.png" /></a><br /><span xmlns:dct="http://purl.org/dc/terms/" href="http://purl.org/dc/dcmitype/InteractiveResource" property="dct:title" rel="dct:type">Play Your Damn Turn</span> by <a xmlns:cc="http://creativecommons.org/ns#" href="https://www.playyourdamnturn.com" property="cc:attributionName" rel="cc:attributionURL">Michael Rosack</a> is licensed under a <a rel="license" href="http://creativecommons.org/licenses/by-nc-sa/4.0/">Creative Commons Attribution-NonCommercial-ShareAlike 4.0 International License</a>.
