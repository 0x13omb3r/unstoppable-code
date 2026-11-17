import { isBotProjectId } from '@canopy/protocol/chat-targets';
import { IDLE_HOME_LINK_TARGET } from '@/components/home/homeLinkTarget';
import { isCoworkChatTarget } from '@/lib/cowork';
import { isWebCoreScope } from '@/lib/chat-authority';
import { useHomeComposerStore } from '@/stores/homeComposerStore';
import { useWorkspaceContextStore } from '@/stores/workspaceContextStore';
import type { AutomationDraftSeed } from '@/lib/workflows/edit-target';
import type { HomeTaskSnapshot } from './types';

export function snapshotHomeTask(
  surface: HomeTaskSnapshot['surface'],
): HomeTaskSnapshot {
  const composer = useHomeComposerStore.getState();
  return {
    surface,
    mode: composer.mode,
    text: composer.text,
    workspaceId: composer.workspaceId,
    fileReferenceCount: composer.fileReferences.length,
    attachmentCount: composer.attachments.length,
    scheduled: composer.scheduledSendDraft !== null,
    linkTargetStatus: composer.linkTarget.status,
    accountEpoch: useWorkspaceContextStore.getState().accountEpoch,
  };
}

export function isEligibleHomeTask(snapshot: HomeTaskSnapshot): boolean {
  return (
    snapshot.surface === 'page' &&
    snapshot.mode === 'chat' &&
    snapshot.text.trim() !== '' &&
    snapshot.workspaceId !== null &&
    !isBotProjectId(snapshot.workspaceId) &&
    // A cloud project's task runs in the cloud; a local automation made from
    // it would start a chat in a project no local IPC resolves (CAN-6757).
    !isWebCoreScope(snapshot.workspaceId) &&
    snapshot.fileReferenceCount === 0 &&
    snapshot.attachmentCount === 0 &&
    !snapshot.scheduled &&
    snapshot.linkTargetStatus === IDLE_HOME_LINK_TARGET.status
  );
}

export function automationDraftName(text: string): string {
  const firstLine = text
    .trim()
    .split(/\r?\n/)
    .find((line) => line.trim() !== '')
    ?.trim()
    .replace(/\s+/g, ' ');

  if (!firstLine || firstLine.length <= 60) return firstLine ?? '';

  const boundary = firstLine.lastIndexOf(' ', 59);
  if (boundary > 0) return `${firstLine.slice(0, boundary).trimEnd()}…`;
  return `${firstLine.slice(0, 59)}…`;
}

export function automationSeedFromTask(
  text: string,
  workspaceId: string,
): AutomationDraftSeed {
  return {
    projectId: workspaceId,
    isCowork: isCoworkChatTarget(workspaceId),
    name: automationDraftName(text),
    prompt: text,
  };
}
