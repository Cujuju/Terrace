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
