import { useState, type JSX, type ReactNode } from 'react';
import {
  Surface,
  Checkbox,
  ChoiceField,
  ChoiceMark,
  PageHeader,
  Radio,
} from '@canopy/ui-shared/components';

/**
 * The shared `Checkbox`, `Radio`, and `ChoiceMark` (question forms lab,
 * "Choices" view) in every state, standalone and as option rows, on both
 * surfaces a choice lands on: inside the raised tertiary question card and on
 * an ordinary base page.
 */

function States(): JSX.Element {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-4">
        <span className="w-18 text-s fg-tertiary">Checkbox</span>
        <Checkbox aria-label="Checkbox off" checked={false} readOnly />
        <Checkbox aria-label="Checkbox on" checked readOnly />
        <Checkbox
          aria-label="Checkbox off, disabled"
          checked={false}
          disabled
          readOnly
        />
        <Checkbox
          aria-label="Checkbox on, disabled"
          checked
          disabled
          readOnly
        />
      </div>
      <div className="flex items-center gap-4">
        <span className="w-18 text-s fg-tertiary">Radio</span>
        <Radio aria-label="Radio off" checked={false} readOnly />
        <Radio aria-label="Radio on" checked readOnly />
        <Radio
          aria-label="Radio off, disabled"
          checked={false}
          disabled
          readOnly
        />
        <Radio aria-label="Radio on, disabled" checked disabled readOnly />
      </div>
      <div className="flex items-center gap-4">
        <span className="w-18 text-s fg-tertiary">Mark</span>
        <ChoiceMark kind="checkbox" checked={false} />
        <ChoiceMark kind="checkbox" checked />
        <ChoiceMark kind="radio" checked={false} />
        <ChoiceMark kind="radio" checked />
      </div>
    </div>
  );
}

const ROW_LABELS = ['Search', 'Analytics', 'Team spaces'] as const;
function Rows({ multi }: { multi: boolean }): JSX.Element {
  const [picked, setPicked] = useState<readonly string[]>(['Analytics']);
  const toggle = (label: string): void =>
    setPicked((current) =>
      multi
        ? current.includes(label)
          ? current.filter((entry) => entry !== label)
          : [...current, label]
        : [label],
    );
  return (
    <div className="-mx-2 flex flex-col gap-0.5">
      {ROW_LABELS.map((label) => (
        <ChoiceField
          key={label}
          kind={multi ? 'checkbox' : 'radio'}
          layout="row"
          label={label}
          name={multi ? undefined : 'lab-radio-rows'}
          checked={picked.includes(label)}
          onChange={() => toggle(label)}
        />
      ))}
    </div>
  );
}

function ChoicePreview({
  label,
  variant,
  children,
}: {
  label: string;
  variant: 'raised' | 'inset';
  children: ReactNode;
}): JSX.Element {
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-1.5">
      <span className="px-1 text-xs fg-tertiary">{label}</span>
      <Surface variant={variant} padding="compact" gap="item">
        {children}
      </Surface>
    </div>
  );
}

function Contents(): JSX.Element {
  return (
    <>
      <States />
      <Rows multi />
      <Rows multi={false} />
    </>
  );
}

export function ChoiceOptionsLab(): JSX.Element {
  return (
    <div
      className="flex flex-col gap-6 p-6 text-pretty"
      data-testid="choice-options-lab"
    >
      <PageHeader
        inset="none"
        title="Checkbox and radio"
        description="The shared Checkbox, Radio, and ChoiceMark. Click the rows to toggle them, or Tab to see the focus halo."
      />
      <div className="flex flex-col gap-3 md:flex-row">
        <ChoicePreview label="In the question card" variant="raised">
          <Contents />
        </ChoicePreview>
        <ChoicePreview label="On a page" variant="inset">
          <Contents />
        </ChoicePreview>
      </div>
    </div>
  );
}
