// Test worlds with real terrain.
//
// The shipped harness (server/test/support/harness.ts) only builds FLAT worlds,
// which for this plugin means "no ground high enough to snow on anywhere" — a
// perfectly good case, and one this suite uses, but not the only one. This adds
// the one thing the snow siting test needs: a height field, built through the
// same World.restore path a snapshot uses.
//
// This is the wildlife plugin's test/support/world.ts, restated rather than
// imported: a plugin's test suite depending on another plugin's fixtures would
// be the same cross-plugin coupling the shipped code refuses.

// The builder itself lives in core's test support now
// (server/test/support/world.ts). It was a byte-identical copy in five plugin
// suites; the "a plugin's tests must not depend on another plugin" rule it was
// kept under is about a NEIGHBOURING PLUGIN, and core's test support is what
// every one of those suites already reaches for.
export { worldWithTerrain } from '../../../../server/test/support/world.ts';
