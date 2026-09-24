export const BIRD_BODY_LENGTH = 0.6;

export const BIRD_BODY_WIDTH = 0.18;

export const BIRD_TAIL_RADIUS = 0.13;

export const BIRD_TAIL_LENGTH = 0.26;

export const BIRD_TAIL_X = -0.38;

export const BIRD_ENVELOPE = {
  length: BIRD_BODY_LENGTH / 2 - BIRD_TAIL_X + BIRD_TAIL_LENGTH / 2,
  crownY: 0.09,
  bellyY: -0.09,
} as const;
