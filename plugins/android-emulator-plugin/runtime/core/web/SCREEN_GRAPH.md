# Minimap graph panel

The existing per-device Screen map drawer has Graph and Navigate views. Each pinned device frame keeps its own inspection selection, including comparison mode. Selecting a graph node only inspects saved metadata. The explicit Go button calls the existing navigation channel; it does not claim the selected node is the current device screen. The separately labeled Last located screen comes only from navigation status.

`screen-graph.mjs` and `screen-graph.css` are vendored, byte-for-byte copies of the reusable Minimap renderer at `mttmcknn/minimap/web/`. Update these together from that source. The renderer uses the existing panel's semantic CSS variables and receives live host colors/fonts through `applyHostContext`. The integration resets the panel's global SVG icon defaults inside `#minimap-graph`; geometry and fonts are otherwise owned by the portable renderer.

The read-only API is `emulator_navigate({action:'graph'})`, scoped through the same fixed device channel as other panel actions. Its structured result contains `graph` (the metadata-only `minimap.screen-graph.v1` projection or null) and `graphStatus` (`ok`, `uninitialized`, `unsupported`, `unavailable`, or `error`, plus a message). No source fixtures, screenshot URLs, Android observations, replay recipes or private baseline data enter the renderer. Reading the graph does not locate or initialize a map. Graph/status refreshes discard old request generations; app association changes reset selection. Navigation completion refreshes saved knowledge.

The drawing shows the selected screen's outgoing connections, or incoming and outgoing connections in focus mode. The full directed matrix and route list retain every exported connection. The diagram uses local horizontal scrolling at narrow/comparison widths and does not reduce text to fit. A schema error or unavailable backend displays a status message without invented screens.

Local checks:

- `node --test test/minimap-graph-ui.test.mjs` verifies inspection/navigation separation, readiness gates, missing/empty graphs, removed selection, request races, keyboard tabs and independent frame state.
- `test/minimap-graph.browser.mjs` exercises the actual self-contained panel resource and its blob device frames in headless Chromium. Set `MINIMAP_PLAYWRIGHT_MODULE` and `MINIMAP_BROWSER_PATH` when the runtime dependencies live outside this repository. Its transport data is explicitly synthetic and lives only in test code. The script checks complete topology, global SVG isolation, live host styles, keyboard focus, narrow scrolling and fixed comparison channels. This fixture QA supplements actual host/device QA; it does not establish observed app coverage.

The Codex resource builder inlines both renderer assets into the existing app module/style resource, so cloned blob device frames require no network resources. The local helper serves the same files under whitelisted static routes. The panel's CSP continues to allow no network connect/resource domains.
