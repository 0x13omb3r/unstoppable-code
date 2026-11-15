'use client';

import type { JSX } from 'react';
import { Notice } from './Notice';

export interface ModelSelectionFailure {
  message: string;
  /** A terminal desktop answer, not proof that no write occurred. */
  reported: boolean;
}

export function ModelSelectionNotice({
  failure,
}: {
  failure: ModelSelectionFailure | undefined;
}): JSX.Element | null {
  if (!failure) return null;
  return (
    <Notice
      data-testid="model-selection-failure"
      intent="attention"
      title={
        failure.reported ? 'Model change failed' : 'Model change not confirmed'
      }
    >
      {failure.message}
    </Notice>
  );
}
