'use client';

import type { JSX, ReactNode } from 'react';
import type {
  ProviderChoiceModel,
  ProviderChoiceRow,
  ProviderSourceId,
} from '@canopy/app-state/provider-choice';
import {
  AI_CREDITS_REOPEN_BILLING_LABEL,
  Button,
  PROVIDER_CHOICE_ACTION_LABELS,
  PROVIDER_CHOICE_ROW_COPY,
  SettingsRowsGroup,
  type ProviderStatusDotTone,
} from '@canopy/ui-shared/components';
import { ProviderSourceRow } from './ProviderSourceRow';

/** How a host names and marks one source. */
export interface ProviderChoicePresentation {
  readonly icon?: ReactNode;
  /**
   * The row's name. The credits row carries the host's brand app name; a
   * user-named source (a gateway) wraps its name in the replay mask.
   */
  readonly name: ReactNode;
  /** The signed-in account, or what the source is, under the name. */
  readonly description?: ReactNode;
}

export type ProviderChoicePresentations = Readonly<
  Partial<Record<ProviderSourceId, ProviderChoicePresentation>>
>;

export interface ProviderChoiceListProps<TModel extends ProviderChoiceModel> {
  readonly rows: readonly ProviderChoiceRow<TModel>[];
  readonly presentation: ProviderChoicePresentations;
  /**
   * The row's trailing control. Hosts own sign-in and purchase mechanics;
   * return {@link ProviderChoiceActionButton} where the action is a plain
   * button, or `null` for none.
   */
  readonly renderAction: (row: ProviderChoiceRow<TModel>) => ReactNode;
  /** Formats a reset time for "Limit reached, resets at …". */
  readonly formatResetsAt?: (resetsAt: number) => string;
  /** Under the rows, outside the group. */
  readonly footer?: ReactNode;
  readonly ariaLabel?: string;
  readonly dataTestId?: string;
  /** The model a `run-model` list is for, for "Doesn't offer {model}". */
  readonly modelNotOfferedLabel?: string;
}

function statusTone(
  row: ProviderChoiceRow<ProviderChoiceModel>,
): ProviderStatusDotTone {
  switch (row.connection.kind) {
    case 'ready':
      return 'connected';
    case 'limited':
      return 'limited';
    case 'checking':
      return 'pending';
    case 'not-connected':
      return 'signed-out';
  }
}

type RowDetail = {
  readonly kind: 'ready' | 'plain';
  readonly text: string;
};

function plainDetail(text: string): RowDetail {
  return { kind: 'plain', text };
}

/** The line for a row whose source can't take the chat now. */
function unavailableDetail<TModel extends ProviderChoiceModel>(
  row: ProviderChoiceRow<TModel>,
  outcome: Extract<
    ProviderChoiceRow<TModel>['outcome'],
    { kind: 'unavailable' }
  >,
  limited: (resetsAt: number | null | undefined) => string,
): RowDetail | undefined {
  switch (outcome.reason) {
    case 'desktop-only':
      return plainDetail(PROVIDER_CHOICE_ROW_COPY.desktopOnly);
    case 'cross-harness':
      return plainDetail(PROVIDER_CHOICE_ROW_COPY.crossHarness);
    case 'policy':
      return plainDetail(PROVIDER_CHOICE_ROW_COPY.policy);
    case 'limited':
      return plainDetail(limited(outcome.resetsAt));
    case 'blocked':
      return outcome.detail !== undefined
        ? plainDetail(outcome.detail)
        : undefined;
    case 'no-runnable-model': {
      // Not set up yet: its models are unknown until it is, so the row's
      // Set up or Connect says what to do instead.
      const settingUp = row.action === 'set-up' || row.action === 'connect';
      return settingUp
        ? undefined
        : plainDetail(PROVIDER_CHOICE_ROW_COPY.noRunnableModel);
    }
    case 'model-not-offered':
      return undefined;
  }
}

/** The row's one line under its description, from its outcome and action. */
export function providerChoiceRowDetail<TModel extends ProviderChoiceModel>(
  row: ProviderChoiceRow<TModel>,
  formatResetsAt?: (resetsAt: number) => string,
): RowDetail | undefined {
  const limited = (resetsAt: number | null | undefined): string =>
    PROVIDER_CHOICE_ROW_COPY.limited(
      resetsAt != null && formatResetsAt !== undefined
        ? formatResetsAt(resetsAt)
        : undefined,
    );
  if (row.isCurrent && row.connection.kind === 'limited') {
    return plainDetail(limited(row.connection.resetsAt));
  }
  if (row.action === 'ask-admin') {
    return plainDetail(PROVIDER_CHOICE_ROW_COPY.askAdmin);
  }
  const { outcome } = row;
  switch (outcome.kind) {
    case 'switch-model':
      return plainDetail(
        PROVIDER_CHOICE_ROW_COPY.continuesOn(outcome.target.label),
      );
    case 'same-model':
      // The current row says so with its badge, not a line.
      if (row.isCurrent) return undefined;
      if (row.connection.kind === 'checking') {
        return plainDetail(PROVIDER_CHOICE_ROW_COPY.checking);
      }
      return row.action === 'use'
        ? { kind: 'ready', text: PROVIDER_CHOICE_ROW_COPY.ready }
        : undefined;
    case 'unavailable':
      return unavailableDetail(row, outcome, limited);
  }
}

/**
 * The provider-choice rows, from `resolveProviderChoices`. The same list on
 * every host: the recovery dialog, locked-model picks and (through
 * {@link ProviderSourceRow}) first run. Nothing here branches on the host;
 * unsupported rows come from the facts the host passed the resolver.
 */
export function ProviderChoiceList<TModel extends ProviderChoiceModel>({
  rows,
  presentation,
  renderAction,
  formatResetsAt,
  footer,
  ariaLabel,
  dataTestId,
  modelNotOfferedLabel,
}: ProviderChoiceListProps<TModel>): JSX.Element {
  return (
    <div className="flex flex-col gap-3">
      <SettingsRowsGroup
        surface="plain"
        {...(ariaLabel !== undefined ? { ariaLabel } : {})}
        {...(dataTestId !== undefined ? { dataTestId } : {})}
      >
        {rows.map((row) => {
          const shown = presentation[row.source];
          const detail =
            row.outcome.kind === 'unavailable' &&
            row.outcome.reason === 'model-not-offered' &&
            modelNotOfferedLabel !== undefined
              ? {
                  kind: 'plain' as const,
                  text: PROVIDER_CHOICE_ROW_COPY.modelNotOffered(
                    modelNotOfferedLabel,
                  ),
                }
              : providerChoiceRowDetail(row, formatResetsAt);
          return (
            <ProviderSourceRow
              key={row.source}
              icon={shown?.icon}
              name={shown?.name ?? row.source}
              status={statusTone(row)}
              {...(row.isCurrent
                ? { badge: PROVIDER_CHOICE_ROW_COPY.current }
                : {})}
              description={shown?.description}
              {...(detail !== undefined
                ? {
                    detail: {
                      ...detail,
                      testId: `provider-choice-detail-${row.source}`,
                    },
                  }
                : {})}
              control={renderAction(row)}
              dataTestId={`provider-choice-row-${row.source}`}
            />
          );
        })}
      </SettingsRowsGroup>
      {footer}
    </div>
  );
}

export interface CreditsRowPendingActionProps {
  readonly row: ProviderChoiceRow<ProviderChoiceModel>;
  /** The notice's tracked hand-off's Reopen billing, once it reports. */
  readonly onReopenBilling?: () => void;
  readonly reopenPending?: boolean;
  readonly onCheckAgain?: () => void;
  readonly checking?: boolean;
}

/**
 * The credits row's control while a purchase from the list is pending. The
 * notice already shows Check again, so the row offers Reopen billing, the
 * way back to a closed checkout tab. After a failed check the rule is to
 * retry with Check again, never Reopen billing, so the row offers that.
 */
export function CreditsRowPendingAction({
  row,
  onReopenBilling,
  reopenPending = false,
  onCheckAgain,
  checking = false,
}: CreditsRowPendingActionProps): JSX.Element {
  if (row.creditsPrompt?.secondary === 'reopen-billing') {
    return (
      <Button
        variant="secondary"
        size="sm"
        onClick={(): void => onReopenBilling?.()}
        aria-busy={reopenPending || undefined}
        disabled={onReopenBilling === undefined || reopenPending}
        data-testid={`provider-choice-action-${row.source}`}
      >
        {AI_CREDITS_REOPEN_BILLING_LABEL}
      </Button>
    );
  }
  return (
    <Button
      variant="secondary"
      size="sm"
      onClick={(): void => onCheckAgain?.()}
      aria-busy={checking || undefined}
      disabled={onCheckAgain === undefined || checking}
      data-testid={`provider-choice-action-${row.source}`}
    >
      {PROVIDER_CHOICE_ACTION_LABELS['check-again']}
    </Button>
  );
}

export interface ProviderChoiceActionButtonProps {
  readonly source: ProviderSourceId;
  readonly action: ProviderChoiceRow<ProviderChoiceModel>['action'];
  readonly onClick: () => void;
  readonly busy?: boolean;
  readonly disabled?: boolean;
}

/**
 * A row action that is a plain button, labelled from its action. Renders
 * nothing for `none` and `ask-admin` (the admin line is the row's detail).
 */
export function ProviderChoiceActionButton({
  source,
  action,
  onClick,
  busy = false,
  disabled = false,
}: ProviderChoiceActionButtonProps): JSX.Element | null {
  if (action === 'none' || action === 'ask-admin') return null;
  return (
    <Button
      variant={action === 'use' ? 'primary' : 'secondary'}
      size="sm"
      onClick={onClick}
      aria-busy={busy || undefined}
      disabled={disabled || busy}
      data-testid={`provider-choice-action-${source}`}
    >
      {PROVIDER_CHOICE_ACTION_LABELS[action]}
    </Button>
  );
}
