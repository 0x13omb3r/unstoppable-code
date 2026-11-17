'use client';

import type { JSX, ReactNode, RefObject } from 'react';
import type {
  ProviderChoiceModel,
  ProviderChoiceRow,
  ProviderChoiceTarget,
} from '@canopy/app-state/provider-choice';
import {
  DialogModal,
  ErrorBanner,
  switchProviderDialogTitle,
} from '@canopy/ui-shared/components';
import {
  ProviderChoiceList,
  type ProviderChoicePresentations,
} from './ProviderChoiceList';

export interface SwitchProviderDialogProps<TModel extends ProviderChoiceModel> {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly rows: readonly ProviderChoiceRow<TModel>[];
  readonly target: ProviderChoiceTarget<TModel>;
  readonly presentation: ProviderChoicePresentations;
  readonly renderAction: (row: ProviderChoiceRow<TModel>) => ReactNode;
  readonly formatResetsAt?: (resetsAt: number) => string;
  /** The last row action's failure, shown under the rows. */
  readonly error?: string | null;
  /** The control that opened the dialog; focus returns to it on close. */
  readonly restoreFocusRef?: RefObject<HTMLElement | null>;
  readonly footer?: ReactNode;
  readonly dataTestId?: string;
}

/**
 * The provider list as a dialog: what a recovery notice's Switch provider
 * (or Choose provider) and a locked-model pick open. Primary actions only, so
 * it has no footer; the X or the backdrop dismisses it
 * (docs/design/overlays.md). Hosts close it before opening anything a row
 * starts (a sign-in, a switch dialog, a checkout), so two modals never stack.
 */
export function SwitchProviderDialog<TModel extends ProviderChoiceModel>({
  open,
  onClose,
  rows,
  target,
  presentation,
  renderAction,
  formatResetsAt,
  error = null,
  restoreFocusRef,
  footer,
  dataTestId = 'switch-provider-dialog',
}: SwitchProviderDialogProps<TModel>): JSX.Element | null {
  if (!open) return null;
  const modelLabel =
    target.kind === 'run-model' ? target.model.label : undefined;
  return (
    <DialogModal
      title={switchProviderDialogTitle(modelLabel)}
      onClose={onClose}
      maxWidth="md"
      dataTestId={dataTestId}
      {...(restoreFocusRef !== undefined ? { restoreFocusRef } : {})}
    >
      <div className="flex flex-col gap-3">
        <ProviderChoiceList
          rows={rows}
          presentation={presentation}
          renderAction={renderAction}
          {...(formatResetsAt !== undefined ? { formatResetsAt } : {})}
          {...(modelLabel !== undefined
            ? { modelNotOfferedLabel: modelLabel }
            : {})}
          {...(footer !== undefined ? { footer } : {})}
          dataTestId="provider-choice-list"
        />
        <ErrorBanner
          error={error}
          errorSource="switch-provider-dialog"
          className=""
          testId={`${dataTestId}-error`}
        />
      </div>
    </DialogModal>
  );
}
