# SpineTree navigation for Pi

Optional companion to `@spinejit/pi-spinejit`. The core alone displays the bottom
tree and registers no browsing command. Loading this package adds
`/spine-tree [node-id]`; only this package owns that command.

## Local use

Build from the `scaffold/spine-sdk-plugin` workspace:

```sh
npm run build -w @spinejit/pi-spinejit
npm run build -w @spinejit/spinetree-navigation
pi -e ./packages/plugin/src/pi/extension.ts -e ./packages/spinetree-navigation/src/extension.ts
```

Load each extension once. Either order works. Package discovery uses the
TypeScript paths declared in `pi.extensions`. The compiled `dist` entries remain
package exports, but loading them directly bypasses the host virtual module.
These private workspace packages are not published to npm.
The supported dependency versions are Pi coding-agent and pi-tui 1.1.0.
No Pi-host changes or fullscreen mode are required.

When SpineTree L1 reports `st` at session startup, navigation does not request
or show the SDK tree. `/spine-tree` instead points to `/st` and shell
`st branch/show/context`. This decision is frozen per session and is independent
of extension load order; without an L1 responder SDK navigation is unchanged.

## Interaction

- `/spine-tree` selects the current execution node in the bottom tree.
- `/spine-tree 1.2` opens that node's memory.
- Up/down select; left/right collapse/expand or move to parent/child.
- Enter reads memory. Up/down scroll; PageUp/PageDown turn pages.
- Tab in memory switches between the node's summary and its full returned memory.
- Escape returns to the tree, then exits.

The tree shares the core's green branding, status colors and branch lines.
The accent `>` is the selection; `◉` still identifies the execution cursor.
Help shows only actions for the current view, using the host's configured keys;
help wraps in narrow terminals instead of hiding exit instructions.

Memory appears above the same core-owned widget. The transcript replay panel has
been removed. Browsing and reading memory do not switch the session or send messages.

Each invocation captures the published Spine nodes and memory on the current session.
It stays fixed while the agent progresses; reopen for newer data. Exit restores the
newest default tree. The navigator does not inspect Pi transcript history, replay
messages, jump the session tree, or change continuation state. Own memory selects
this node's summaries; full memory preserves user and child evidence in slot order.
Nodes without a final memory show their status.

## Validation and remaining limits

Tests cover real WASM Open/Next/Spawn/compact/namespace fixtures, view isolation,
bounded rendering and navigation. Real regular-mode Pi checks cover both load
orders, core-only/navigation-only, tree selection and long memory, resize, external
overlay return, and reload/new-session while browsing. No provider requests are
needed for these checks. Recorded harness:
`tasks/pi_spine_tree_navigation_20260920_1724/validation/host/` in the outer repo.

Tree layout stays in its bottom widget; first expansion in a short conversation
and terminal resizing can change absolute screen rows. Arbitrary simultaneous
non-overlay custom editors from unrelated extensions have no Pi ownership lease
and are not claimed compatible. Real provider streaming and all terminal/plugin
combinations have not been exhaustively tested; background state publication is
covered by core tests. Memory is exposed as ordered sections and the reader lays
out only the current section plus sections needed to fill the viewport. An
exceptionally large individual section is still laid out as one Markdown document.
