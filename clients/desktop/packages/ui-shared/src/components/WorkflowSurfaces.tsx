import type { ComponentPropsWithRef, JSX } from 'react';

type DivProps = Omit<ComponentPropsWithRef<'div'>, 'className'>;

export function WorkflowNavFrame({
  preview,
  ...props
}: DivProps & { readonly preview: boolean }): JSX.Element {
  return (
    <div
      {...props}
      className={
        preview
          ? 'absolute inset-y-0 left-0 z-10 flex min-h-0 shadow-xl transition-[opacity,translate] duration-150 ease-out starting:-translate-x-2 starting:opacity-0 motion-reduce:transition-none'
          : 'flex min-h-0 shrink-0'
      }
    />
  );
}

/** Activity plan container, including its independent action controls. */
export function ActivityPlanCard(props: DivProps): JSX.Element {
  return (
    <div
      {...props}
      className="group/plan focus-ring relative flex w-full cursor-pointer flex-col gap-2 rounded-lg border bg-fg-primary/[0.03] p-3 text-left transition-colors hover:bg-fg-primary/[0.06]"
    />
  );
}

export function WorkflowReportRegion(props: DivProps): JSX.Element {
  return <div {...props} className="focus-ring focus-ring-inset rounded-xl" />;
}

export function WorkflowCreateCluster(props: DivProps): JSX.Element {
  return (
    <div
      {...props}
      className="inline-flex h-7 items-stretch rounded-full bg-accent fg-emphasis"
    />
  );
}

export function SplitActionDivider(): JSX.Element {
  return (
    <span
      aria-hidden="true"
      className="h-4 w-px self-center bg-current opacity-30"
    />
  );
}

export function AdvisorCodeExcerpt(
  props: Omit<ComponentPropsWithRef<'span'>, 'className'>,
): JSX.Element {
  return (
    <span className="block py-1">
      <span
        {...props}
        className="block overflow-x-auto rounded bg-fg-primary/[0.06] p-2 font-mono text-xs fg-primary/85"
      />
    </span>
  );
}
