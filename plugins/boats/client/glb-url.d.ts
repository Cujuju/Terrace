// Ambient declaration for authored-model URL imports (`*.glb?url`).
//
// This file must stay import/export free so the declaration below is global
// rather than module-scoped. This package's tsconfig takes only "node" types,
// so vite/client (which other packages get these from) is not in scope here.

declare module '*.glb?url' {
  const url: string;
  export default url;
}
