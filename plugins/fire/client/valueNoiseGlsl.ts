export const VALUE_NOISE_GLSL =  `
  float hash21(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
  }

  float vnoise(vec2 p) {
    vec2 cell = floor(p);
    vec2 f = fract(p);
    vec2 smoothed = f * f * (3.0 - 2.0 * f);
    float a = hash21(cell);
    float b = hash21(cell + vec2(1.0, 0.0));
    float c = hash21(cell + vec2(0.0, 1.0));
    float d = hash21(cell + vec2(1.0, 1.0));
    return mix(mix(a, b, smoothed.x), mix(c, d, smoothed.x), smoothed.y) * 2.0 - 1.0;
  }

  float fnoise(vec2 p) {
    return vnoise(p) * 0.65 + vnoise(p * 2.17 + 11.3) * 0.35;
  }
`;
