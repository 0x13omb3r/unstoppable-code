/**
 * `@canopy/app-state/billing/credits`: the shared AI Credits purchase state.
 *
 * Factories, not module-level stores: each host creates one instance per
 * session and injects its account, balance and hand-off ports. Browser-safe.
 */
export * from './types';
export * from './coverage';
export * from './coverage-probe';
export * from './openers';
export * from './purchase-store';
export * from './arrival-store';
export * from './unlock-intent-store';
export * from './resolve-credits-prompt';
