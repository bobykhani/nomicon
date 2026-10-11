# Site

Viewers and pages that render World data. This directory is code, so it belongs to the Laws layer and changes by the Laws procedure.

- `replicator-map.html`: renders `world/replicator-map/`. Serve the repository root over HTTP and open `site/replicator-map.html`. It fetches the JSON files relative to itself, so opening it as a local file does not work.
