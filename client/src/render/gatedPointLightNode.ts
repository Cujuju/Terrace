import { PointLightNode, type Node, type NodeBuilder, type NodeFrame } from 'three/webgpu';
import { If, uniform } from 'three/tsl';

// Uniform value: 1 = light on, 0 = dark.
const LIT = 1;
const DARK = 0;

// Gates direct-light BRDF math behind a uniform branch, so a dark fixed-pool
// light (fire, thunderstorm) costs nothing without recompiling the pipeline.
export class GatedPointLightNode extends PointLightNode {
  private readonly litNode = uniform(DARK);

  update(frame: NodeFrame): boolean | undefined {
    const result = super.update(frame);
    this.litNode.value = this.light !== null && this.light.intensity > 0 ? LIT : DARK;
    return result;
  }

  // Mirrors AnalyticLightNode.setup(), gating only setupDirectLight; shadows
  // are untouched (fire/thunderstorm lights never cast them).
  setup(builder: NodeBuilder): Node | null | undefined {
    // @types/three omits these AnalyticLightNode fields; cast to match upstream.
    const internal = this as unknown as {
      colorNode: unknown;
      baseColorNode: unknown;
      shadowNode: { dispose(): void } | null;
      shadowColorNode: unknown;
    };

    internal.colorNode = internal.baseColorNode || internal.colorNode;

    if (this.light !== null && this.light.castShadow) {
      if (builder.object.receiveShadow) {
        this.setupShadow(builder);
      }
    } else if (internal.shadowNode !== null) {
      internal.shadowNode.dispose();
      internal.shadowNode = null;
      internal.shadowColorNode = null;
    }

    const directLightData = this.setupDirect(builder);
    const directRectAreaLightData = this.setupDirectRectArea(builder);

    // builder.lightsNode is set transiently by LightsNode.setup(); untyped.
    const lightsNode = (
      builder as unknown as {
        lightsNode: {
          setupDirectLight(b: NodeBuilder, lightNode: unknown, lightData: unknown): void;
          setupDirectRectAreaLight(b: NodeBuilder, lightNode: unknown, lightData: unknown): void;
        };
      }
    ).lightsNode;

    if (directLightData) {
      If(this.litNode.greaterThan(DARK), () => {
        lightsNode.setupDirectLight(builder, this, directLightData);
      });
    }

    if (directRectAreaLightData) {
      lightsNode.setupDirectRectAreaLight(builder, this, directRectAreaLightData);
    }

    return undefined;
  }
}
