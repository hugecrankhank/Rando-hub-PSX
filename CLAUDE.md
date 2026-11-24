# PSX Rando Hub

Robert's Windows desktop hub (Electron) for PlayStation randomizers: built-in emulator, auto-tracker and seed generator in one window. Games: Castlevania: Symphony of the Night (USA) and Final Fantasy VII (USA).

- Emulator: EmulatorJS with a libretro PS1 core (PCSX ReARMed default, Beetle PSX HW optional).
- Seeds: the community SotN Randomizer, downloaded into `vendor/` by `npm run setup` (not committed).
- Tracker: the 30 relics are auto-tracked from game memory; a few items are click-to-mark; boss checklist and race timer; state saved per seed.
- BIOS and disc images are never bundled; the app reads them from the user's PC.

## Layout

- `src/`: Electron main process (`main.js`, `preload.js`), disc reading (`disc.js`, `zipdisc.js`), the seed generator glue (`randomizer.js`), the map (`sotn-map.js`).
- `ui/`: the window (`index.html`, `app.js`, `emu.html`, `memory.js` for the autotracker, `popout.html`).
- FF7: `src/ff7/` is the hub's own seed generator (`kernel.js`, `scene.js` read/write the disc files; `randomizer.js` plans and applies a seed). `src/discpatch.js` stores seeds as sector patches and streams disc + patch; `src/cdsector.js` fixes sector error codes. UI is `ui/ff7.html` + `ui/ff7.js`, tracker logic in `ui/ff7-track.js`, data in `games/ff7.json`. Tests use a made-up disc (`test/fake-ff7.js`), never real game data.
- `games/sotn.json`: the game's data. `scripts/`: `setup.js`, `smoke-packaged.js`. `test/`: disc, memory and map tests.

## Commands

```sh
npm install
npm run setup     # downloads SotN Randomizer into vendor/
npm test          # disc, memory and map tests
npm start         # run it
npm run dist      # Windows installer + portable
```

The `build-windows` workflow builds and smoke-tests the Windows app on every push, so a PR branch gets a build too. Run `npm test` before opening a PR.

The tracker only reads game memory; it never writes it.

Licensing: copies are handed out through Rando Hub's license (like Crowd Control+). `src/license.js` checks `license.json` (next to the .exe) with `/api/license/psx` at start and every 30 minutes, locks the window (`ui/locked.html`) when it fails, and installs updates from `/api/license/psx-download` at start and from Settings → Check for updates. The download is a zip with `PSX Rando Hub Setup.exe` (NSIS; `build/installer.nsh` copies the license.json beside it into the install folder); updates run that Setup with `/S --force-run`. `npm start` is the developer copy (no license). Bump `version` in `package.json` to publish: the Publish workflow uploads the zip to Rando Hub's R2 bucket.

## How to work (Claude via GitHub)

- Robert usually asks for work from an issue or comment and isn't watching. Work on a new branch and open a pull request. **Never push to `main` yourself**: pushes to `main` deploy or publish.
- In the PR, say in plain words what changed, how you checked it, and anything you couldn't test (most of these apps need a real ROM and a browser).
- Never add ROMs, BIOS files, game art or other copyrighted game data to the repo. The apps read them from the player's own files.
- Keep the existing style: plain, friendly wording in READMEs, changelogs and on screen; small focused changes over rewrites.
- If the request is unclear, make the most reasonable reading, say which one you took in the PR, and carry on.
