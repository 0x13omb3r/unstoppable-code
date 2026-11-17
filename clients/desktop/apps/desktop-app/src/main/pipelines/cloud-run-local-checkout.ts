/**
 * A local worktree's run in the cloud (CAN-6869, plan CP-36).
 *
 * "Run on: Cloud" with the current task sends the worktree's pushed branch
 * to the web core, which runs it in the run owner's cloud worktree on that
 * branch at the pushed head. Main reads the worktree's checkout here: its
 * GitHub repository, branch and head, and whether it has commits GitHub
 * doesn't or changes nobody committed. The cloud runs only what is pushed,
 * so either one goes back to the Run dialog to warn about first.
 *
 * Main pushes only when the person confirmed that warning for the head they
 * saw: a head that moved since asks again, and nothing is ever pushed
 * without it. The worktree's folder is resolved here from its project and
 * task, never taken from the request.
 */

import {
  getCurrentBranch,
  hasUncommittedChanges,
} from '@canopy/desktop-shared/lib/git';
import type {
  CloudPipelineRunCheckoutConfirmation,
  CloudPipelineRunCheckoutState,
} from '@canopy/desktop-shared/types/pipeline-cloud-runs';
import type { CloudPipelineRunCheckout } from '@canopy/protocol/canopy-core';
import {
  getAheadBehindCounts,
  getHeadCommitSha,
  getOriginPushUrls,
  getRemoteUrl,
} from '../lib/git';

/** The Git reads and the push the checkout needs; the worktree's own Git in production. */
export interface LocalCheckoutGit {
  /** `HEAD` when detached. */
  branch(cwd: string): Promise<string>;
  head(cwd: string): Promise<string | null>;
  originUrl(cwd: string): Promise<string | null>;
  uncommitted(cwd: string): Promise<boolean>;
  /**
   * Commits ahead of and behind `origin/<branch>` as this computer last
   * fetched it; null when it has no such remote-tracking branch.
   */
  divergence(
    cwd: string,
    branch: string,
  ): Promise<{ ahead: number; behind: number } | null>;
  /** origin's configured push URLs; empty when git pushes to its fetch URL. */
  pushUrls(cwd: string): Promise<readonly string[]>;
}

/** Pushes exactly `headSha` to `branch` on origin: the task's own worker push. */
export type LocalCheckoutPush = (confirmed: {
  readonly branch: string;
  readonly headSha: string;
}) => Promise<void>;

export const LOCAL_CHECKOUT_GIT: LocalCheckoutGit = {
  branch: (cwd) => getCurrentBranch(cwd),
  head: (cwd) => getHeadCommitSha(cwd),
  originUrl: (cwd) => getRemoteUrl(cwd),
  uncommitted: (cwd) => hasUncommittedChanges(cwd),
  async divergence(cwd, branch) {
    try {
      return await getAheadBehindCounts(cwd, 'HEAD', `origin/${branch}`);
    } catch {
      // No remote-tracking branch: never pushed, or never fetched.
      return null;
    }
  },
  pushUrls: (cwd) => getOriginPushUrls(cwd),
};

const GITHUB_REMOTE = [
  // https://github.com/owner/name(.git), with or without credentials
  /^https?:\/\/(?:[^@/]+@)?github\.com\/([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?\/?$/,
  // git@github.com:owner/name(.git)
  /^(?:ssh:\/\/)?git@github\.com[:/]([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?\/?$/,
];

/** `owner/name` of a github.com remote URL, or null for any other remote. */
export function githubRepositoryOfRemote(url: string): string | null {
  const trimmed = url.trim();
  for (const pattern of GITHUB_REMOTE) {
    const match = pattern.exec(trimmed);
    if (match?.[1] !== undefined && match[2] !== undefined)
      return `${match[1]}/${match[2]}`;
  }
  return null;
}

/** Why a worktree can't run in the cloud at all; the dialog shows it as is. */
export const LOCAL_CHECKOUT_COPY = {
  notGitHub:
    "This task's repository isn't on GitHub, so it can't run in the cloud. Pick a GitHub repository under Working directory, or run it on this computer.",
  detached:
    'This task has no branch checked out. Check out a branch to run it in the cloud.',
  noCommit:
    'This task has no commits yet. Commit and push them to run it in the cloud.',
  behind:
    "This task's branch is behind GitHub. Pull it first, so the cloud runs what you see.",
  moved:
    "This task's repository, branch or commits changed since you confirmed. Review them and run again.",
  // A resend of a start already sent, confirmed or not (CAN-6869).
  movedSinceSent:
    "This task's repository, branch or commits changed since this run was sent. Run it again from where the task is now.",
  pushElsewhere:
    "This task's origin pushes somewhere other than its GitHub repository, so it can't run in the cloud. Run it on this computer.",
} as const;

/** What a cloud start of a local worktree goes on with. */
export type LocalCheckoutOutcome =
  | { readonly kind: 'ready'; readonly checkout: CloudPipelineRunCheckout }
  | {
      readonly kind: 'confirm';
      /** What the Run dialog warns about, with the head it read. */
      readonly state: CloudPipelineRunCheckoutState;
    }
  | { readonly kind: 'refused'; readonly message: string };

/**
 * The worktree's pushed branch, or what to ask about or refuse first.
 * With `confirmed` (the repository, branch and head the person saw the
 * warning for), unpushed commits are pushed and uncommitted changes are left
 * behind, so the cloud runs exactly what is on GitHub afterwards.
 */
export async function resolveLocalCheckout(
  cwd: string,
  confirmed: CloudPipelineRunCheckoutConfirmation | undefined,
  push: LocalCheckoutPush,
  git: LocalCheckoutGit = LOCAL_CHECKOUT_GIT,
): Promise<LocalCheckoutOutcome> {
  const url = await git.originUrl(cwd);
  const repository = url === null ? null : githubRepositoryOfRemote(url);
  if (repository === null)
    return { kind: 'refused', message: LOCAL_CHECKOUT_COPY.notGitHub };
  // git pushes to a configured push URL instead: every one must be the
  // repository the cloud reads, or a push could publish the branch elsewhere.
  // (A user's own url.*.pushInsteadOf rewriting is their mapping, trusted.)
  const pushUrls = await git.pushUrls(cwd);
  if (
    pushUrls.some(
      (pushUrl) =>
        githubRepositoryOfRemote(pushUrl)?.toLowerCase() !==
        repository.toLowerCase(),
    )
  )
    return { kind: 'refused', message: LOCAL_CHECKOUT_COPY.pushElsewhere };
  const branch = (await git.branch(cwd)).trim();
  if (branch === '' || branch === 'HEAD')
    return { kind: 'refused', message: LOCAL_CHECKOUT_COPY.detached };
  const headSha = await git.head(cwd);
  if (headSha === null)
    return { kind: 'refused', message: LOCAL_CHECKOUT_COPY.noCommit };
  const [divergence, uncommitted] = await Promise.all([
    git.divergence(cwd, branch),
    git.uncommitted(cwd),
  ]);
  if (divergence !== null && divergence.behind > 0)
    return { kind: 'refused', message: LOCAL_CHECKOUT_COPY.behind };
  const unpushed = divergence === null ? null : divergence.ahead;
  const ready = {
    kind: 'ready',
    checkout: { repository, branch, headSha },
  } as const;
  // A confirmation names the repository, branch and head it was given for:
  // any other, pushed or not, asks again, so nothing goes anywhere, or runs
  // at any commit, that nobody confirmed.
  if (
    confirmed !== undefined &&
    (confirmed.repository.toLowerCase() !== repository.toLowerCase() ||
      confirmed.branch !== branch ||
      confirmed.headSha !== headSha)
  )
    return { kind: 'refused', message: LOCAL_CHECKOUT_COPY.moved };
  if (unpushed === 0 && !uncommitted) return ready;
  if (confirmed === undefined)
    return {
      kind: 'confirm',
      state: {
        repository,
        branch,
        headSha,
        published: unpushed !== null,
        unpushedCommits: unpushed ?? 0,
        uncommittedChanges: uncommitted,
      },
    };
  // Exactly the confirmed commit, never whatever HEAD is by then.
  if (unpushed !== 0) await push({ branch, headSha });
  return ready;
}
