/**
 * Canvas-side color tokens. styles/global.css declares the same values as CSS variables; keep them in step.
 *
 * Monochrome instrument. White is the recording, blue the live replay, red is used only for the tear,
 * amber only for "informational". Everything else is a step on one neutral ramp.
 */
export type RGB = readonly [number, number, number];

const hex = (h: string): RGB => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];

export const P = {
  bg: hex("#0a0a0a"),
  fg: hex("#ededed"),
  gray9: hex("#a1a1a1"),
  gray7: hex("#707070"),
  gray5: hex("#4d4d4d"),
  gray4: hex("#3a3a3a"),
  gray3: hex("#262626"),
  blue: hex("#47a8ff"),
  blueHi: hex("#b5dcff"),
  red: hex("#ff6166"),
  amber: hex("#f5a524"),
  green: hex("#3fcf8e"),
} as const;

export const rgba = (c: RGB, a: number): string => `rgba(${c[0]},${c[1]},${c[2]},${a < 0 ? 0 : a > 1 ? 1 : a.toFixed(3)})`;
