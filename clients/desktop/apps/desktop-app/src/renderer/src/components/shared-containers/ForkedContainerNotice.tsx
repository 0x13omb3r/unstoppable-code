import { Surface } from '@canopy/ui-shared/components';
import { useRef, type JSX } from 'react';
import { ForkedFromNotice } from './ForkedFromNotice';
import {
  useForkedContainerFocus,
  type ForkedContainerFocusTarget,
} from './useForkedContainerFocus';
import { useSharedContainerForkProvenance } from './useSharedContainerForkProvenance';

/** Persistent provenance shown on an independent local fork after navigation. */
export function ForkedContainerNotice({
  projectId,
  worktreeId,
  focusTarget,
}: {
  projectId: string | null;
  worktreeId: string | null;
  /**
   * Set where a fork can land: the page this destination renders on, which
   * fork focus requests name, and its header, focused when provenance cannot
   * load. The share viewer leaves it unset.
   */
  focusTarget?: ForkedContainerFocusTarget;
}): JSX.Element | null {
  const { provenance, settled } = useSharedContainerForkProvenance(
    projectId,
    worktreeId,
  );
  const provenanceRef = useRef<HTMLParagraphElement>(null);
  useForkedContainerFocus({
    projectId,
    worktreeId,
    focusTarget: focusTarget ?? null,
    provenanceSettled: settled,
    provenanceRef,
  });
  if (provenance === null) return null;

  return (
    <Surface variant="notice-strip" className="shrink-0">
      <ForkedFromNotice provenance={provenance} focusRef={provenanceRef} />
    </Surface>
  );
}
