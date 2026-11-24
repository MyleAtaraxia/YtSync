# YtSync

Minimal Manifest V3 extension basis for Chrome and Firefox (zero npm dependencies; uses Bun).

## Build & Package

```sh
bun run build   # bundles, minifies, and zips dist/ytsync-{chrome,firefox}-v*.zip
bun run watch   # auto-rebuilds and re-zips on file changes
```

## Load locally

- **Chrome**: Open `chrome://extensions`, enable **Developer mode**, click **Load unpacked**, select `dist/chrome`.
- **Firefox**: Open `about:debugging#/runtime/this-firefox`, click **Load Temporary Add-on...**, select `dist/firefox/manifest.json` (or `dist/ytsync-firefox-v*.zip`).

## Verify

```sh
bun run test    # or: npm test
```
