import { useLayoutEffect, useState, type RefObject } from 'react';
import { SIDEBAR_ITEM_GROUP_COLORS } from '@canopy/protocol/sidebar';
import type { BotColorTheme } from '../../lib/bot-colors';

/** Resolve semantic colors from the owning document, including named themes. */
export function useBotColorTheme(
  ref: RefObject<HTMLElement | null>,
): BotColorTheme | null {
  const [theme, setTheme] = useState<BotColorTheme | null>(null);
  useLayoutEffect(() => {
    const element = ref.current;
    const doc = element?.ownerDocument;
    const view = doc?.defaultView;
    if (!element || !doc || !view) return;
    const canvas = doc.createElement('canvas');
    canvas.width = 1;
    canvas.height = 1;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) return;
    const probe = doc.createElement('span');
    probe.hidden = true;
    element.append(probe);
    const read = (token: string): string => {
      probe.style.color = `var(--${token})`;
      context.clearRect(0, 0, 1, 1);
      context.fillStyle = view.getComputedStyle(probe).color;
      context.fillRect(0, 0, 1, 1);
      const channels = context.getImageData(0, 0, 1, 1).data;
      return `#${Array.from(channels)
        .slice(0, 3)
        .map((c) => c.toString(16).padStart(2, '0'))
        .join('')}`;
    };
    const measure = (): void => {
      const neutral = read('fg-secondary');
      const palette = {
        neutral,
        'categorical-1': neutral,
        'categorical-2': neutral,
        'categorical-3': neutral,
        'categorical-4': neutral,
        'categorical-5': neutral,
        'categorical-6': neutral,
      };
      for (const key of SIDEBAR_ITEM_GROUP_COLORS)
        palette[key] = read(key === 'neutral' ? 'fg-secondary' : key);
      setTheme({
        surface: read('bg-secondary'),
        backdrops: [read('bg-base'), read('bg-quaternary')],
        neutral,
        palette,
      });
    };
    measure();
    const observer = new view.MutationObserver(measure);
    // Theme providers can scope tokens to a subtree, not only <html>.
    let ancestor: HTMLElement | null = element;
    while (ancestor) {
      observer.observe(ancestor, {
        attributes: true,
        attributeFilter: [
          'class',
          'style',
          'data-theme',
          'data-brand',
          'data-color-mode',
        ],
      });
      ancestor = ancestor.parentElement;
    }
    const scheme = view.matchMedia('(prefers-color-scheme: dark)');
    scheme.addEventListener('change', measure);
    return (): void => {
      observer.disconnect();
      scheme.removeEventListener('change', measure);
      probe.remove();
    };
  }, [ref]);
  return theme;
}
