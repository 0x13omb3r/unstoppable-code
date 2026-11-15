import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import {
  clearScenario,
  DEFAULT_MOCK_BASE_URL,
  registerScenario,
  seedWorktreeChat,
} from './seeders/index.mjs';
import { withBundledBinaryOverridesScrubbed } from './seeders/bundledBinaryOverrides.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';

// The shared AI Credits notice (`CreditsNotice`, Card A) in the desktop
// composer: who it offers a purchase to, and the purchase's steps.
//
//   1. A buyer buys: the browser hand-off opens once, the notice waits on it
//      with Check again and Reopen billing, and Check again finds the
//      credits, which the composer confirms.
//   2. A guest's purchase action signs in first; nothing opens billing.
//   3. A member of an organization whose pool needs its admin gets the admin
//      line and no purchase action.
//
// Deviation from the plan: it named the mock `usage-limit-reached` scenario
// and `seedUsageLimitedChats.mjs`, but those model a Claude/Codex provider
// quota and the resume modal, not AI Credits. AI Credits state comes from the
// cloud mock instead: `cloud.aiCreditsBalance` per key, the contact-admin key
// with its organization's spendable probe, and a per-device guest token.
// Providers are signed out through a per-test `authUsage` scenario, so the
// composer's No billing source notice is the one under test.
//
// Run:
//   pnpm run test:electron apps/desktop-app/tests/electron/credits-notice.spec.mjs

const WORKSPACE_ID = 'demo-ts-pnpm-vite';
const WORKTREE_ID = 'demo-main';
const WORKTREE_BRANCH = 'demo-main';
const CLOUD_ACCOUNT_CHANGED_EVENT = 'canopy:cloud-account-changed';
// The mock's member account whose organization pool needs its admin.
const CONTACT_ADMIN_KEY = 'csk_model_recovery_contact_admin_e2e';
const CONTACT_ADMIN_ORG_ID = '77777777-7777-4777-8777-777777777777';

/** Local receiver standing in for the host browser. */
async function startExternalOpenCapture() {
  const opened = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      try {
        opened.push(JSON.parse(body).url);
      } catch {
        // Malformed payloads leave a gap the assertions report.
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{}');
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}/__capture/external-open`,
    opened,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

/** Make the seeded workspace owned by an organization (CAN-3463). */
function markWorkspaceOrganizationOwned(userDataDir, organizationId) {
  const filePath = path.join(
    userDataDir,
    'workspaces',
    WORKSPACE_ID,
    'workspace.json',
  );
  const config = JSON.parse(readFileSync(filePath, 'utf8'));
  writeFileSync(
    filePath,
    JSON.stringify({
      ...config,
      owner: {
        type: 'organization',
        organizationId,
        projectId: '99999999-9999-4999-8999-999999999991',
        instanceId: '99999999-9999-4999-8999-999999999992',
        bindingGeneration: 0,
      },
    }),
  );
}

/**
 * Seed one chat, launch with signed-out providers and billing opening in the
 * (captured) browser, and open the chat's worktree.
 */
async function openChat({ prefix, providerType, model, flags, prepare }) {
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), `canopy-${prefix}-`));
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    providerType,
    tabs: [{ id: `${prefix}-chat`, title: 'Credits notice', model }],
  });
  prepare?.(userDataDir);
  const authKey = `${prefix}-unauthenticated-${randomUUID()}`;
  await registerScenario(DEFAULT_MOCK_BASE_URL, authKey, {
    authUsage: { scenario: 'unauthenticated' },
  });
  const externalOpen = await startExternalOpenCapture();
  const { electronApp } = await withBundledBinaryOverridesScrubbed(() =>
    launchCanopy({
      userDataDir,
      env: {
        CANOPY_MOCK_API_KEY: authKey,
        CANOPY_E2E_CLOUD_BASE_URL: DEFAULT_MOCK_BASE_URL,
        CANOPY_E2E_EXTERNAL_OPEN_CAPTURE_URL: externalOpen.url,
        // Billing opens in the browser: in Settings the hand-off would end.
        CANOPY_E2E_CLIENT_FEATURE_FLAGS: JSON.stringify({
          'canopy-desktop-hosted-settings': false,
          ...flags,
        }),
      },
    }),
  );
  const window = await electronApp.firstWindow();
  const app = new CanopyAppDriver(window);
  await app.waitForShell({ timeout: 30_000 });
  const close = async () => {
    await closeCanopy(electronApp, userDataDir);
    await clearScenario(DEFAULT_MOCK_BASE_URL, authKey);
    await externalOpen.close();
  };
  return { window, app, externalOpen, close };
}

/** Sign in with a cloud key and announce it, as the account flow does. */
async function signIn(window, apiKey) {
  const saved = await window.evaluate(
    async (key) => window.api.saveCanopyCloudApiKey({ apiKey: key }),
    apiKey,
  );
  expect(saved.status.authenticated).toBe(true);
  await window.evaluate((eventName) => {
    window.dispatchEvent(new Event(eventName));
  }, CLOUD_ACCOUNT_CHANGED_EVENT);
}

async function showWorktree(window, app) {
  await app.openMainPage();
  await app.selectWorktree(WORKTREE_BRANCH);
  const panel = window.getByTestId('panel-content-chat');
  await expect(panel).toBeVisible();
  return panel;
}

test.describe('Credits notice', () => {
  test('a buyer buys, waits on the hand-off, checks again and sees the credits arrive', async () => {
    test.setTimeout(180_000);
    const cloudKey = `csk_credits_notice_buyer_${randomUUID()}`;
    await registerScenario(DEFAULT_MOCK_BASE_URL, cloudKey, {
      cloud: { aiCreditsBalance: { credits: 0, eligible: false } },
    });
    const fixture = await openChat({
      prefix: 'credits-notice-buyer',
      providerType: 'claude',
      model: 'opus[1m]',
    });
    try {
      const { window, app, externalOpen } = fixture;
      await signIn(window, cloudKey);
      const panel = await showWorktree(window, app);
      const notice = panel.getByTestId('chat-input-no-billing-source-banner');
      const buy = notice.getByTestId(
        'chat-input-no-billing-source-get-credits',
      );
      const checkAgain = notice.getByTestId(
        'chat-input-no-billing-source-get-credits-check-again',
      );
      const reopen = notice.getByTestId(
        'chat-input-no-billing-source-reopen-billing',
      );

      // Nothing can pay: the attention notice offers the purchase.
      await expect(notice).toBeVisible({ timeout: 30_000 });
      await expect(notice).toHaveAttribute('data-notice-intent', 'attention');
      await expect(buy).toHaveText('Buy AI Credits');
      await expect(buy).toBeEnabled({ timeout: 15_000 });
      await expect(notice).not.toContainText('Finish checkout in your browser');

      // Buy hands off to the browser once, and the notice waits on it.
      await buy.click();
      await expect.poll(() => externalOpen.opened.length).toBe(1);
      await expect(notice).toContainText('Finish checkout in your browser', {
        timeout: 15_000,
      });
      await expect(notice).toHaveAttribute('data-notice-intent', 'neutral');
      await expect(checkAgain).toBeVisible();
      await expect(reopen).toBeVisible();
      await expect(reopen).toHaveText('Reopen billing');
      await expect(
        notice.locator('[data-notice-actions="below"]'),
      ).toBeVisible();

      // The credits land; Check again finds them.
      await registerScenario(DEFAULT_MOCK_BASE_URL, cloudKey, {
        cloud: { aiCreditsBalance: { credits: 16, eligible: true } },
      });
      await checkAgain.click();

      // Arrived: the composer confirms the credits this chat now uses, and the
      // attention notice is gone.
      const card = panel.getByTestId('chat-input-ai-credits-active');
      await expect(
        card.getByTestId('chat-input-ai-credits-arrival'),
      ).toHaveText('16 AI Credits added.', { timeout: 15_000 });
      await expect(notice).toHaveCount(0);
      expect(externalOpen.opened.length).toBe(1);
    } finally {
      await fixture.close();
      await clearScenario(DEFAULT_MOCK_BASE_URL, cloudKey);
    }
  });

  test('a guest signs in before buying, and nothing opens billing', async () => {
    test.setTimeout(150_000);
    // This guest's own token, so no shared guest scenario changes.
    const deviceId = randomUUID();
    const guestToken = `csk_credits_notice_guest_${randomUUID()}`;
    await registerScenario(DEFAULT_MOCK_BASE_URL, `guest-device:${deviceId}`, {
      guestToken,
    });
    await registerScenario(DEFAULT_MOCK_BASE_URL, guestToken, {
      cloud: { aiCreditsBalance: { credits: 0, eligible: false } },
    });
    const fixture = await openChat({
      prefix: 'credits-notice-guest',
      providerType: 'claude',
      model: 'opus[1m]',
      flags: { 'canopy-guest-mode-enabled': true },
      prepare: (userDataDir) => {
        writeFileSync(
          path.join(userDataDir, 'portal-state.json'),
          JSON.stringify({ version: 1, clientDeviceId: deviceId }),
        );
      },
    });
    try {
      const { window, app, externalOpen } = fixture;
      await expect
        .poll(
          async () =>
            (await window.evaluate(() => window.api.loadCanopyCloudAccount()))
              ?.credentialSource,
          { timeout: 30_000 },
        )
        .toBe('guest');
      const panel = await showWorktree(window, app);
      const notice = panel.getByTestId('chat-input-no-billing-source-banner');
      const buy = notice.getByTestId(
        'chat-input-no-billing-source-get-credits',
      );
      await expect(notice).toBeVisible({ timeout: 30_000 });
      await expect(buy).toBeEnabled({ timeout: 15_000 });
      // A guest's purchase action names the sign-in, never the bare purchase.
      await expect(buy).toHaveText('Sign in to buy AI Credits');

      // The guest's purchase action is the sign-in: it opens the account
      // sign-in, never a billing page.
      await buy.click();
      await expect(window.getByTestId('cloud-sync-modal')).toBeVisible({
        timeout: 15_000,
      });
      await expect(
        notice.getByTestId(
          'chat-input-no-billing-source-get-credits-check-again',
        ),
      ).toHaveCount(0);
      expect(externalOpen.opened).toEqual([]);
    } finally {
      await fixture.close();
      await clearScenario(DEFAULT_MOCK_BASE_URL, guestToken);
      await clearScenario(DEFAULT_MOCK_BASE_URL, `guest-device:${deviceId}`);
    }
  });

  test("an organization member who can't fund the pool gets no purchase action", async () => {
    test.setTimeout(150_000);
    const fixture = await openChat({
      prefix: 'credits-notice-org-member',
      providerType: 'claude',
      model: 'opus[1m]',
      prepare: (userDataDir) =>
        markWorkspaceOrganizationOwned(userDataDir, CONTACT_ADMIN_ORG_ID),
    });
    try {
      const { window, app, externalOpen } = fixture;
      await signIn(window, CONTACT_ADMIN_KEY);
      const panel = await showWorktree(window, app);
      const notice = panel.getByTestId('chat-input-no-billing-source-banner');
      await expect(notice).toBeVisible({ timeout: 30_000 });
      await expect(
        notice.getByTestId('chat-input-no-billing-source-contact-admin'),
      ).toBeVisible({ timeout: 15_000 });
      await expect(
        notice.getByTestId('chat-input-no-billing-source-get-credits'),
      ).toHaveCount(0);
      await expect(notice).not.toContainText('Buy AI Credits');
      expect(externalOpen.opened).toEqual([]);
    } finally {
      await fixture.close();
    }
  });
});
