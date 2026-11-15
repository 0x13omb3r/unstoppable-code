import { isWebCoreScope } from '@/lib/chat-authority';
import type { ChatPrefetchTarget } from '@/stores/chat/chat-prefetch';

/**
 * Whether a sidebar row's hover or focus may warm the local chat store. A
 * cloud row never does: its ids name the web core, so a local prefetch would
 * send them to local stores and IPC (CAN-4185 D6).
 */
export function shouldPrefetchWorktreeChat(
  projectId: string,
  worktreeId: string,
  cloudWorktreeKeys: ReadonlySet<string>,
): boolean {
  return (
    !isWebCoreScope(projectId) &&
    !cloudWorktreeKeys.has(`${projectId}/${worktreeId}`)
  );
}

/**
 * What resting on, or focusing, a sidebar row reads ahead. A local row warms
 * the local chat store. A web core task is read ahead through the web core
 * alone (CAN-6774): chat reads only, so its sandbox never wakes, and nothing
 * is installed, followed or sent to main until a click opens it. Another
 * cloud row reads nothing.
 */
export function sidebarRowPrefetchTarget(
  projectId: string,
  worktreeId: string,
  cloudWorktreeKeys: ReadonlySet<string>,
): ChatPrefetchTarget | null {
  if (shouldPrefetchWorktreeChat(projectId, worktreeId, cloudWorktreeKeys))
    return { kind: 'worktree', projectId, worktreeId };
  if (isWebCoreScope(projectId) && isWebCoreScope(worktreeId))
    return { kind: 'cloudTask', projectId, worktreeId };
  return null;
}
