// A `document` with just enough canvas for models.ts to import under Node.
//
// client/models.ts draws Durand's sign board into a 2D canvas AT MODULE INIT
// (DURANDS_SIGN_TEXTURE), so merely importing it in a test throws
// "document is not defined" — which is why models.test.ts could not have been
// written against createStructureModels() without this. The stub returns a
// NULL 2D context on purpose rather than faking one: buildDurandsSignTexture
// already handles that case by design ("a blank sign board is a cosmetic
// miss, not a crash"), so this exercises a path the shipping code documents
// instead of inventing a fake drawing surface the tests would then depend on.
//
// Imported for its side effect, and it must be the FIRST import in any test
// file that reaches models.ts: static imports evaluate in source order, and
// the texture is built during that evaluation.

interface StubCanvas {
  width: number;
  height: number;
  getContext(kind: string): null;
}

if (typeof (globalThis as { document?: unknown }).document === 'undefined') {
  (globalThis as { document?: unknown }).document = {
    createElement(tag: string): StubCanvas {
      if (tag !== 'canvas') throw new Error(`headlessCanvas: only <canvas> is stubbed, asked for <${tag}>`);
      return { width: 0, height: 0, getContext: () => null };
    },
  };
}
