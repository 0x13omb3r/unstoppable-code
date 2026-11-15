/**
 * Who pays for a turn right now, from one availability read (ECW-9091).
 *
 * Every surface that offers a credits action makes this same decision, so a
 * purchase action is never shown to an organization member who cannot buy.
 * Hosts pass their own availability payload; only these fields are read.
 */
export interface CreditsAvailabilitySignal {
  /** A spendable personal balance (native, or an already-linked account). */
  readonly personalEligible: boolean;
  readonly inOrg: boolean;
  /** The organization carries the credit-pool capability. */
  readonly orgCreditPoolCovered: boolean;
  /** The organization has spendable headroom right now. */
  readonly orgSpendable: boolean;
  /** The organization that owns the work, when one does. */
  readonly ownerOrganization?: { readonly id: string };
  /** The read could not establish coverage; nothing may be offered. */
  readonly inconclusive?: boolean;
}

export interface CreditsCoverage {
  /**
   * The account can pay for a gateway-routed turn right now: a spendable
   * personal balance or an org with headroom.
   */
  readonly canSpendCredits: boolean;
  /** Show the static "contact your org admin" copy and NO purchase CTA. */
  readonly showContactAdmin: boolean;
  /** Fully uncovered — show the purchase CTA. */
  readonly showPurchase: boolean;
}

/**
 * Resolve which credits affordance (if any) a surface should offer.
 *
 * A `null` or inconclusive availability means the read has not resolved or
 * failed, so nothing is offered — asserting "you have no credits" on a failed
 * read would push a paying user at the purchase page.
 */
export function resolveCreditsCoverage(
  availability: CreditsAvailabilitySignal | null,
): CreditsCoverage {
  if (!availability || availability.inconclusive === true) {
    return {
      canSpendCredits: false,
      showContactAdmin: false,
      showPurchase: false,
    };
  }
  const canSpendCredits =
    availability.personalEligible === true ||
    availability.orgSpendable === true;
  const showContactAdmin =
    !canSpendCredits &&
    availability.inOrg === true &&
    availability.orgCreditPoolCovered === true;
  return {
    canSpendCredits,
    showContactAdmin,
    showPurchase: !canSpendCredits && !showContactAdmin,
  };
}

/**
 * Billing-owner key for an availability read: `personal` or `org:<id>`;
 * `null` when the read could not establish an owner.
 */
export function creditsBillingOwnerKey(
  availability: CreditsAvailabilitySignal | null,
): string | null {
  if (!availability || availability.inconclusive === true) return null;
  return availability.ownerOrganization
    ? `org:${availability.ownerOrganization.id.toLowerCase()}`
    : 'personal';
}
