# Plugin host

Dated decisions moved out of `docs/DESIGN.md` on 2026-09-01. Settled with the owner; do not relitigate without new information.

## Decisions made 2026-08-26 (a plugin asks the host for its sibling)

Every cross-plugin bridge used to reach for its sibling with
`import('../../<name>/server/index.ts')` (the pattern relics→mana established,
16 files). That specifier binds to a MODULE URL, not to "the plugin running as
`<name>` in this session", and issue #196 closes the two things that follow
from it: a sibling reloaded under a new URL would leave every consumer feeding
the old module with nothing thrown and nothing logged, and a sibling the
operator DISABLED for a world went on answering, because its module is resident
either way.

**The host is now the only holder of module identity.** `WorldApi.sibling(name)`
hands back the server module of the plugin running as `name` here, or null. A
plugin that is not installed, and one that is installed but switched off for
this world, are the same null — which is what makes toggling `structures`
itself safe, and what Phase S's model selector depends on. Discovery keeps each
plugin's imported namespace on its `LoadedPlugin` and the host narrows the map
to the enabled set per session; the view is revoked with every other member
when the world closes.

**Two of the bridge pattern's four rules became host guarantees; two stayed
with the caller.** The host guarantees the lookup never throws for an absent
sibling and answers synchronously whatever the load order — so
`DEFAULT_*_MODULE_LOADER`, the loader test seams and the `*BridgeReady`
promises are gone, and `plugins/` contains no `import('../../…')` at all.
Buffer-don't-drop and duck-typing stay in each bridge: core cannot know what a
consumer wanted to say to a sibling, nor which members of it that consumer
needs. Each bridge re-resolves on every `onWorldCreate`, so a sibling enabled
between sessions is picked up on the reopen and the buffered desired state is
replayed into it — and a sibling that stopped running is cleared rather than
left reachable through a stale reference.

**This is also the npm-plugin step (§3.5).** The one line per bridge that used
to encode "plugins are folders on disk" is now a plugin NAME, so where a
sibling's code lives stopped being a bridge's business.

## Decisions made 2026-08-26 (one plugin's code reloads in place, #198)

`worldPluginReload` re-imports ONE plugin's server code into the running
process and rebuilds the live world over it, carrying every connected player
across exactly as an enablement change does. Admin-key gated, like every other
world-management action.

**Either the new module runs everywhere, or the old one still does.** Four
steps can reject a build — the import, the plugin's `onWorldCreate` (with the
slice restore before it), its own refusal of its saved data, and one real probe
tick — and any of them puts the previous `LoadedPlugin` back and opens the world
again over it, which replays that module's state from the slice. Two of those
four throws are swallowed by the host's `safely` (a broken plugin must not take
the world down), so the host now COUNTS its per-plugin faults: without a count
"it did not throw" would be read as "it works".

**The re-import is cache-busted by a generation carried in the URL.** Node's
module map has no eviction, so a stateless resolve hook copies the generation
tag from a parent URL onto every child it resolves INSIDE that plugin's own real
directory — the subtree comes back fresh, and core (which several plugins import
by relative path) is never re-imported alongside it.

**KNOWN RESIDUAL — the reload leaks, measured.** The previous generation's
module namespaces stay reachable through the module map and can never be
collected. On the rig (2026-08-26, `~/.terrace-plugtest-p4`, 20 reloads of
`structures`, the largest plugin, heap read after two forced GCs): **≈0.66 MB of
heapUsed and ≈3.3 MB of RSS per reload**. A two-file toy plugin cost 17–33 KB
per reload over two runs. That is dev-loop scale, not production scale — 100
reloads of the largest plugin is ~66 MB — and it is why `serverRestart` remains
the recommended way to update a plugin and this is the button beside it, not
instead of it.

**The client half still needs the page.** A plugin's client code is compiled
into the bundle, so a successful reload rebinds the build identity (the plugin
stamp it is derived from moves — with a `-reload.<n>` marker, because a
deployment with no git stamps every plugin identically for the life of the
process) and one more join snapshot per connected player carries it, firing the
client's existing one-shot page reload.

**The identity is rebound AFTER the probe, not before the reopen (#209,
2026-08-29).** The either/or has to hold on the wire too, and a client acts on
the first identity that differs from the one it joined under and ignores every
later one — so an identity announced by the probe's own reopen would page-reload
every browser for a build that the three checks after that reopen may still
reject, and the rollback could not take it back. The reopen therefore re-states
the identity the pages already joined under (which reloads nothing), and the new
one goes out by itself once the probe has passed. The rejected shape: probe in a
session whose join snapshots are withheld and send them after a pass — that
breaks the snapshot-before-`onPlayerJoin` ordering `openInto` STEP 7 shares with
`TerraceRoom.onJoin`, because a plugin's `onPlayerJoin` would then broadcast to
a client not yet sized for the rebuilt world.

## Decisions made 2026-09-01 (three world invariants are plain data on the plugin view, #277)

**`WorldApi.worldSize`, `chunksPerEdge` and `difficulty` are captured at view
construction, not read through the revocable getter.** The 2026-08-25 rule —
a revoked view THROWS rather than no-ops — stands for every member that reads
the World; these three are the deliberate exception, because they cannot
change while the World exists (`map` is a readonly field; difficulty is set
in the constructor) and a stale copy of an integer edge length can mislead
nobody. The getter form cost a closure dispatch and a null test per read, and
the structures tick reads `worldSize` once per scanned cell before any
early-out: 4.1% of server busy time in the 2026-08-29 profile. `simMillis`
moves every tick and `genesisMillis` is stamped after construction, so both
stay getters.
