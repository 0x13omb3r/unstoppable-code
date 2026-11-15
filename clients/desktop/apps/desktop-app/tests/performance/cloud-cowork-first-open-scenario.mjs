import { expect } from '@playwright/test';
import { startCloudChatsWebCore } from '../electron/fixtures/cloudChatsWebCore.mjs';
import {
  extraCloudTaskIds,
  SEEDED_CLOUD_CHATS,
} from '../electron/fixtures/cloudChatsWorld.js';
import { connectMockCloudAccount } from '../electron/seeders/connectMockCloudAccount.mjs';

/*
 * A desktop's first cloud cowork open after start (CAN-6838).
 *
 * One cloud cowork project with the seeded task and EXTRA_TASKS more, on the
 * E2E fake web core, whose snapshot and transcript reads answer after a fixed
 * delay so that reads competing for it show. Right after the project's tasks
 * list, the user opens one of them. The scenario times that open, from the
 * click to the chat's composer, and reads the fake web core's call trace for
 * what ran beside it: the archive sweep's snapshot reads (CAN-6778) and how
 * many were in flight at once.
 */

/** Tasks beside the seeded one: enough for the sweep to queue. */
export const CLOUD_COWORK_FIRST_OPEN_EXTRA_TASKS = 12;

/** The fake web core's answer delay per method, in ms. */
export const CLOUD_COWORK_FIRST_OPEN_LATENCY_MS = Object.freeze({
  'core.chat.snapshot.get': 250,
  'core.chat.transcript.page': 150,
});

/**
 * Click to composer for the first open, recorded before the scenario's first
 * measurement (docs/desktop-app-performance.md). With the latencies above, an
 * open costs a snapshot read and a transcript page read in sequence, about
 * 400 ms, before the app's own work.
 */
export const CLOUD_COWORK_FIRST_OPEN_BUDGET_MS = 1_500;

/** How long the sweep may take to read every task's archive after the open. */
const SWEEP_SETTLE_TIMEOUT_MS = 60_000;

/** The task the user opens: an extra one, so it has no messages to page. */
const openedTaskIndex = 5;

export async function prepareCloudCoworkFirstOpen(
  _userDataDir,
  _config,
  { releaseLike = false } = {},
) {
  // A release build compiles out the E2E cloud origin and feature-flag
  // override, and cloud chats is off there without LaunchDarkly, so the app
  // could never reach this fake web core. Compare E2E builds instead.
  if (releaseLike)
    throw new Error(
      'cloud-cowork-first-open runs on E2E builds only: release builds have no E2E cloud origin and leave cloud chats off',
    );
  const cloud = await startCloudChatsWebCore({
    extraTasks: CLOUD_COWORK_FIRST_OPEN_EXTRA_TASKS,
    latencyMs: CLOUD_COWORK_FIRST_OPEN_LATENCY_MS,
  });
  const extraTaskIds = extraCloudTaskIds(CLOUD_COWORK_FIRST_OPEN_EXTRA_TASKS);
  return {
    cloud,
    taskIds: [SEEDED_CLOUD_CHATS.taskId, ...extraTaskIds],
    openedTaskId: extraTaskIds[openedTaskIndex],
    launchEnv: { CANOPY_E2E_CLOUD_BASE_URL: cloud.baseUrl },
  };
}

export function cloudCoworkFirstOpenLaunchEnv(fixture) {
  return fixture.launchEnv;
}

export async function cleanupCloudCoworkFirstOpen(fixture) {
  await fixture?.cloud?.close();
}

/** The most calls of `calls` in flight at any one moment. */
function peakInFlight(calls) {
  const edges = calls.flatMap((call) => [
    { at: call.startedAt, delta: 1 },
    { at: call.endedAt ?? Number.POSITIVE_INFINITY, delta: -1 },
  ]);
  edges.sort((left, right) => left.at - right.at || left.delta - right.delta);
  let current = 0;
  let peak = 0;
  for (const edge of edges) {
    current += edge.delta;
    peak = Math.max(peak, current);
  }
  return peak;
}

/** Calls of `calls` running at any time in [from, to]. */
function overlapping(calls, from, to) {
  return calls.filter(
    (call) =>
      call.startedAt <= to &&
      (call.endedAt ?? Number.POSITIVE_INFINITY) >= from,
  );
}

/**
 * The first open's task record, as the harness's metrics read it. A completed
 * open is `ok` however long it took, so a slow sample still counts in the
 * timing metrics; the responsiveness check reports one over its budget.
 */
export function cloudCoworkFirstOpenTask(openMs, counters) {
  return {
    kind: 'cloud_cowork_first_open',
    status: 'ok',
    durationMs: openMs,
    responsivenessBudgetMs: CLOUD_COWORK_FIRST_OPEN_BUDGET_MS,
    summary: true,
    ...counters,
  };
}

export async function runCloudCoworkFirstOpen({ page, app, fixture, tasks }) {
  const { cloud, taskIds, openedTaskId } = fixture;
  await app.waitForShell({ timeout: 60_000 });
  await connectMockCloudAccount(page, 'csk_cloud_chats');
  const row = page
    .locator(`[data-worktree-id="web-core:${openedTaskId}"]`)
    .first();
  await expect(row).toBeVisible({ timeout: 60_000 });

  // The first open, right after the project's tasks listed.
  const clickedAt = Date.now();
  await row.click();
  await expect(page.getByTestId('cowork-top-workspace-name')).toHaveText(
    SEEDED_CLOUD_CHATS.workspaceName,
    { timeout: 30_000 },
  );
  await expect(
    page.getByTestId('chat-panel').first().getByRole('textbox').last(),
  ).toBeVisible({ timeout: 30_000 });
  const composerAt = Date.now();
  const openMs = composerAt - clickedAt;

  // The sweep reads each other task's archive (a task snapshot); wait until
  // every one has been answered, or report how far it got.
  const sweepTaskIds = new Set(
    taskIds.filter((taskId) => taskId !== openedTaskId),
  );
  const sweepReads = () =>
    cloud.calls.filter(
      (call) =>
        call.method === 'core.chat.snapshot.get' &&
        sweepTaskIds.has(String(call.worktreeId).toLowerCase()) &&
        call.endedAt !== null,
    );
  const sweepDone = await expect
    .poll(() => new Set(sweepReads().map((call) => call.worktreeId)).size, {
      timeout: SWEEP_SETTLE_TIMEOUT_MS,
    })
    .toBeGreaterThanOrEqual(sweepTaskIds.size)
    .then(
      () => true,
      () => false,
    );

  const snapshotCalls = cloud.calls.filter(
    (call) =>
      call.method === 'core.chat.snapshot.get' &&
      sweepTaskIds.has(String(call.worktreeId).toLowerCase()),
  );
  const duringOpen = overlapping(snapshotCalls, clickedAt, composerAt);
  const sweepStartedAt = Math.min(...snapshotCalls.map((c) => c.startedAt));
  const sweepEndedAt = Math.max(
    ...snapshotCalls.map((c) => c.endedAt ?? c.startedAt),
  );
  const counters = {
    cloudCoworkFirstOpenMs: openMs,
    cloudCoworkFirstOpenBudgetMs: CLOUD_COWORK_FIRST_OPEN_BUDGET_MS,
    cloudCoworkSweepReadsDuringOpen: duringOpen.length,
    cloudCoworkSweepPeakInFlight: peakInFlight(snapshotCalls),
    cloudCoworkSweepReads: snapshotCalls.length,
    cloudCoworkSweepTasks: sweepTaskIds.size,
    cloudCoworkSweepSettled: sweepDone,
    cloudCoworkSweepStartAfterClickMs:
      snapshotCalls.length === 0 ? null : sweepStartedAt - clickedAt,
    cloudCoworkSweepWindowMs:
      snapshotCalls.length === 0 ? null : sweepEndedAt - sweepStartedAt,
  };
  tasks.push(cloudCoworkFirstOpenTask(openMs, counters));
  return counters;
}
