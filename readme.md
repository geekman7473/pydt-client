[![Build Status](https://github.com/pydt/client/actions/workflows/client-dist.yml/badge.svg)](https://github.com/pydt/client/actions/workflows/client-dist.yml)

# PYDT Electron Client

## Dev Setup

* `npm install`
* `npm run build` (or `watch`) to build HTML/JS
* `npm run electron` to start the client!

If you have an api-url.txt in the parent directory (created when deploying the API), it will use that, otherwise it will use the "production" URL.

## Civ 6 Auto-Start

With the "Auto-start Civ 6 directly into the downloaded save" setting on (the default), the client installs the
bundled `app/mods/AutoHotseat` mod into the Civ 6 `Mods` folder and sets `[Debug] PlayNowSave` in `AppOptions.txt`
before launching the game, so Civ 6 boots straight into the hotseat save. Turning the setting off removes the mod
folder and blanks `PlayNowSave` immediately. The mod source lives in the
[civ6-autostart-game](../civ6-autostart-game) repo; copy `mod/AutoHotseat` here when it changes.
`app/src/civ6Autostart.js` owns the per-platform `AppOptions.txt` lookup (Windows, macOS, native Linux, Proton).

## Prod Packaging / Deployment

* `npm run dist`


# License

<a rel="license" href="http://creativecommons.org/licenses/by-nc-sa/4.0/"><img alt="Creative Commons License" style="border-width:0" src="https://i.creativecommons.org/l/by-nc-sa/4.0/88x31.png" /></a><br /><span xmlns:dct="http://purl.org/dc/terms/" href="http://purl.org/dc/dcmitype/InteractiveResource" property="dct:title" rel="dct:type">Play Your Damn Turn</span> by <a xmlns:cc="http://creativecommons.org/ns#" href="https://www.playyourdamnturn.com" property="cc:attributionName" rel="cc:attributionURL">Michael Rosack</a> is licensed under a <a rel="license" href="http://creativecommons.org/licenses/by-nc-sa/4.0/">Creative Commons Attribution-NonCommercial-ShareAlike 4.0 International License</a>.
