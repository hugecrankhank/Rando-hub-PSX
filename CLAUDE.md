# PSX Rando Hub

Robert's Windows desktop hub (Electron) for PlayStation randomizers: built-in emulator, auto-tracker and seed generator in one window. First game: Castlevania: Symphony of the Night (USA).

- Emulator: EmulatorJS with a libretro PS1 core (PCSX ReARMed default, Beetle PSX HW optional).
- Seeds: the community SotN Randomizer, downloaded into `vendor/` by `npm run setup` (not committed).
- Tracker: the 30 relics are auto-tracked from game memory; a few items are click-to-mark; boss checklist and race timer; state saved per seed.
- BIOS and disc images are never bundled; the app reads them from the user's PC.

## Layout

- `src/`: Electron main process (`main.js`, `preload.js`), disc reading (`disc.js`, `zipdisc.js`), the seed generator glue (`randomizer.js`), the map (`sotn-map.js`).
- `ui/`: the window (`index.html`, `app.js`, `emu.html`, `memory.js` for the autotracker, `popout.html`).
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

## How to work (Claude via GitHub)

- Robert usually asks for work from an issue or comment and isn't watching. Work on a new branch and open a pull request. **Never push to `main` yourself**: pushes to `main` deploy or publish.
- In the PR, say in plain words what changed, how you checked it, and anything you couldn't test (most of these apps need a real ROM and a browser).
- Never add ROMs, BIOS files, game art or other copyrighted game data to the repo. The apps read them from the player's own files.
- Keep the existing style: plain, friendly wording in READMEs, changelogs and on screen; small focused changes over rewrites.
- If the request is unclear, make the most reasonable reading, say which one you took in the PR, and carry on.
