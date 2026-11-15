'use client';

import type { JSX, ReactNode } from 'react';
import { Stack, ProgressBar } from '@canopy/ui-shared/components';
import { formatMonthDay, formatUsd } from '@canopy/ui-shared/lib';
import {
  AI_CREDIT_AUTO_TOP_UP_DEFAULT_AMOUNT_USD,
  AI_CREDIT_AUTO_TOP_UP_DEFAULT_THRESHOLD_CREDITS,
} from '@canopy/protocol/settings/auto-top-up-defaults';
import type { SettingsPaymentOwner } from '@canopy/protocol/billing';
import type {
  CreditsAutoTopUpSettings,
  CreditsSummary,
} from '@canopy/protocol/settings/billing';
import { BillingTogglePanel } from './billing-toggle-panel';
import { useBillingSettingsSlots } from './billing-settings-slots';
import { PaymentAreaCta, usePaymentAreaMode } from './PaymentArea';

/**
 * The automatic top-up panel of the AI Credits wallet and pool cards: the
 * switch, the month-to-date spend meter and the "Buys $X when your balance
 * drops below N credits" summary. {@link AutoTopUpSummary} is the one panel;
 * the web editor (`AutoTopUpControls`) renders it with a live switch, its
 * "Adjust" button and dialog, and hosts without inline checkout render it
 * read-only with a handoff CTA. {@link WalletAutoTopUp} picks between them.
 */

/** The master switch's sentence, shared by the editor and the summary. */
export function autoTopUpToggleSentence(
  brandName: string,
  orgVariant: boolean,
): string {
  return orgVariant
    ? `Automatically buy AI Credits to keep your team using ${brandName} when you run low.`
    : `Automatically buy AI Credits to keep using ${brandName} when you run low.`;
}

/** The effective per-refill amount and trigger, defaulted from the catalog. */
export function autoTopUpEffectiveTuning(settings: CreditsAutoTopUpSettings): {
  amountUsd: number;
  thresholdCredits: number;
} {
  return {
    amountUsd: settings.amountUsd ?? AI_CREDIT_AUTO_TOP_UP_DEFAULT_AMOUNT_USD,
    thresholdCredits:
      settings.thresholdCredits ??
      AI_CREDIT_AUTO_TOP_UP_DEFAULT_THRESHOLD_CREDITS,
  };
}

export interface AutoTopUpSettingsDetailsProps {
  readonly settings: CreditsAutoTopUpSettings;
  /** Month-to-date auto-top-up spend, for the meter. */
  readonly monthlySpentUsd: number;
  /** Human-readable reset label (start of next month, e.g. "Aug 1"). */
  readonly monthlyResetAt: string;
  /** Prefix for test ids — `''` (account) or `'team-'` (org). */
  readonly testIdPrefix?: string;
  /** The control beside the summary ("Adjust" on web), when any. */
  readonly action?: ReactNode;
}

/** The meter and summary shown while automatic top-up is on. */
export function AutoTopUpSettingsDetails({
  settings,
  monthlySpentUsd,
  monthlyResetAt,
  testIdPrefix = '',
  action,
}: AutoTopUpSettingsDetailsProps): JSX.Element {
  const tid = (suffix: string): string => `${testIdPrefix}${suffix}`;
  const cap = settings.maxMonthlyUsd;
  const { amountUsd, thresholdCredits } = autoTopUpEffectiveTuning(settings);
  const pct =
    cap !== null && cap > 0
      ? Math.min(100, Math.round((monthlySpentUsd / cap) * 100))
      : 0;

  return (
    <>
      {/* Month-to-date spend meter */}
      <Stack
        gap="tight"
        className="mt-4"
        data-testid={tid('credits-auto-top-up-meter')}
      >
        <div className="flex items-center justify-between text-xs fg-secondary">
          <span>
            {formatUsd(monthlySpentUsd)} spent
            <span className="mx-1">·</span>
            Resets {monthlyResetAt}
          </span>
          {cap !== null ? (
            <span>{pct}% used</span>
          ) : (
            <span>No monthly limit</span>
          )}
        </div>
        {cap !== null ? (
          <ProgressBar
            value={pct}
            label="Month-to-date auto top-up spend"
            hideLabel
          />
        ) : null}
      </Stack>

      {/* Current settings summary + adjust */}
      <div className="mt-4 flex items-center justify-between gap-3">
        <p
          className="min-w-0 text-s fg-secondary"
          data-testid={tid('credits-auto-top-up-summary')}
        >
          Buys{' '}
          <span className="font-medium fg-primary">{formatUsd(amountUsd)}</span>{' '}
          when your balance drops below{' '}
          <span className="font-medium fg-primary">
            {thresholdCredits} credits
          </span>
          {cap !== null ? (
            <>
              , up to{' '}
              <span className="font-medium fg-primary">{formatUsd(cap)}</span>
              /month.
            </>
          ) : (
            ', with no monthly limit.'
          )}
        </p>
        {action ?? null}
      </div>
    </>
  );
}

/** The switch, when the viewer can change it in place (the web editor). */
export interface AutoTopUpToggle {
  readonly disabled: boolean;
  readonly onToggle: () => void;
  readonly error: string | null;
}

export interface AutoTopUpSummaryProps {
  readonly settings: CreditsAutoTopUpSettings;
  readonly monthlySpentUsd: number;
  readonly monthlyResetAt: string;
  readonly brandName: string;
  readonly orgVariant?: boolean;
  readonly testIdPrefix?: string;
  /**
   * The control beside the summary: "Adjust" on the web, the handoff CTA
   * elsewhere. Shown under the switch while automatic top-up is off.
   */
  readonly action?: ReactNode;
  /** A live switch. Omitted, the switch shows the saved state, disabled. */
  readonly toggle?: AutoTopUpToggle;
  /** Optional "Learn more" destination. */
  readonly learnMoreHref?: string;
  /** The editor's dialogs, after the panel's content. */
  readonly children?: ReactNode;
}

/**
 * The automatic top-up panel. Without `toggle` the switch reflects the saved
 * state and cannot be changed here; changes happen on the web.
 */
export function AutoTopUpSummary({
  settings,
  monthlySpentUsd,
  monthlyResetAt,
  brandName,
  orgVariant = false,
  testIdPrefix = '',
  action,
  toggle,
  learnMoreHref,
  children,
}: AutoTopUpSummaryProps): JSX.Element {
  const tid = (suffix: string): string => `${testIdPrefix}${suffix}`;
  return (
    <BillingTogglePanel
      testId={tid('credits-auto-top-up')}
      toggleTestId={tid('credits-auto-top-up-toggle')}
      title="Automatic top-up"
      description={autoTopUpToggleSentence(brandName, orgVariant)}
      learnMoreHref={learnMoreHref}
      checked={settings.enabled}
      ariaLabel="Toggle automatic credit top-up"
      disabled={toggle?.disabled ?? true}
      onToggle={toggle?.onToggle ?? (() => undefined)}
      error={toggle?.error ?? null}
    >
      {settings.enabled ? (
        <AutoTopUpSettingsDetails
          settings={settings}
          monthlySpentUsd={monthlySpentUsd}
          monthlyResetAt={monthlyResetAt}
          testIdPrefix={testIdPrefix}
          action={action}
        />
      ) : action ? (
        <div className="mt-4 flex justify-end">{action}</div>
      ) : null}
      {children}
    </BillingTogglePanel>
  );
}

export interface WalletAutoTopUpProps {
  readonly owner: SettingsPaymentOwner;
  readonly summary: CreditsSummary;
  /** Whether the viewer may change the settings (personal: always; org: OWNER). */
  readonly canManage: boolean;
  /** Refresh after a saved change. */
  readonly onSaved: () => Promise<void>;
  readonly brandName: string;
  readonly orgVariant?: boolean;
  /** `''` for the personal wallet, `'team-'` for an organization pool. */
  readonly testIdPrefix?: '' | 'team-';
  /** Opens the "Adjust" editor once per new request id. */
  readonly openAdjustRequestId: string | null;
}

/**
 * A wallet card's automatic top-up: the host's editor where it checks out
 * inline (the billing slots), otherwise the read-only panel with the handoff
 * CTA for viewers who may manage it, and nothing on an inline host that
 * mounts no editor.
 */
export function WalletAutoTopUp({
  owner,
  summary,
  canManage,
  onSaved,
  brandName,
  orgVariant,
  testIdPrefix,
  openAdjustRequestId,
}: WalletAutoTopUpProps): JSX.Element | null {
  const slots = useBillingSettingsSlots();
  const handoff = usePaymentAreaMode().kind === 'handoff';
  const monthlyResetAt = formatMonthDay(summary.monthlyResetAt, {
    timeZone: 'UTC',
  });
  if (slots !== null) {
    return (
      <slots.AutoTopUpControls
        owner={owner}
        settings={summary.autoTopUp}
        monthlySpentUsd={summary.monthlySpentUsd}
        monthlyResetAt={monthlyResetAt}
        canManage={canManage}
        onSaved={onSaved}
        brandName={brandName}
        orgVariant={orgVariant}
        testIdPrefix={testIdPrefix}
        openAdjustRequestId={openAdjustRequestId}
      />
    );
  }
  if (!handoff) return null;
  return (
    <AutoTopUpSummary
      settings={summary.autoTopUp}
      monthlySpentUsd={summary.monthlySpentUsd}
      monthlyResetAt={monthlyResetAt}
      brandName={brandName}
      orgVariant={orgVariant}
      testIdPrefix={testIdPrefix}
      action={
        canManage ? (
          <PaymentAreaCta
            action="auto-top-up"
            testId={`${testIdPrefix ?? ''}billing-manage-auto-top-up`}
          />
        ) : null
      }
    />
  );
}
