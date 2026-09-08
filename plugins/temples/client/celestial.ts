import {
  AdditiveBlending,
  BackSide,
  Color,
  ConeGeometry,
  Group,
  Mesh,
  MeshBasicMaterial,
  MeshLambertMaterial,
  OctahedronGeometry,
  SphereGeometry,
  TorusGeometry,
  type BufferGeometry,
  type Material,
} from 'three';

const TWO_PI = Math.PI * 2;

const STONE_RADIUS_FRACTION = 0.085;
const HALO_SCALE = 1.6;
const BLOOM_SCALE = 2.8;
const HOVER_GAP_FRACTION = 0.18;

const OUTER_RING_RADIUS_FRACTION = 0.26;
const INNER_RING_RADIUS_FRACTION = 0.19;
const RING_TUBE_FRACTION = 0.01;

const OUTER_RING_TILT = 0.42;
const INNER_RING_TILT = -1.05;

const MOTE_COUNT = 3;
const MOTE_RADIUS_FRACTION = 0.017;

const SHAFT_HEIGHT_FRACTION = 1.6;
const SHAFT_TOP_RADIUS_FRACTION = 0.075;

const STONE_SPIN_TURNS_PER_SECOND = 0.055;
const HALO_SPIN_TURNS_PER_SECOND = -0.031;

const OUTER_RING_TURNS_PER_SECOND = 0.043;
const INNER_RING_TURNS_PER_SECOND = -0.067;

const BOB_AMPLITUDE_FRACTION = 0.018;
const BOB_HZ = 0.11;

const BREATH_HZ = 0.17;
const HALO_BREATH = 0.13;

const SHAFT_OPACITY_BASE = 0.16;
const SHAFT_OPACITY_SWING = 0.06;

const AUREOLE_OPACITY = 0.72;
const BLOOM_OPACITY = 0.3;

const STONE_COLOR = 0xfff6e2;
const HALO_COLOR = 0x4a2fd6;
const RING_COLOR = 0xe0b45c;
const MOTE_COLOR = 0xbdf0ff;
const SHAFT_COLOR = 0x8f74ff;

const AURORA_HZ = 0.043;
const AURORA_COOL_COLOR = 0x1f9e9a;

export interface CelestialCrown {
  readonly root: Group;
  animate(seconds: number): void;
  dispose(): void;
}

export function createCelestialCrown(span: number, summitY: number): CelestialCrown {
  const geometries: BufferGeometry[] = [];
  const materials: Material[] = [];
  const keepGeometry = <T extends BufferGeometry>(geometry: T): T => {
    geometries.push(geometry);
    return geometry;
  };
  const keepMaterial = <T extends Material>(material: T): T => {
    materials.push(material);
    return material;
  };

  const stoneRadius = span * STONE_RADIUS_FRACTION;
  const hoverY = summitY + span * HOVER_GAP_FRACTION + stoneRadius;

  const root = new Group();
  root.name = 'temples:crown';

  const stone = new Group();
  stone.position.y = hoverY;
  root.add(stone);

  const core = new Mesh(
    keepGeometry(new OctahedronGeometry(stoneRadius, 0)),
    keepMaterial(new MeshBasicMaterial({ color: STONE_COLOR })),
  );
  stone.add(core);

  const haloMaterial = keepMaterial(
    new MeshBasicMaterial({
      color: HALO_COLOR,
      transparent: true,
      opacity: AUREOLE_OPACITY,
      side: BackSide,
      depthWrite: false,
    }),
  );
  const halo = new Mesh(keepGeometry(new OctahedronGeometry(stoneRadius, 0)), haloMaterial);
  halo.scale.setScalar(HALO_SCALE);
  stone.add(halo);

  const bloomMaterial = keepMaterial(
    new MeshBasicMaterial({
      color: HALO_COLOR,
      transparent: true,
      opacity: BLOOM_OPACITY,
      blending: AdditiveBlending,
      depthWrite: false,
    }),
  );
  const bloom = new Mesh(keepGeometry(new OctahedronGeometry(stoneRadius, 0)), bloomMaterial);
  bloom.scale.setScalar(BLOOM_SCALE);
  stone.add(bloom);

  const ringMaterial = keepMaterial(
    new MeshLambertMaterial({ color: RING_COLOR, flatShading: true }),
  );

  const outerTilt = new Group();
  outerTilt.position.y = hoverY;
  outerTilt.rotation.z = OUTER_RING_TILT;
  const outerSpin = new Group();
  outerTilt.add(outerSpin);
  root.add(outerTilt);

  const outerRadius = span * OUTER_RING_RADIUS_FRACTION;
  const ringTube = span * RING_TUBE_FRACTION;
  const outerRing = new Mesh(
    keepGeometry(new TorusGeometry(outerRadius, ringTube, 6, 40)),
    ringMaterial,
  );
  outerRing.rotation.x = Math.PI / 2;
  outerSpin.add(outerRing);

  const moteGeometry = keepGeometry(
    new SphereGeometry(span * MOTE_RADIUS_FRACTION, 8, 6),
  );
  const moteMaterial = keepMaterial(new MeshBasicMaterial({ color: MOTE_COLOR }));
  for (let i = 0; i < MOTE_COUNT; i++) {
    const angle = (i / MOTE_COUNT) * TWO_PI;
    const mote = new Mesh(moteGeometry, moteMaterial);
    mote.position.set(Math.cos(angle) * outerRadius, 0, Math.sin(angle) * outerRadius);
    outerSpin.add(mote);
  }

  const innerTilt = new Group();
  innerTilt.position.y = hoverY;
  innerTilt.rotation.x = INNER_RING_TILT;
  const innerSpin = new Group();
  innerTilt.add(innerSpin);
  root.add(innerTilt);

  const innerRing = new Mesh(
    keepGeometry(
      new TorusGeometry(span * INNER_RING_RADIUS_FRACTION, ringTube, 6, 36),
    ),
    ringMaterial,
  );
  innerRing.rotation.x = Math.PI / 2;
  innerSpin.add(innerRing);

  const shaftHeight = span * SHAFT_HEIGHT_FRACTION;
  const shaftMaterial = keepMaterial(
    new MeshBasicMaterial({
      color: SHAFT_COLOR,
      transparent: true,
      opacity: SHAFT_OPACITY_BASE,
      depthWrite: false,
    }),
  );
  const shaft = new Mesh(
    keepGeometry(
      new ConeGeometry(span * SHAFT_TOP_RADIUS_FRACTION, shaftHeight, 12, 1, true),
    ),
    shaftMaterial,
  );
  shaft.rotation.x = Math.PI;
  shaft.position.y = hoverY + shaftHeight / 2;
  root.add(shaft);

  const bobAmplitude = span * BOB_AMPLITUDE_FRACTION;

  const auroraWarm = new Color(HALO_COLOR);
  const auroraCool = new Color(AURORA_COOL_COLOR);
  const auroraShaftWarm = new Color(SHAFT_COLOR);
  const scratch = new Color();

  return {
    root,

    animate(seconds: number): void {
      stone.position.y = hoverY + Math.sin(seconds * BOB_HZ * TWO_PI) * bobAmplitude;
      core.rotation.y = seconds * STONE_SPIN_TURNS_PER_SECOND * TWO_PI;
      halo.rotation.y = seconds * HALO_SPIN_TURNS_PER_SECOND * TWO_PI;
      bloom.rotation.y = -halo.rotation.y;

      outerSpin.rotation.y = seconds * OUTER_RING_TURNS_PER_SECOND * TWO_PI;
      innerSpin.rotation.y = seconds * INNER_RING_TURNS_PER_SECOND * TWO_PI;

      const breath = Math.sin(seconds * BREATH_HZ * TWO_PI);
      halo.scale.setScalar(HALO_SCALE + breath * HALO_BREATH);
      bloom.scale.setScalar(BLOOM_SCALE + breath * HALO_BREATH);
      shaftMaterial.opacity = SHAFT_OPACITY_BASE + breath * SHAFT_OPACITY_SWING;

      const drift = (Math.sin(seconds * AURORA_HZ * TWO_PI) + 1) / 2;
      haloMaterial.color.copy(scratch.lerpColors(auroraWarm, auroraCool, drift));
      bloomMaterial.color.copy(haloMaterial.color);
      shaftMaterial.color.copy(
        scratch.lerpColors(auroraShaftWarm, auroraCool, drift),
      );
    },

    dispose(): void {
      root.clear();
      for (const geometry of geometries) geometry.dispose();
      for (const material of materials) material.dispose();
    },
  };
}
