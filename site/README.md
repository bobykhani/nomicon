# Site

Viewers and pages that render World and ledger data. This directory is code, so it belongs to the Laws layer and changes by the Laws procedure.

The site is served by GitHub Pages straight from the `main` branch root, with no build step: `.nojekyll` at the root turns the Jekyll pass off, so files are published exactly as committed and nothing in the repository is ever interpreted. `index.html` at the root is the landing page. Each page fetches its data by relative path, so the same pages work from any static server pointed at the repository root.

- `replicator-map.html`: renders `world/replicator-map/`. Serve the repository root over HTTP and open `site/replicator-map.html`. It fetches the JSON files relative to itself, so opening it as a local file does not work.
- `leaderboard.html`: renders `ledger/state.json` and `ledger/questions.json`: weight by account, open and answered questions, open votes. Same serving rule.
