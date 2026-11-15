import { referencedTopicFileKeys } from '@canopy/memory-consolidation/topic-reference';
import {
  captureDesktopPostHogEvent,
  isDesktopPostHogOperationCaptureEnabled,
} from '@canopy/desktop-instrumentation/electron/main';
import { recordUsageSignals } from './usage';
import { resolveLocalMemoryPolicy } from './policy';
import type { PreparedLocalMemory } from './prepare';
import {
  completedLocalMemoryTurnOutput,
  localMemorySignals,
  type MemorySignalSource,
} from './turn-usefulness';
import { CORE_OBSERVABILITY_GRANTS } from '@canopy/protocol/canopy-core';
import { getDesktopCanopyRuntime } from '../../canopy-runtime/desktop-runtime-access';
import { LOCAL_DESKTOP_AUTHORITY_ID } from '../../canopy-runtime/desktop-runtime-identity';

/** Read raw, already-recorded output; display transcript blocks strip citations. */
export async function recordCompletedLocalMemoryTurnUsefulness(options: {
  prepared: PreparedLocalMemory;
  projectId: string;
  auditProjectId: string;
  worktreeId: string;
  chatId: string;
  userMessageId: string | undefined;
  userText: string;
}): Promise<void> {
  let output = { assistantText: '', toolInputs: '' };
  if (!options.prepared.holdout && options.userMessageId !== undefined) {
    const runtime = getDesktopCanopyRuntime();
    const context = {
      caller: {
        principalId: 'local-desktop-user',
        clientInstanceId: 'local-memory-usefulness',
        authorityId: LOCAL_DESKTOP_AUTHORITY_ID,
        interfaceKind: 'desktop' as const,
        grants: [CORE_OBSERVABILITY_GRANTS.read],
      },
    };
    // The overview is the owner's bounded in-memory index, not a history scan.
    const summary = await runtime.query(
      'core.observability.summary.get',
      { kind: 'overview' },
      context,
    );
    const entry =
      summary.kind === 'overview'
        ? summary.overview.recentEntries.find(
            (candidate) =>
              candidate.projectId === options.auditProjectId &&
              candidate.worktreeId === options.worktreeId &&
              candidate.chatId === options.chatId &&
              candidate.userMessageId === options.userMessageId &&
              candidate.eventType !== 'managed_delegation',
          )
        : undefined;
    if (entry) {
      const transcript = await runtime.query(
        'core.observability.audit.transcript.get',
        {
          id: entry.id,
          eventType: entry.eventType,
          startedAt: entry.startedAt,
        },
        context,
      );
      if (transcript.type === 'success')
        output = await completedLocalMemoryTurnOutput(
          transcript.lines,
          entry.sdkSessionId,
        );
    }
  }
  await recordLocalMemoryTurnUsefulness({ ...options, ...output });
}

/** Completed-turn advisory work. Never awaited by dispatch or terminal delivery. */
export async function recordLocalMemoryTurnUsefulness(options: {
  prepared: PreparedLocalMemory;
  projectId: string;
  worktreeId: string;
  userText: string;
  assistantText: string;
  toolInputs: string;
}): Promise<void> {
  const { prepared } = options;
  const groups = prepared.scopes.map((entry) => {
    const files = new Map<string, string>();
    if (entry.index !== '') files.set('MEMORY.md', '');
    const topicKeys = referencedTopicFileKeys(entry.index);
    for (const key of topicKeys) files.set(key, '');
    for (const line of entry.index.split('\n')) {
      const lowerLine = line.toLowerCase();
      const keys = topicKeys.filter((key) =>
        lowerLine.includes(key.toLowerCase()),
      );
      // A multi-topic line cannot attribute its prose to one topic. Retain
      // citation identities, but do not duplicate that prose into every file.
      for (const key of keys.length === 1
        ? keys
        : keys.length === 0
          ? ['MEMORY.md']
          : []) {
        if (!line) continue;
        // Link destinations and file names are not distinctive content terms.
        const text = line.replace(/topics\/[^\s<>]{1,1000}\.md/gi, '');
        files.set(key, (files.get(key) ?? '') + '\n' + text);
      }
    }
    for (const note of entry.notes) files.set(note.fileKey, note.text);
    const sources: MemorySignalSource[] = [...files].map(([fileKey, text]) => ({
      fileKey,
      text,
    }));
    return { scopeDir: entry.scopeDir, sources };
  });
  const sources = groups.flatMap((group) => group.sources);
  const signals = prepared.holdout
    ? []
    : localMemorySignals(
        sources,
        options.userText,
        options.assistantText,
        options.toolInputs,
      );
  let offset = 0;
  for (const group of groups) {
    if (!prepared.holdout) {
      await recordUsageSignals(
        group.scopeDir,
        signals.slice(offset, offset + group.sources.length),
      );
    }
    offset += group.sources.length;
  }
  // A project can become private while the provider is running. Both the
  // source decision and current policy must permit capture; failure is closed.
  if (prepared.privateMemory || !isDesktopPostHogOperationCaptureEnabled())
    return;
  const policy = await resolveLocalMemoryPolicy(options);
  if (
    policy.kind === 'blocked' ||
    (policy.kind === 'scoped' && policy.privateMemory)
  )
    return;
  if (!isDesktopPostHogOperationCaptureEnabled()) return;
  captureDesktopPostHogEvent('memory:local_turn_end', {
    memory_received_count: prepared.holdout ? 0 : sources.length,
    memory_cited_count: signals.filter((signal) => signal.citationCount > 0)
      .length,
    memory_used_count: signals.filter((signal) => signal.usageSignalCount > 0)
      .length,
    memory_unclear_count: signals.filter(
      (signal) => signal.citationCount === 0 && signal.usageSignalCount === 0,
    ).length,
    memory_holdout_count: prepared.holdout ? 1 : 0,
  });
}
