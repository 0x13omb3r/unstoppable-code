/** @jest-environment jsdom */
/**
 * The composer's Usage popover shows cost in the host's units (CAN-6634): a
 * credits-only account reads credits and never USD, another account reads
 * AI Credits work as credits with USD alongside, a host without cost units
 * reads USD, and a cloud chat still hides its cost.
 *
 * A jsdom suite kept as a golden by the CAN-6634 exception in
 * docs/golden-tests.md: it mounts the real shared meter, popover and cost
 * row under the cost units the desktop provides.
 */
import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { UsageIndicator } from '../UsageIndicator';
import { CostCurrencyContext } from '../cost/CostCurrencyContext';
import { USD_COST_CURRENCY, type CostCurrency } from '../cost/cost-format';
import { UsageCostPreviewRow } from '../cost/UsageCostPreviewRow';

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);

const CREDITS_ONLY: CostCurrency = {
  kind: 'credits',
  usdPerCredit: 0.15,
  creditsOnly: true,
};
const MIXED: CostCurrency = {
  kind: 'credits',
  usdPerCredit: 0.15,
  creditsOnly: false,
};

// $0.45 of AI Credits work is 3 credits at $0.15 a credit.
const PREVIEW = {
  usd: 0.45,
  notPricedCount: 0,
  bySource: {
    chat: 0.36,
    pipeline: 0,
    subagents: 0.09,
    delegations: 0,
    background: 0,
  },
  byBilling: {
    subscription: 0,
    ai_credits: 0.45,
    account_proxy: 0,
    api_key: 0,
    org_gateway: 0,
    local: 0,
    unknown: 0,
  },
};

function Meter({
  currency,
  withPreview,
  hideCost = false,
}: {
  readonly currency: CostCurrency;
  readonly withPreview: boolean;
  readonly hideCost?: boolean;
}): JSX.Element {
  return (
    <CostCurrencyContext.Provider value={currency}>
      <UsageIndicator
        usage={{
          contextTokens: 0,
          contextWindow: 0,
          totalCostUsd: 0.45,
          inputTokens: 1000,
          outputTokens: 200,
          cacheReadInputTokens: 0,
          numTurns: 2,
          model: 'model',
        }}
        isCodex={false}
        hideCost={hideCost}
        {...(withPreview
          ? { costPreview: <UsageCostPreviewRow preview={PREVIEW} /> }
          : {})}
      />
    </CostCurrencyContext.Provider>
  );
}

let container: HTMLElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

/** Opens the meter's popover, which loads on first open, and returns its text. */
async function openPopover(element: JSX.Element): Promise<string> {
  await act(async () => {
    root.render(element);
    await Promise.resolve();
  });
  await act(async () => {
    document
      .querySelector<HTMLElement>('[data-testid="usage-indicator"]')
      ?.click();
    await Promise.resolve();
  });
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (document.querySelector('[data-testid="usage-indicator-details"]'))
      break;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  }
  if (!document.querySelector('[data-testid="usage-indicator-details"]'))
    throw new Error('The popover did not open');
  // The popover renders in the document, outside the meter.
  return document.body.textContent ?? '';
}

const costRow = (): string =>
  document.querySelector('[data-testid="usage-indicator-cost"]')?.textContent ??
  '';

describe('the Usage popover shows cost in the host units (CAN-6634)', () => {
  it('reads every amount in credits, never USD, for a credits-only account', async () => {
    await openPopover(<Meter currency={CREDITS_ONLY} withPreview />);
    expect(costRow()).toContain('3 credits');
    expect(costRow()).not.toContain('$');
    act(() => root.unmount());
    root = createRoot(container);
    // Without the host's cost row, the session's Cost reads the same way.
    const text = await openPopover(
      <Meter currency={CREDITS_ONLY} withPreview={false} />,
    );
    expect(text).toContain('3 credits');
    expect(text).not.toContain('$');
  });

  it('reads AI Credits work in credits with USD alongside for another account', async () => {
    // The cost row decides from the chat's recorded billing.
    await openPopover(<Meter currency={MIXED} withPreview />);
    expect(costRow()).toContain('3 credits · $0.45');
    act(() => root.unmount());
    root = createRoot(container);
    // Without it, the session's Cost has no billing to go by and reads USD.
    const session = await openPopover(
      <Meter currency={MIXED} withPreview={false} />,
    );
    expect(session).toContain('$0.45');
    expect(session).not.toContain('credits');
  });

  it('reads USD for a host without cost units', async () => {
    await openPopover(<Meter currency={USD_COST_CURRENCY} withPreview />);
    expect(costRow()).toContain('$0.45');
    expect(costRow()).not.toContain('credits');
  });

  it('still hides a cloud chat’s cost', async () => {
    const text = await openPopover(
      <Meter currency={CREDITS_ONLY} withPreview hideCost />,
    );
    expect(document.querySelector('[data-testid="usage-indicator-cost"]')).toBe(
      null,
    );
    expect(text).not.toContain('credits');
    expect(text).not.toContain('$');
  });
});
