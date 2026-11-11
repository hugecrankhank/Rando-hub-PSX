# PSX Rando Hub

A Windows desktop hub for PlayStation randomizers: built-in emulator, auto-tracker and seed generator in one window.
First game: **Castlevania: Symphony of the Night (USA)**.

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

## Get the .exe

You get two files: `PSX-Rando-Hub-Setup-x.y.z.exe`, which installs the hub with desktop and Start-menu shortcuts, and `PSX-Rando-Hub-Portable-x.y.z.exe`, which runs without installing. The SotN Randomizer is bundled and runs on Electron's own Node, so the finished app needs nothing else installed.

**Option A — let GitHub build it (no tools on your PC):** push this folder to a GitHub repo. Go to **Actions → Build Windows installer → Run workflow**. When it finishes, download **PSX-Rando-Hub-Windows** from the run page. Pushing a tag like `v0.1.0` also attaches both .exe files to a GitHub Release.

**Option B — build on your PC:** install [Node.js LTS](https://nodejs.org), then double-click `Build-Windows-Installer.bat`. The `dist` folder opens when it's done. (Same as `npm run setup` then `npm run dist`.)

Windows SmartScreen may warn "unrecognized app" the first time, because the exe isn't code-signed. Click **More info → Run anyway**.

## How auto-tracking works

The hub reads the boot executable (`SLUS_000.67`) straight from the disc image, takes a few 64-byte slices of it, and searches the emulator's WebAssembly memory for them. Once the BIOS has loaded the game, those slices sit at known RAM addresses, which tells the hub exactly where PS1 RAM is. It then reads the relic table (`0x80097964`, 30 bytes) four times a second. This doesn't depend on a particular core build, and it re-calibrates itself if the core moves its memory.

The status pill in the top right shows **Waiting for game → Finding game RAM → Auto-tracking live**.

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

Press **F12** for developer tools. `npm test` runs the disc-parser and RAM-locator tests.
