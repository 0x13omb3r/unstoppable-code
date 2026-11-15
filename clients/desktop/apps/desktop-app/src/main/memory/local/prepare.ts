import type { LocalMemoryScopeRequest } from '@canopy/desktop-shared/types';
import { readPreferencesFile } from '../../lib/preferences-store';
import { isTrivialMemoryInput } from '../memory-context';
import { localMemoryStore } from './memory-store';
import { LOCAL_MEMORY_RECALL_BUDGET, renderLocalMemoryRecall } from './render';
import { resolveLocalMemoryPolicy } from './policy';
import type { RecentInboxNote } from './store';
import { getCanopyReleaseFlavor } from '../../lib/app-identity';

const recentNotesBudget = {
  maxNotes: LOCAL_MEMORY_RECALL_BUDGET.recentNotesPerScope,
  maxCharsPerNote: LOCAL_MEMORY_RECALL_BUDGET.recentNoteChars,
};

type TopicKeyParser = (indexExcerpt: string) => string[];

// The last excerpt parsed per scope and the topics it links. An index rarely
// changes between turns, so a batch of injections parses it once.
const injectedTopicKeys = new Map<
  string,
  { excerpt: string; keys: string[] }
>();

function topicKeysFor(
  scopeDir: string,
  indexExcerpt: string,
  parse: TopicKeyParser,
): string[] {
  const cached = injectedTopicKeys.get(scopeDir);
  if (cached?.excerpt === indexExcerpt) return cached.keys;
  const keys = parse(indexExcerpt);
  injectedTopicKeys.set(scopeDir, { excerpt: indexExcerpt, keys });
  return keys;
}

/**
 * Injection is a use of what it carries: the topics its index lines link,
 * found by the parser the consolidation resolver uses
 * (`referencedTopicFileKeys`), and the inbox notes it quotes. Recorded
 * without waiting, in batches. Parsing the excerpt costs milliseconds per
 * scope, so it runs when the batch is applied, never before the turn starts.
 */
function recordInjectedUsage(
  scope: LocalMemoryScopeRequest,
  indexExcerpt: string,
  notes: RecentInboxNote[],
  parse: TopicKeyParser,
): void {
  const scopeDir = localMemoryStore.resolve(scope).dir;
  localMemoryStore.recordUsageSoon(
    scope,
    notes.map((note) => note.fileKey),
    indexExcerpt === ''
      ? undefined
      : (): string[] => topicKeysFor(scopeDir, indexExcerpt, parse),
  );
}

export interface PreparedLocalMemory {
  renderedBlock: string;
  privateMemory: boolean;
  holdout: boolean;
  scopes: Array<{
    scope: LocalMemoryScopeRequest;
    scopeDir: string;
    index: string;
    notes: RecentInboxNote[];
  }>;
}

export async function prepareLocalMemoryContext(options: {
  userText: string;
  projectId: string;
  worktreeId: string;
  turnId?: string;
}): Promise<PreparedLocalMemory | null> {
  const preferences = await readPreferencesFile().catch(() => null);
  if (
    !preferences?.localMemoryEnabled ||
    isTrivialMemoryInput(options.userText)
  ) {
    return null;
  }
  // Resolve sentinel-keyed sessions (plan-explore / code-review) to the REAL
  // workspace their memory tools write to; injection and save/search must
  // always read the same directory. A null resolution means the session has
  // no workspace scope — skip workspace memory entirely but keep injecting
  // user-scope memory.
  const policy = await resolveLocalMemoryPolicy({
    projectId: options.projectId,
    worktreeId: options.worktreeId,
  });
  if (policy.kind === 'blocked') return null;
  // Private memory keeps this project's chats away from user-scope memory.
  const userMemoryExcluded = policy.kind === 'scoped' && policy.privateMemory;
  const userScope: LocalMemoryScopeRequest = { scope: 'user' };
  const workspaceScope: LocalMemoryScopeRequest | null =
    policy.kind === 'scoped'
      ? { scope: 'workspace', workspaceId: policy.workspaceId }
      : null;
  const userScopeDir = userMemoryExcluded
    ? null
    : localMemoryStore.resolve(userScope).dir;
  const workspaceScopeDir =
    workspaceScope === null
      ? null
      : localMemoryStore.resolve(workspaceScope).dir;
  const [userIndex, workspaceIndex, userRecent, workspaceRecent] =
    await Promise.all([
      userMemoryExcluded
        ? Promise.resolve({ text: '', truncated: false })
        : localMemoryStore.readIndex(userScope),
      workspaceScope === null
        ? Promise.resolve({ text: '', truncated: false })
        : localMemoryStore.readIndex(workspaceScope),
      userMemoryExcluded
        ? Promise.resolve([])
        : localMemoryStore.readRecentNotes(userScope, recentNotesBudget),
      workspaceScope === null
        ? Promise.resolve([])
        : localMemoryStore.readRecentNotes(workspaceScope, recentNotesBudget),
    ]);
  const rendered = renderLocalMemoryRecall({
    userIndex,
    workspaceIndex,
    recentNotes: [...userRecent, ...workspaceRecent].map((note) => note.text),
  });
  if (!rendered) return null;
  // The final included note can be only a prefix after the block's byte cap.
  // Pair the renderer's exact excerpts with their source identities.
  const candidates = [...userRecent, ...workspaceRecent].filter(
    (note) => note.text.replace(/\0/g, '').trim().length > 0,
  );
  const injectedNotes = rendered.includedNoteTexts.flatMap((text, index) => {
    const source = candidates[index];
    return source ? [{ ...source, text }] : [];
  });
  const injectedUserNotes = injectedNotes.slice(
    0,
    userRecent.filter((note) => note.text.replace(/\0/g, '').trim().length > 0)
      .length,
  );
  const injectedWorkspaceNotes = injectedNotes.slice(injectedUserNotes.length);
  // Internal builds only, injection-only holdout. Memory tools remain available.
  // Stable/RC builds cannot opt in through environment or saved preferences.
  const holdout =
    getCanopyReleaseFlavor() === 'internal' &&
    options.turnId !== undefined &&
    memoryHoldoutBucket(options.turnId) === 0;
  const prepared: PreparedLocalMemory = {
    renderedBlock: holdout ? '' : rendered.block,
    privateMemory: userMemoryExcluded,
    holdout,
    scopes: [
      ...(userScopeDir !== null
        ? [
            {
              scope: userScope,
              scopeDir: userScopeDir,
              index: rendered.userIndex,
              notes: injectedUserNotes,
            },
          ]
        : []),
      ...(workspaceScope !== null && workspaceScopeDir !== null
        ? [
            {
              scope: workspaceScope,
              scopeDir: workspaceScopeDir,
              index: rendered.workspaceIndex,
              notes: injectedWorkspaceNotes,
            },
          ]
        : []),
    ],
  };
  if (holdout) return prepared;
  // The Markdown parser stays off Electron's startup import path: it loads
  // on the first injection, and later imports resolve from the cache.
  const { referencedTopicFileKeys } =
    await import('@canopy/memory-consolidation/topic-reference');
  if (!userMemoryExcluded) {
    recordInjectedUsage(
      userScope,
      rendered.userIndex,
      injectedUserNotes,
      referencedTopicFileKeys,
    );
  }
  if (workspaceScope !== null) {
    recordInjectedUsage(
      workspaceScope,
      rendered.workspaceIndex,
      injectedWorkspaceNotes,
      referencedTopicFileKeys,
    );
  }
  return prepared;
}

function memoryHoldoutBucket(turnId: string): number {
  let hash = 2_166_136_261;
  for (let index = 0; index < turnId.length; index += 1) {
    hash = Math.imul(hash ^ turnId.charCodeAt(index), 16_777_619);
  }
  return (hash >>> 0) % 10;
}
