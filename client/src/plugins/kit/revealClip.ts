// The reveal clip, for a plugin that writes its own `ShaderMaterial`.
//
// A STOCK material is clipped by `ClientPluginCtx.applyRevealClip(material,
// label)` and needs nothing from this file. A `ShaderMaterial` has no
// `onBeforeCompile` worth splicing — the plugin owns the whole source — so it
// pastes these three snippets and merges `ClientPluginCtx.revealClipUniforms()`
// into its own uniform object:
//
//   const material = new ShaderMaterial({
//     uniforms: { ...ctx.revealClipUniforms(), uMine: { value: 0 } },
//     vertexShader: `
//       ${REVEAL_CLIP_UNIFORMS_GLSL}
//       void main() {
//         vec3 world = /* wherever this renderer puts its particle */;
//         ${REVEAL_CLIP_VERTEX_GLSL}
//         ...
//       }`,
//     fragmentShader: `
//       ${REVEAL_CLIP_UNIFORMS_GLSL}
//       void main() {
//         ${REVEAL_CLIP_FRAGMENT_GLSL}
//         ...
//       }`,
//   });
//
// THE UNIFORM OBJECT IS SHARED, not copied: spreading it into the material's
// own uniforms puts the SAME `{ value }` boxes in both, so one mask upload
// reaches every material at once, exactly as it does for the spliced path.
//
// RE-EXPORTS, NOT COPIES. The definitions live in render/revealMask.ts beside
// the texture whose layout they read and the splice that pastes the same
// strings into stock materials; two copies of a shader snippet that must agree
// is two things that can drift. This file is the plugin-facing name for them,
// the same way the rest of kit/ is a façade over core's primitives.

export {
  REVEAL_CLIP_UNIFORMS_GLSL,
  REVEAL_CLIP_VERTEX_GLSL,
  REVEAL_CLIP_FRAGMENT_GLSL,
  REVEAL_CLIP_THRESHOLD,
  type RevealClipUniforms,
} from '../../render/revealMask.ts';
