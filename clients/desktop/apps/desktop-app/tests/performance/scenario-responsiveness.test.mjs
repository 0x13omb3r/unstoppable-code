import assert from 'node:assert/strict';
import test from 'node:test';
import { RESPONSIVENESS_THRESHOLDS } from './profiles.mjs';
import {
  assessResponsiveness,
  SCENARIO_FRAME_DELAY_CEILING_MS,
  SCENARIO_RESPONSIVENESS_THRESHOLDS,
  scenarioResponsivenessThresholds,
} from './responsiveness.mjs';

const SCENARIO = 'cloud-cowork-first-open';

// Worst animation-frame delay of every measured sample of the scenario, both
// sides, from the matched E2E-build pairs on the hosted macOS runner.
const MEASURED_FRAME_DELAY_MAX_MS = Object.freeze([
  // Pair 1, run 43580874538: baseline, then candidate.
  166.6, 180.6, 149.0, 116.7, 167.9, 250.0, 166.6, 165.4, 216.6, 151.2, 216.5,
  236.2, 166.6, 150.0,
  // Pair 2, run 43582613105: baseline, then candidate.
  150.1, 151.8, 133.7, 132.5, 233.3, 133.1, 233.3, 115.9, 233.7, 167.3, 184.9,
  251.5, 133.2, 236.5,
]);

function frameDelayOnly(maxMs) {
  return { rendererFrameDelayMs: { max: maxMs } };
}

function frameDelayVerdict(maxMs, thresholds) {
  return assessResponsiveness(frameDelayOnly(maxMs), thresholds);
}

test('measured first-open samples fail the default frame-delay budget', () => {
  for (const maxMs of MEASURED_FRAME_DELAY_MAX_MS)
    assert.equal(
      frameDelayVerdict(maxMs, RESPONSIVENESS_THRESHOLDS).passed,
      false,
      `${maxMs} ms`,
    );
});

test('measured first-open samples pass the scenario frame-delay budget', () => {
  const thresholds = scenarioResponsivenessThresholds(
    SCENARIO,
    RESPONSIVENESS_THRESHOLDS,
  );
  for (const maxMs of MEASURED_FRAME_DELAY_MAX_MS)
    assert.equal(
      frameDelayVerdict(maxMs, thresholds).passed,
      true,
      `${maxMs} ms`,
    );
});

test('a first-open frame stall past the scenario budget is unresponsive', () => {
  const thresholds = scenarioResponsivenessThresholds(
    SCENARIO,
    RESPONSIVENESS_THRESHOLDS,
  );
  const overBudget = frameDelayVerdict(
    thresholds.rendererFrameDelayMaxMs + 1,
    thresholds,
  );
  assert.equal(overBudget.passed, false);
  assert.deepEqual(
    overBudget.violations.map((violation) => violation.metric),
    ['renderer.frame_delay.max_ms'],
  );
  const hung = frameDelayVerdict(
    SCENARIO_FRAME_DELAY_CEILING_MS + 200,
    thresholds,
  );
  assert.equal(hung.passed, false);
});

test('the scenario budget relaxes only the frame delay', () => {
  const thresholds = scenarioResponsivenessThresholds(
    SCENARIO,
    RESPONSIVENESS_THRESHOLDS,
  );
  for (const [key, value] of Object.entries(RESPONSIVENESS_THRESHOLDS))
    if (key !== 'rendererFrameDelayMaxMs')
      assert.equal(thresholds[key], value, key);
  assert.ok(
    thresholds.rendererFrameDelayMaxMs <= SCENARIO_FRAME_DELAY_CEILING_MS,
  );
});

test('every other scenario, and a release-like run, keep the defaults', () => {
  assert.deepEqual(Object.keys(SCENARIO_RESPONSIVENESS_THRESHOLDS), [SCENARIO]);
  for (const name of ['startup-settle', 'sidebar-reorder', 'chat-switch'])
    assert.equal(
      scenarioResponsivenessThresholds(name, RESPONSIVENESS_THRESHOLDS),
      RESPONSIVENESS_THRESHOLDS,
      name,
    );
  assert.equal(
    scenarioResponsivenessThresholds(SCENARIO, RESPONSIVENESS_THRESHOLDS, {
      releaseLike: true,
    }),
    RESPONSIVENESS_THRESHOLDS,
  );
});

test('a scenario budget past the hard ceiling or for another check is refused', () => {
  assert.throws(
    () =>
      scenarioResponsivenessThresholds(SCENARIO, RESPONSIVENESS_THRESHOLDS, {
        overrides: {
          [SCENARIO]: {
            rendererFrameDelayMaxMs: SCENARIO_FRAME_DELAY_CEILING_MS + 1,
          },
        },
      }),
    /ceiling/,
  );
  assert.throws(
    () =>
      scenarioResponsivenessThresholds(SCENARIO, RESPONSIVENESS_THRESHOLDS, {
        overrides: { [SCENARIO]: { rendererLongTaskMaxMs: 200 } },
      }),
    /only the frame-delay/,
  );
  assert.throws(
    () =>
      scenarioResponsivenessThresholds(SCENARIO, RESPONSIVENESS_THRESHOLDS, {
        overrides: { [SCENARIO]: { rendererFrameDelayMaxMs: 50 } },
      }),
    /below the default/,
  );
});
