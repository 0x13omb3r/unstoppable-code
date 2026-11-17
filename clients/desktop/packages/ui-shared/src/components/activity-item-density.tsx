'use client';

import { createContext, useContext } from 'react';

/**
 * How an activity section draws its item rows (a script, a hook, an MCP
 * server). `comfortable` is the Side Panel's bordered item card. `compact`
 * is for a section opened inside another surface, the Activity card: plain
 * rows at the card's own row height and text style, so the section reads
 * as a list under its heading instead of cards inside a card.
 */
export type ActivityItemDensity = 'comfortable' | 'compact';

export const ActivityItemDensityContext =
  createContext<ActivityItemDensity>('comfortable');

export function useActivityItemDensity(): ActivityItemDensity {
  return useContext(ActivityItemDensityContext);
}

export { COMPACT_ACTIVITY_ITEM_CLASS_NAME } from './activity-item-density-styles';
