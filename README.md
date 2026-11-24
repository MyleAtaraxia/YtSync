# YtSync Extension

Chrome and Firefox (MV3) extension for syncing YouTube playback in a shared room.

## Usage

1. Open a YouTube tab.
2. Open the **YtSync** popup and enter a display name.
3. Click **Create room** to share a room code, or enter a code and click **Join room**.

## Build

Requires [Bun](https://bun.sh) (zero npm dependencies).

```sh
bun run build   # builds and zips Chrome & Firefox into dist/
bun run watch   # rebuilds on file changes
bun run test    # runs checks
```

Load unpacked from `dist/chrome` (Chrome) or `dist/firefox/manifest.json` (Firefox).
