'use client';

import { useRef, type JSX } from 'react';
import type { BotGlyph as BotGlyphValue } from '@canopy/protocol/bot-glyph';
import { AppAdvisorIcon, Bot } from '../../icons/AppIcons';
import type { IconSize } from '../../icons/icon-size';
import { deriveBotColors } from '../../lib/bot-colors';
import { BOT_ICON_OPTIONS } from './bot-icons';
import { useBotColorTheme } from './useBotColorTheme';

export type BotGlyphSize = 'xs' | 'sm' | 'md' | 'lg';
export interface BotGlyphProps {
  readonly value: BotGlyphValue;
  readonly size?: BotGlyphSize;
  /** Omit beside a visible Bot name; decorative by default. */
  readonly label?: string;
}
const BOX = {
  xs: 'h-4 w-4 rounded',
  sm: 'h-5 w-5 rounded-md',
  md: 'h-8 w-8 rounded-lg',
  lg: 'h-12 w-12 rounded-xl',
} as const;
// The DESIGN.md scale takes precedence over the mock's off-scale 11/13/26px.
const ICON: Readonly<Record<BotGlyphSize, IconSize>> = {
  xs: 'xs',
  sm: 'xs',
  md: 'lg',
  lg: '2xl',
};
const EMOJI = {
  xs: 'text-xs',
  sm: 'text-s',
  md: 'text-lg',
  lg: 'text-2xl',
} as const;

/** User identity exception: an emoji is content, never a control/status icon. */
export function BotGlyph({
  value,
  size = 'sm',
  label,
}: BotGlyphProps): JSX.Element {
  const ref = useRef<HTMLSpanElement>(null);
  const theme = useBotColorTheme(ref);
  const colors =
    value.kind !== 'default' && theme
      ? deriveBotColors(value.color, theme)
      : null;
  const Glyph =
    value.kind === 'default'
      ? AppAdvisorIcon
      : value.kind === 'icon'
        ? (BOT_ICON_OPTIONS.find((option) => option.name === value.name)
            ?.icon ?? Bot)
        : null;
  return (
    <span
      ref={ref}
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      className={`inline-flex shrink-0 select-none items-center justify-center bg-muted fg-secondary leading-none ${BOX[size]}`}
      style={
        colors && value.kind === 'icon'
          ? { color: colors.ink, backgroundColor: colors.tile }
          : undefined
      }
    >
      {Glyph ? (
        <Glyph size={ICON[size]} aria-hidden="true" />
      ) : value.kind === 'emoji' ? (
        <span className={EMOJI[size]}>{value.emoji}</span>
      ) : null}
    </span>
  );
}
