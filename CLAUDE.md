# wordhoard

Notes for Claude sessions working in this repo.

## PWA identity rules (shared origin)

This app shares `https://robertwalterj.github.io/` with all of Robert's other apps, so browser storage and Chrome install records are shared. Full rules: `PWA-IDENTITY-RULES.md` in `GPA Work - Claude Cowork\PWA Repos\`.

- Manifest `id` is unique and never the origin root: use `/<repo>/`. `scope` and `start_url` stay in this app's own folder, with no `#fragment`.
- Every cache, localStorage key and IndexedDB name carries this app's prefix.
- The service worker `activate` step deletes only caches with this app's prefix (beware overlapping prefixes). Never call global `caches.match()`; use `caches.open(OWN).then(c => c.match(req))`.
- Never serve `manifest.webmanifest` cache-first. Bump the cache name when the shell changes.
- Never edit a generated `docs/` by hand: fix the source and rebuild.
- Changing the id or scope makes Chrome treat this as a new app: tell Robert to uninstall and reinstall.
- If Chrome says "already installed" when it is not, add an in-page Install button (`beforeinstallprompt`) before anything drastic. Never suggest clearing site data for the whole origin without warning, because it resets every app's saved progress.
