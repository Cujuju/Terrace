// Test worlds with real terrain.
//
// The shipped harness (server/test/support/harness.ts) only builds FLAT worlds,
// which are entirely shallow water — no land, no deep sea, so no habitat for
// three of the four species. This adds the one thing wildlife needs: a height
// field, built through the same World.restore path a snapshot uses.

// The builder itself lives in core's test support now
// (server/test/support/world.ts). It was a byte-identical copy in five plugin
// suites; the "a plugin's tests must not depend on another plugin" rule it was
// kept under is about a NEIGHBOURING PLUGIN, and core's test support is what
// every one of those suites already reaches for.
export { worldWithTerrain } from '../../../../server/test/support/world.ts';
