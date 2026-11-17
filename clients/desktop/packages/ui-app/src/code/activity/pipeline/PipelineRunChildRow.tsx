'use client';

import type { JSX, ReactNode } from 'react';
import { Tooltip } from '@canopy/ui-shared';
import { MaximizeIcon as AppCatalogMaximizeIcon } from '@canopy/ui-shared/icons/AppIcons';
import { Button, Disclosure } from '@canopy/ui-shared/components';

export interface PipelineRunChildRowProps {
  /** The `run-pipeline` step that started the child. */
  readonly stepId: string;
  /** The child workflow's name. */
  readonly label: string;
  /** The child run's status, beside its name while the row is closed. */
  readonly status?: ReactNode;
  readonly expanded: boolean;
  readonly onToggle: () => void;
  /** The child run, drawn under the row while it is open. */
  readonly children: ReactNode;
  /** Opens the child run in a full view of its own. */
  readonly onOpen?: () => void;
}

/**
 * A `run-pipeline` step's child run under its step (CAN-6868): a disclosure
 * labelled with the child workflow's name that opens the child run under
 * both, with an action at the end of its row that opens the child in a full
 * view. Shared by desktop's run detail and the cloud run detail.
 */
export function PipelineRunChildRow({
  stepId,
  label,
  status,
  expanded,
  onToggle,
  children,
  onOpen,
}: PipelineRunChildRowProps): JSX.Element {
  // The drill-in action sits at the end of the toggle's row, centred on it,
  // while the child run opens full width under both.
  return (
    <div className="relative">
      <Disclosure
        open={expanded}
        onOpenChange={onToggle}
        label={label}
        {...(status !== undefined && { hint: status })}
        dataTestId={`pipeline-step-child-${stepId}`}
      >
        {children}
      </Disclosure>
      {onOpen !== undefined && (
        <div className="absolute -top-1 right-0">
          <Tooltip label="Open in full view">
            <Button
              variant="ghost"
              size="compact"
              iconOnly
              onClick={onOpen}
              aria-label={`Open ${label} in full view`}
              data-testid={`pipeline-step-drill-${stepId}`}
            >
              <AppCatalogMaximizeIcon size="sm" aria-hidden="true" />
            </Button>
          </Tooltip>
        </div>
      )}
    </div>
  );
}
