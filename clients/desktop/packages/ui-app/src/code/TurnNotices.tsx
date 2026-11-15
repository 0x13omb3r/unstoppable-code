import type { JSX } from 'react';
import { Notice } from '@canopy/ui-shared/components';
import { REPLAY_BLOCK_CLASS } from '@canopy/ui-shared/lib/replay-privacy';

/**
 * A host's note on one turn (CAN-6176): the turn used the last published
 * copy of a skill because its republish failed or timed out. Only a host
 * that keeps its own skills in step keeps these.
 */
export interface ChatTurnNotice {
  readonly kind: 'capability_copy_stale';
  readonly name: string;
}

/** The notes under one turn; nothing when it has none. */
export function TurnNotices({
  notices,
}: {
  readonly notices: readonly ChatTurnNotice[] | undefined;
}): JSX.Element | null {
  if (!notices || notices.length === 0) return null;
  return (
    <div className="flex flex-col gap-1" data-testid="chat-turn-notices">
      {notices.map((notice) => (
        <Notice
          key={`${notice.kind}:${notice.name}`}
          intent="neutral"
          icon={null}
        >
          <span className={REPLAY_BLOCK_CLASS}>
            Used the last published copy of {notice.name}.
          </span>
        </Notice>
      ))}
    </div>
  );
}
