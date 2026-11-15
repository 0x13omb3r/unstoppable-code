'use client';

import type { JSX } from 'react';
import { BillingSection } from './account-billing-section';

/**
 * `/account/billing`: the AI credits wallet, payment method summary and
 * billing history. Web mounts its inline financial UI around this page through
 * the billing slots; hosts without inline checkout get the payment handoff
 * CTAs instead. The page data's tier-era fields are compat values for shipped
 * builds and are not read here.
 */
export function AccountBillingPage(): JSX.Element {
  return <BillingSection />;
}
