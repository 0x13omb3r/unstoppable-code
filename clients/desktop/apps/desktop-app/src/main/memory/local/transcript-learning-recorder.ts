import type { TurnRecorderBeginOptions } from '../../skill-suggestions/turn-recorder';
import type { PreferencesData } from '@canopy/desktop-shared/types';
import type { LearningTurn } from './transcript-learning-state';
import { subscribeCommittedPreferences } from '../../lib/preferences-committed';
import { resolveLocalMemoryScope } from './scope-resolver';
import {
  peekCanopyCloudAccount,
  peekCanopyCloudAccountId,
} from '../../lib/canopy-cloud-account-store';

/** Unknown snapshots and credentials without a stable account ID fail closed. */
export function chatLearningAccountId(): string | null | undefined {
  const id = peekCanopyCloudAccountId();
  if (typeof id === 'string' && id.trim().length === 0) return undefined;
  return id === null && peekCanopyCloudAccount() !== null ? undefined : id;
}

export { isChatLearningFlagEnabled } from './transcript-learning-gate';
import { isChatLearningFlagEnabled } from './transcript-learning-gate';

export async function chatLearningEnabled(): Promise<boolean> {
  if (!isChatLearningFlagEnabled()) return false;
  const { readPreferencesFile } = await import('../../lib/preferences-store');
  const preferences = await readPreferencesFile();
  return (
    preferences.localMemoryEnabled && preferences.localMemoryLearnFromChats
  );
}

const gateListeners = new Set<() => void>();
let gateRevision = 0;
let committedEnabled: boolean | null = null;
export function onChatLearningDisabled(listener: () => void): () => void {
  gateListeners.add(listener);
  return () => {
    gateListeners.delete(listener);
  };
}
function commitChatLearningPreferences(
  preferences: Pick<
    PreferencesData,
    'localMemoryEnabled' | 'localMemoryLearnFromChats'
  >,
): void {
  const enabled =
    preferences.localMemoryEnabled && preferences.localMemoryLearnFromChats;
  if (enabled === committedEnabled) return;
  committedEnabled = enabled;
  gateRevision += 1;
  open.clear();
  if (enabled) return;
  for (const listener of gateListeners) listener();
}

interface CapturedTurn {
  dir: string;
  turn: LearningTurn;
}
const open = new Map<
  string,
  { auditId: string; capture: Promise<CapturedTurn | null> }
>();

subscribeCommittedPreferences(commitChatLearningPreferences);

async function capture(
  options: TurnRecorderBeginOptions,
  accountId: string | null,
): Promise<CapturedTurn | null> {
  if (!(await chatLearningEnabled()) || !options.userMessageId) return null;
  const { resolveLocalMemoryPolicy } = await import('./policy');
  const policy = await resolveLocalMemoryPolicy(options);
  if (policy.kind === 'blocked') return null;
  const scope =
    policy.kind === 'scoped'
      ? { scope: 'workspace' as const, workspaceId: policy.workspaceId }
      : { scope: 'user' as const };
  const resolved = resolveLocalMemoryScope(scope);
  if (chatLearningAccountId() !== accountId) return null;
  return {
    dir: resolved.dir,
    turn: {
      projectId: options.projectId,
      worktreeId: options.worktreeId,
      chatId: options.chatId,
      userMessageId: options.userMessageId,
      at: Date.now(),
      accountId,
      accountBindingVersion: 1,
      ...(policy.kind === 'scoped' && policy.owner
        ? { owner: policy.owner }
        : {}),
    },
  };
}

/** Records IDs, never prompt/stream contents. No pipelines, CLI or synthetic turns. */
export const chatLearningTurnRecorder = {
  begin(key: string, auditId: string, options: TurnRecorderBeginOptions): void {
    open.delete(key);
    if (
      !isChatLearningFlagEnabled() ||
      committedEnabled === false ||
      options.skillSuggestionEligible !== true ||
      options.assistantMode !== undefined ||
      options.chatMode === 'terminal' ||
      !options.userMessageId
    )
      return;
    const revision = gateRevision;
    const accountId = chatLearningAccountId();
    if (accountId === undefined) return;
    open.set(key, {
      auditId,
      capture: capture(options, accountId)
        .then((result) => (revision === gateRevision ? result : null))
        .catch(() => null),
    });
  },
  complete(key: string, auditId: string, status: string): void {
    const pending = open.get(key);
    open.delete(key);
    if (!pending || pending.auditId !== auditId || status !== 'success') return;
    void pending.capture
      .then(async (captured) => {
        if (!captured || !(await chatLearningEnabled())) return;
        const { queueLearningTurn } =
          await import('./transcript-learning-state');
        await queueLearningTurn(captured.dir, captured.turn);
      })
      .catch(() => undefined);
  },
};
