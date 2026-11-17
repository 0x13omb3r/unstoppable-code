/**
 * CAN-4856: a new organization copy of a code share with several
 * repositories (`shared-containers:fork`).
 *
 * The recipient's share holds two GitHub repositories, and the share owner's
 * organization has a project for each. Making a new copy in that
 * organization stages the checkout unpublished, creates the member's
 * multi-repo project, then claims, binds and completes it: the copy is listed
 * under the organization only, bound to its project and instance, and no
 * Personal workspace appears. When one repository has no organization
 * project, the copy refuses on the destination step and nothing is created,
 * claimed or staged.
 *
 * Run: pnpm run test:electron:built shared-container-org-multi-repo-copy.spec.mjs --reporter=line
 */
import { existsSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import {
  clearScenario,
  DEFAULT_MOCK_BASE_URL,
  getScenarioActivity,
  registerScenario,
  ORG_CONTEXT_ENV,
} from './seeders/index.mjs';
import { seedChatsSectionFixture } from './seeders/seedChatsSectionFixture.mjs';
import { seedOrgContextScoping } from './seeders/seedOrgContextScoping.mjs';
import {
  seedSharedContainerRecipientReplicas,
  sharedContainerRecipientScenario,
  SHARED_CONTAINER_RECIPIENT_CODE_ID,
} from './seeders/seedSharedContainerRecipientReplicas.mjs';
import {
  OTHER_SHARED_CONTAINERS_ORGANIZATION_ID,
  SHARED_CONTAINERS_CLOUD_API_KEY,
  SHARED_CONTAINERS_ORGANIZATION_ID,
  buildSharedContainerE2eEnv,
  connectSharedContainersAccount,
} from './sharedContainerInviteFixture.mjs';

/** Accept a pending share from its sidebar row's invitation dialog. */
async function acceptSharedContainerInvitation(window, containerId) {
  await window
    .getByTestId(`shared-container-invitation-${containerId}`)
    .click();
  const dialog = window.getByTestId('shared-container-invitation-dialog');
  await expect(dialog).toBeVisible();
  await window.getByTestId('shared-container-invitation-dialog-accept').click();
  await expect(dialog).toHaveCount(0, { timeout: 30_000 });
}

/** Pick a context from the sidebar switcher and wait for main to commit it. */
async function selectWorkspaceContext(window, contextId) {
  const row = window.getByTestId('sidebar-context-row');
  await expect(row).toBeEnabled();
  await row.click();
  await expect(window.getByTestId('sidebar-context-menu')).toBeVisible();
  await window.getByTestId(`sidebar-context-option-${contextId}`).click();
  await expect
    .poll(async () =>
      window.evaluate(
        async () => (await window.api.workspaceContext.get()).context,
      ),
    )
    .toEqual(
      contextId === 'personal'
        ? { kind: 'personal' }
        : { kind: 'organization', organizationId: contextId },
    );
}

test.describe.configure({ mode: 'serial' });

const ORGANIZATIONS = [
  {
    id: SHARED_CONTAINERS_ORGANIZATION_ID,
    name: 'Share owner org',
    role: 'MEMBER',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  },
  {
    id: OTHER_SHARED_CONTAINERS_ORGANIZATION_ID,
    name: 'Other org',
    role: 'MEMBER',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  },
];

/** An organization project that holds one of the share's repositories. */
function holderProject(index, name) {
  return {
    id: `e4856000-0000-4000-8000-00000000000${index}`,
    organizationId: SHARED_CONTAINERS_ORGANIZATION_ID,
    name,
    description: null,
    kind: 'CODE',
    purpose: 'project',
    visibility: 'organization',
    memberOwned: false,
    topology: 'single-repo',
    location: 'LOCAL',
    repository: {
      provider: 'github',
      host: 'github.com',
      owner: 'acme',
      name,
      providerRepoId: null,
      defaultBranch: 'main',
      verification: 'UNVERIFIED',
    },
    state: 'ACTIVE',
    revision: 1,
    authorizationVersion: 1,
    defaultListed: true,
    preference: 'FOLLOW_DEFAULTS',
    listed: true,
    capabilities: { administer: false, manageCloud: false, use: true },
    instance: null,
  };
}

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf8'));
}

function indexedWorkspaces(userDataDir) {
  return readJson(path.join(userDataDir, 'workspaces', 'index.json'))
    .workspaces;
}

/**
 * Accept the organization code share and open its copy dialog on the new
 * workspace destination in the share owner's organization.
 */
async function openOrganizationCodeCopy(userDataDir, holders) {
  const scenario = sharedContainerRecipientScenario({
    includeCowork: false,
    includeRun: false,
  });
  scenario.sharedContainersState.containers =
    scenario.sharedContainersState.containers.map((container) => ({
      ...container,
      organizationName: 'Share owner org',
    }));
  await registerScenario(
    DEFAULT_MOCK_BASE_URL,
    SHARED_CONTAINERS_CLOUD_API_KEY,
    {
      ...scenario,
      cloud: {
        ...(scenario.cloud ?? {}),
        organizations: ORGANIZATIONS,
        orgBillingStates: ORGANIZATIONS.map((organization) => ({
          organizationId: organization.id,
          organizationName: organization.name,
          teamsEntitled: true,
        })),
        orgProjects: {
          ...(scenario.cloud?.orgProjects ?? {}),
          [`org:${SHARED_CONTAINERS_ORGANIZATION_ID}`]: holders,
        },
      },
    },
  );
  const env = buildSharedContainerE2eEnv(userDataDir, {
    CANOPY_E2E_CLIENT_FEATURE_FLAGS:
      ORG_CONTEXT_ENV.CANOPY_E2E_CLIENT_FEATURE_FLAGS,
    CANOPY_E2E_ORG_PROJECT_AUTO_CONVERT: 'off',
  });
  let { electronApp } = await launchCanopy({ userDataDir, env });
  await connectSharedContainersAccount(await electronApp.firstWindow());
  await closeCanopy(electronApp, userDataDir, { keepUserData: true });

  seedSharedContainerRecipientReplicas(userDataDir, {
    preferences: false,
    includeRun: false,
  });
  seedOrgContextScoping(userDataDir);
  seedChatsSectionFixture(userDataDir, {
    worktreeCount: 1,
    chatEntryCount: 1,
  });
  ({ electronApp } = await launchCanopy({ userDataDir, env }));
  const window = await electronApp.firstWindow();
  const app = new CanopyAppDriver(window);
  await app.waitForShell({ timeout: 30_000 });
  await selectWorkspaceContext(window, SHARED_CONTAINERS_ORGANIZATION_ID);
  await app.openMainPage();

  await acceptSharedContainerInvitation(
    window,
    SHARED_CONTAINER_RECIPIENT_CODE_ID,
  );
  const codeRow = window.getByTestId(
    `shared-container-row-${SHARED_CONTAINER_RECIPIENT_CODE_ID}`,
  );
  await expect(codeRow).toBeVisible({ timeout: 30_000 });
  await codeRow.click();
  await expect(window.getByTestId('shared-container-surface')).toBeVisible();
  await window.getByTestId('shared-container-fork-open-modal').click();
  await expect(
    window.getByTestId('shared-container-fork-destination-context'),
  ).toHaveText('Belongs to Share owner org');
  const parentDirectory = await window
    .getByTestId('shared-container-fork-location')
    .inputValue();
  return { electronApp, window, parentDirectory };
}

async function confirmCopy(window) {
  await window.getByTestId('shared-container-fork-continue').click();
  await expect(
    window.getByTestId('shared-container-fork-disclosures-destination'),
  ).toHaveText('Your copy will be made in Share owner org.');
  await window.getByTestId('shared-container-fork-confirm').click();
}

async function activity() {
  return (
    await getScenarioActivity(
      DEFAULT_MOCK_BASE_URL,
      SHARED_CONTAINERS_CLOUD_API_KEY,
    )
  ).activity;
}

test('copies a multi-repo organization share into a new bound workspace', async () => {
  test.setTimeout(150_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-org-multi-repo-copy-'),
  );
  let electronApp;
  try {
    const opened = await openOrganizationCodeCopy(userDataDir, [
      holderProject(1, 'recipient-fixture'),
      holderProject(2, 'recipient-secondary'),
    ]);
    electronApp = opened.electronApp;
    const { window } = opened;
    const before = new Set(
      indexedWorkspaces(userDataDir).map((workspace) => workspace.id),
    );

    await confirmCopy(window);
    await expect(window.getByTestId('shared-container-fork-modal')).toHaveCount(
      0,
      { timeout: 60_000 },
    );

    const added = indexedWorkspaces(userDataDir).filter(
      (workspace) => !before.has(workspace.id),
    );
    // Exactly one new workspace, and it is the organization's: no Personal
    // copy was ever indexed.
    expect(added).toHaveLength(1);
    const [copy] = added;
    const workspaceDir = path.join(userDataDir, 'workspaces', copy.id);
    const config = readJson(path.join(workspaceDir, 'workspace.json'));
    expect(config.type).toBe('multi-repo');
    expect(config.repos).toHaveLength(2);
    expect(config.owner).toMatchObject({
      type: 'organization',
      organizationId: SHARED_CONTAINERS_ORGANIZATION_ID,
    });
    expect(typeof config.owner.projectId).toBe('string');
    expect(typeof config.owner.instanceId).toBe('string');

    // The copy's worktree carries its fork provenance.
    const worktrees = readJson(path.join(workspaceDir, 'worktrees.json'));
    expect(worktrees.worktrees).toHaveLength(1);
    const provenance = readJson(
      path.join(
        workspaceDir,
        'worktree-data',
        worktrees.worktrees[0].id,
        'shared-container-fork.json',
      ),
    );
    expect(provenance.sourceContainerId).toBe(
      SHARED_CONTAINER_RECIPIENT_CODE_ID,
    );

    const counts = await activity();
    expect(counts.orgMemberMultiRepoCreate).toBe(1);
    // Totals include the organization's default Chats claim; count only the
    // copy's own project.
    expect(counts[`orgProjectClaim:${config.owner.projectId}`]).toBe(1);
    expect(counts[`orgProjectComplete:${config.owner.projectId}`]).toBe(1);

    // Listed under the organization only.
    const copyHeader = window
      .getByTestId('sidebar-section-code')
      .getByText(copy.name, { exact: true })
      .first();
    await expect(copyHeader).toBeVisible({ timeout: 30_000 });
    await selectWorkspaceContext(window, 'personal');
    await expect(copyHeader).toHaveCount(0);
    await selectWorkspaceContext(window, SHARED_CONTAINERS_ORGANIZATION_ID);
    await expect(copyHeader).toBeVisible({ timeout: 30_000 });
  } finally {
    try {
      if (electronApp) await closeCanopy(electronApp, userDataDir);
    } finally {
      await clearScenario(
        DEFAULT_MOCK_BASE_URL,
        SHARED_CONTAINERS_CLOUD_API_KEY,
      ).catch(() => undefined);
    }
  }
});

test('refuses a multi-repo organization copy when a repository has no project', async () => {
  test.setTimeout(150_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-org-multi-repo-refusal-'),
  );
  let electronApp;
  try {
    const opened = await openOrganizationCodeCopy(userDataDir, [
      holderProject(1, 'recipient-fixture'),
    ]);
    electronApp = opened.electronApp;
    const { window, parentDirectory } = opened;
    const before = indexedWorkspaces(userDataDir).map(
      (workspace) => workspace.id,
    );
    const foldersBefore = existsSync(parentDirectory)
      ? readdirSync(parentDirectory).sort()
      : [];
    const claimsBefore = (await activity()).orgProjectClaim ?? 0;

    await confirmCopy(window);
    // The dialog returns to the destination step with the refusal.
    await expect(
      window.getByTestId('shared-container-fork-modal'),
    ).toBeVisible();
    await expect(
      window.getByTestId('shared-container-fork-destination-context'),
    ).toBeVisible({ timeout: 30_000 });
    await expect(
      window.getByTestId('shared-container-fork-error'),
    ).toContainText("doesn't have projects for every repository in this share");

    expect(
      indexedWorkspaces(userDataDir).map((workspace) => workspace.id),
    ).toEqual(before);
    expect(
      existsSync(parentDirectory) ? readdirSync(parentDirectory).sort() : [],
    ).toEqual(foldersBefore);
    const counts = await activity();
    expect(counts.orgMemberMultiRepoCreate ?? 0).toBe(0);
    expect(counts.orgProjectClaim ?? 0).toBe(claimsBefore);
  } finally {
    try {
      if (electronApp) await closeCanopy(electronApp, userDataDir);
    } finally {
      await clearScenario(
        DEFAULT_MOCK_BASE_URL,
        SHARED_CONTAINERS_CLOUD_API_KEY,
      ).catch(() => undefined);
    }
  }
});
