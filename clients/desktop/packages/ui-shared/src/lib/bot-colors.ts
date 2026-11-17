import type { BotColor } from '@canopy/protocol/bot-glyph';
import type { SidebarItemGroupColor } from '@canopy/protocol/sidebar';

/** Resolved semantic tokens of the surface hosting the glyph. Hex sRGB only. */
export interface BotColorTheme {
  readonly surface: string;
  /** Other semantic surfaces on which the bare identity ink may appear. */
  readonly backdrops?: readonly string[];
  readonly neutral: string;
  readonly palette: Readonly<Record<SidebarItemGroupColor, string>>;
}

export interface BotColors {
  readonly ink: string;
  readonly tile: string;
  readonly bubble: string;
  readonly bubbleInk: string;
  readonly swatch: string;
  readonly swatchInk: string;
  readonly adjusted: boolean;
  readonly valid: boolean;
}

type Rgb = readonly [number, number, number];
const BLACK: Rgb = [0, 0, 0];
const WHITE: Rgb = [255, 255, 255];

/** Accept user color data, never a CSS expression, alpha channel or URL. */
export function normalizeBotHex(value: string): string | null {
  const digits = /^#?([a-f\d]{3}|[a-f\d]{6})$/i.exec(value.trim())?.[1];
  if (!digits) return null;
  return `#${(digits.length === 3 ? [...digits].map((c) => c + c).join('') : digits).toLowerCase()}`;
}

function rgb(hex: string): Rgb {
  const normalized = normalizeBotHex(hex);
  if (!normalized)
    throw new Error('Bot theme colors must be resolved sRGB hex.');
  return [
    parseInt(normalized.slice(1, 3), 16),
    parseInt(normalized.slice(3, 5), 16),
    parseInt(normalized.slice(5, 7), 16),
  ];
}

function hex(color: Rgb): string {
  return `#${color.map((c) => Math.round(c).toString(16).padStart(2, '0')).join('')}`;
}

function mix(a: Rgb, b: Rgb, amount: number): Rgb {
  return [
    Math.round(a[0] + (b[0] - a[0]) * amount),
    Math.round(a[1] + (b[1] - a[1]) * amount),
    Math.round(a[2] + (b[2] - a[2]) * amount),
  ];
}

function luminance(color: Rgb): number {
  const linear = (value: number): number => {
    const c = value / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return (
    0.2126 * linear(color[0]) +
    0.7152 * linear(color[1]) +
    0.0722 * linear(color[2])
  );
}

function contrast(a: Rgb, b: Rgb): number {
  const left = luminance(a);
  const right = luminance(b);
  return (Math.max(left, right) + 0.05) / (Math.min(left, right) + 0.05);
}

/**
 * The only renderer of user-picked custom Bot colors (the bounded exception
 * in the Bot UX plan). Tint opaque semantic surface colors, then solve ink
 * against every resulting fill. Stored color data is never changed.
 */
export function deriveBotColors(
  color: BotColor,
  theme: BotColorTheme,
): BotColors {
  const normalized =
    color.kind === 'custom' ? normalizeBotHex(color.hex) : null;
  const source = rgb(
    color.kind === 'custom'
      ? (normalized ?? theme.neutral)
      : theme.palette[color.key],
  );
  const surface = rgb(theme.surface);
  const tile = mix(surface, source, 0.16);
  const bubble = mix(surface, source, 0.08);
  const backgrounds = [
    surface,
    tile,
    bubble,
    ...(theme.backdrops ?? []).map(rgb),
  ];
  const target = backgrounds.every((bg) => contrast(BLACK, bg) >= 4.5)
    ? BLACK
    : WHITE;
  let ink = source;
  // Quantized output is tested, so rounding cannot drop below the target.
  for (let step = 0; step <= 100; step += 1) {
    ink = mix(source, target, step / 100);
    if (backgrounds.every((bg) => contrast(ink, bg) >= 4.5)) break;
  }
  const swatchInk =
    contrast(BLACK, ink) >= contrast(WHITE, ink) ? BLACK : WHITE;
  return {
    ink: hex(ink),
    tile: hex(tile),
    bubble: hex(bubble),
    bubbleInk: hex(ink),
    swatch: hex(ink),
    swatchInk: hex(swatchInk),
    adjusted: hex(ink) !== hex(source),
    valid: color.kind !== 'custom' || normalized !== null,
  };
}

export interface BotColorArea {
  readonly background: string;
  readonly hueBackground: string;
  readonly left: string;
  readonly top: string;
}

export interface BotHsv {
  readonly hue: number;
  readonly saturation: number;
  readonly value: number;
}

export function botHexFromHsv({ hue, saturation, value }: BotHsv): string {
  const h = (((hue % 360) + 360) % 360) / 60;
  const c =
    Math.max(0, Math.min(1, value)) * Math.max(0, Math.min(1, saturation));
  const x = c * (1 - Math.abs((h % 2) - 1));
  const m = Math.max(0, Math.min(1, value)) - c;
  const parts: Rgb =
    h < 1
      ? [c, x, 0]
      : h < 2
        ? [x, c, 0]
        : h < 3
          ? [0, c, x]
          : h < 4
            ? [0, x, c]
            : h < 5
              ? [x, 0, c]
              : [c, 0, x];
  return hex([
    (parts[0] + m) * 255,
    (parts[1] + m) * 255,
    (parts[2] + m) * 255,
  ]);
}

export function botHsvFromHex(value: string): BotHsv {
  const [r, g, b] = rgb(normalizeBotHex(value) ?? hex(BLACK)).map(
    (c) => c / 255,
  );
  const red = r ?? 0;
  const green = g ?? 0;
  const blue = b ?? 0;
  const max = Math.max(red, green, blue);
  const min = Math.min(red, green, blue);
  const delta = max - min;
  const h =
    delta === 0
      ? 0
      : max === red
        ? ((green - blue) / delta) % 6
        : max === green
          ? (blue - red) / delta + 2
          : (red - green) / delta + 4;
  return {
    hue: (h * 60 + 360) % 360,
    saturation: max === 0 ? 0 : delta / max,
    value: max,
  };
}

/** Raw color-area paint belongs to the same user-color boundary as tints. */
export function botColorArea(hsv: BotHsv): BotColorArea {
  const hue = botHexFromHsv({ hue: hsv.hue, saturation: 1, value: 1 });
  return {
    background: `linear-gradient(to top, ${hex(BLACK)}, transparent), linear-gradient(to right, ${hex(WHITE)}, ${hue})`,
    hueBackground: `linear-gradient(to right, ${[0, 60, 120, 180, 240, 300, 360].map((h) => botHexFromHsv({ hue: h, saturation: 1, value: 1 })).join(', ')})`,
    left: `${hsv.saturation * 100}%`,
    top: `${(1 - hsv.value) * 100}%`,
  };
}
