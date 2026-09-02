// Test worlds with real terrain.
//
// The shipped harness (server/test/support/harness.ts) only builds FLAT
// worlds — every cell at height 0, i.e. entirely water — on which nothing
// this plugin does is observable. This adds the one thing structures needs: a
// height field with dry, flat land in it, built through the same World.restore
// path a snapshot uses.
//
// A COPY of flora's equivalent helper, not an import: a plugin must build and
// test with every other plugin deleted.

// The builder itself lives in core's test support now
// (server/test/support/world.ts). It was a byte-identical copy in five plugin
// suites; the "a plugin's tests must not depend on another plugin" rule it was
// kept under is about a NEIGHBOURING PLUGIN, and core's test support is what
// every one of those suites already reaches for.
export { worldWithTerrain } from '../../../../server/test/support/world.ts';
