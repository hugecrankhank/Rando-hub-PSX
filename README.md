# PSX Rando Hub

A Windows desktop hub for PlayStation randomizers: built-in emulator, auto-tracker and seed generator in one window.
Games: **Castlevania: Symphony of the Night (USA)** and **Final Fantasy VII (USA)**. Switch between them with the game name in the top-left corner.

- **Emulator** — EmulatorJS running a libretro PS1 core (PCSX ReARMed by default, Beetle PSX HW optional) inside the app. Gamepad, save states and key mapping live in the emulator's own toolbar (hover the game).
- **Seed generator** — the community SotN Randomizer (the logic behind sotn.io). Every preset it ships, custom seed names, tournament mode, spoiler logs, seed history.
- **Tracker** — all 30 relics are **auto-tracked from game memory**. Gold Ring, Silver Ring, Spike Breaker and Holy Glasses are click-to-mark. There's also a boss checklist and a race timer. Tracker state is saved per seed.

Your BIOS and game files are never bundled. The app reads them from your PC.

## What you need

- Windows 10 (1803+) or 11
- [Node.js LTS](https://nodejs.org) (only needed to build; the finished app doesn't need it)
- A PS1 BIOS (512 KB, e.g. SCPH-1001 / SCPH-5501)
- Your SOTN USA disc image: the **Track 1 .bin** (SLUS-00067). Redump names it `Castlevania - Symphony of the Night (USA) (Track 1).bin`.

## First run

```powershell
cd psx-rando-hub
npm install          # Electron + builder
npm run setup        # downloads SotN Randomizer into vendor/
npm start            # launches the hub
```

In the app, open **Settings**, choose your BIOS and your Track 1 .bin, then go to **Seeds → Generate seed**.
The first time you start a game the app downloads the emulator core and caches it, so after that it works offline.

## Getting PSX Rando Hub (licensed)

PSX Rando Hub is handed out through Rando Hub's license, the same way as Crowd Control+:

1. Hank authorizes your license for PSX Rando Hub (Rando Hub's admin page, **Authorize** in the PSX Rando Hub row).
2. On Rando Hub, signed in with your key, open **/download/** on your PC and download **PSX Rando Hub**. It's made for you: the zip has **PSX Rando Hub Setup.exe** and a `license.json` with your license's token.
3. Extract the whole zip (right-click, **Extract All**), open the extracted folder and run **PSX Rando Hub Setup**. It installs the app for your Windows user, copies your license into the install folder, and adds Start menu and desktop shortcuts. (Run from inside the zip without extracting, it can't see the license and says so.)

- **License checks.** The app checks your license with Rando Hub when it starts and every 30 minutes. If the license is turned off, the app locks and says why. Offline, it keeps working for 3 days from the last good check. Your name and build show in the top bar.
- **Updates.** Every time it starts, the app installs a newer version by itself if there is one (it downloads the new Setup, closes, runs it silently and reopens). Settings → **Check for updates** does the same on demand. Your settings, seeds and saves stay.
- **Publishing a new version.** Bump `version` in `package.json` and merge to `main`. The **Publish to Rando Hub** workflow builds the app and uploads the plain zip to Rando Hub's download bucket (`rando-hub-downloads/psx/PSX-Rando-Hub-v<version>.zip`). It needs the repository secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` (the same ones as Rando Hub's).
- `npm start` (the developer copy) needs no license. Builds without a `license.json`, like the ones below, open to the lock page.

## Get the .exe

You get two files: `PSX-Rando-Hub-Setup-x.y.z.exe`, which installs the hub with desktop and Start-menu shortcuts, and `PSX-Rando-Hub-Portable-x.y.z.exe`, which runs without installing. The SotN Randomizer is bundled and runs on Electron's own Node, so the finished app needs nothing else installed.

**Option A — let GitHub build it (no tools on your PC):** push this folder to a GitHub repo. Go to **Actions → Build Windows installer → Run workflow**. When it finishes, download **PSX-Rando-Hub-Windows** from the run page. Pushing a tag like `v0.1.0` also attaches both .exe files to a GitHub Release.

**Option B — build on your PC:** install [Node.js LTS](https://nodejs.org), then double-click `Build-Windows-Installer.bat`. The `dist` folder opens when it's done. (Same as `npm run setup` then `npm run dist`.)

Windows SmartScreen may warn "unrecognized app" the first time, because the exe isn't code-signed. Click **More info → Run anyway**.

## Final Fantasy VII

FF7 uses the hub's **own seed generator**, written for this app. You need your three USA discs as .bin files (SCUS-94163, SCUS-94164, SCUS-94165). If yours are zipped, unzip them first, then pick each disc under **Settings** on the FF7 page (picking the .cue works too).

**What a seed can change**

| Option | Choices |
| --- | --- |
| Starting materia | Vanilla, Random (fair, always includes a Restore), Chaos (anything except Master materia) |
| Starting weapons & armor | Vanilla, Random lower-tier gear, Chaos. Characters only get gear they can equip. |
| Enemy drops & steals | Vanilla, shuffled among enemies of similar level, shuffled across the game, or random from the game's drop pool. Morph items can be included. |
| Materia slots | Vanilla, or shuffled (a weapon swaps slots with another of the same character's weapons; armor among armor) |
| EXP / AP / Gil | ×1 to ×4 |

Presets: Casual, Standard, Wild, Chaos and Drops only. Every seed comes with a spoiler log.

**How it works.** The generator reads `INIT/KERNEL.BIN` and `BATTLE/SCENE.BIN` from your discs, makes one plan from Disc 1, and applies it to all three discs (each disc loads its own copy at boot). It first checks that your disc's data looks the way it expects; any option whose check fails is switched off and the log says so. A seed is saved as a small patch per disc (a few hundred KB), not a copy of the discs, and the hub plays "your disc + patch". **Export** on a seed writes full patched .bin/.cue/.m3u files if you want to play it in another emulator.

**Changing discs.** When the game asks for the next disc, save to your memory card, then press **Disc 2** (or 3) under the game. The emulator restarts with that disc; pick Continue and load your save. The memory card is shared by all three discs of a seed.

**Tracker.** Summons, command, support and key magic materia light up automatically when they're in your materia list or equipped. The party, everyone's level, gil, in-game time and story progress update live. Bosses are a checklist. Click a tile to mark it yourself.

## How auto-tracking works

The hub reads the boot executable (`SLUS_000.67`) straight from the disc image, takes a few 64-byte slices of it, and searches the emulator's WebAssembly memory for them. Once the BIOS has loaded the game, those slices sit at known RAM addresses, which tells the hub exactly where PS1 RAM is. It then reads the relic table (`0x80097964`, 30 bytes) four times a second. This doesn't depend on a particular core build, and it re-calibrates itself if the core moves its memory.

The status pill in the top right shows **Waiting for game → Finding game RAM → Auto-tracking live**.

For FF7 the hub finds PS1 RAM the same way, then looks for the save data block (nine character records in a row) and reads it twice a second.

## Adding more PS1 games later

Each game is a JSON file in `games/` (see `games/sotn.json`). It lists the expected boot executable, the randomizer to use, memory offsets and tracker tiles. The disc reader and RAM locator are generic.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| "Seed generator: Not installed" | Run `npm run setup`, or download SotN Randomizer and pick its folder in Settings. |
| Randomizer fails with unknown-argument errors | Different randomizer versions use different flags. Put the right flags under Seeds → Advanced. The hub auto-detects `-i/-o` style vs. in-place patching. |
| Tracking stays on "Finding game RAM" | Make sure you loaded the Track 1 .bin (not the .cue). Try the other core in Settings. Press F12 for devtools and check the console. |
| Black screen / BIOS error | Check the BIOS badge in Settings says OK (512 KB). |
| Disc badge shows a different exe | The image isn't SOTN USA. Seeds need the USA version. |
| FF7: "Turned off …" in the seed log | Your disc's data didn't pass a safety check for that option, so the seed skips it. Check it's the USA disc. |
| FF7: "made from a different copy of the disc" | The seed was generated from another disc image. Pick that image again, or make a new seed. |
| FF7: tracker stays on "Waiting for New Game / Continue" | Start a new game or load a save; the tracker needs the game's save data in memory. |

Press **F12** for developer tools. `npm test` runs the disc-parser and RAM-locator tests.
