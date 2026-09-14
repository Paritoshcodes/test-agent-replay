export const clamp = (v: number, lo = 0, hi = 1): number => (v < lo ? lo : v > hi ? hi : v);

export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

export const smoothstep = (e0: number, e1: number, x: number): number => {
  const t = clamp((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
};

export const smootherstep = (t: number): number => {
  const x = clamp(t);
  return x * x * x * (x * (x * 6 - 15) + 10);
};

export const easeOutCubic = (t: number): number => 1 - Math.pow(1 - clamp(t), 3);
export const easeInCubic = (t: number): number => Math.pow(clamp(t), 3);
export const easeInOutCubic = (t: number): number => {
  const x = clamp(t);
  return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
};
export const easeOutBack = (t: number, s = 2.2): number => {
  const x = clamp(t) - 1;
  return x * x * ((s + 1) * x + s) + 1;
};

/** Frame-rate independent exponential approach: fraction of the remaining distance covered in dt. */
export const damp = (rate: number, dt: number): number => 1 - Math.exp(-rate * dt);

/**
 * One damped-spring integration step (semi-implicit Euler, sub-stepped so a dropped frame does not
 * explode a stiff spring). Returns [value, velocity].
 */
export function springStep(x: number, v: number, target: number, stiffness: number, damping: number, dt: number): [number, number] {
  const sub = Math.max(1, Math.ceil(dt / (1 / 240)));
  const h = dt / sub;
  for (let i = 0; i < sub; i++) {
    const a = -stiffness * (x - target) - damping * v;
    v += a * h;
    x += v * h;
  }
  return [x, v];
}

/** Rubber-band resistance past an edge, the iOS-style curve: grows ever slower the further you pull. */
export const rubber = (overshoot: number, dimension: number, c = 0.55): number =>
  (1 - 1 / ((Math.abs(overshoot) * c) / dimension + 1)) * dimension * Math.sign(overshoot);

/** Cheap deterministic hash noise in [-1, 1] for shake and grain-like jitter. */
export const hashNoise = (n: number): number => {
  const s = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return (s - Math.floor(s)) * 2 - 1;
};
