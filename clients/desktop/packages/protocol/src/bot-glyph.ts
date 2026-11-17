import type { SidebarItemGroupColor } from './sidebar/sidebar-item-groups';

/** User-picked identity color, never a host path or a CSS expression. */
export type BotColor =
  | { readonly kind: 'theme'; readonly key: SidebarItemGroupColor }
  | { readonly kind: 'custom'; readonly hex: string };

/** Portable Bot identity; emoji color still tints its bubbles and marks. */
export type BotGlyph =
  | { readonly kind: 'default' }
  | { readonly kind: 'icon'; readonly name: string; readonly color: BotColor }
  | {
      readonly kind: 'emoji';
      readonly emoji: string;
      readonly color: BotColor;
    };
