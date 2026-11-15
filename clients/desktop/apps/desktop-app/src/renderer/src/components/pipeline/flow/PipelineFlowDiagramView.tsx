import type { ComponentProps } from 'react';
import {
  WorkflowNodeSurface,
  WorkflowNodeSection,
} from '@canopy/ui-shared/components';
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  type JSX,
} from 'react';
import {
  Background,
  Controls,
  Handle,
  Position,
  ReactFlow,
  useReactFlow,
  useStore,
  type FitViewOptions,
  type NodeProps,
  type NodeTypes,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import type {
  Pipeline,
  ExecutionState,
} from '@canopy/execution-engine/types/pipeline';
import {
  buildDefinitionFlow,
  buildExecutionFlow,
  MATRIX_SUMMARY_ROW_HEIGHT,
  JOB_HEADER_HEIGHT,
  STEP_ROW_GAP,
  STEP_ROW_HEIGHT,
  STEP_LIST_PADDING_BOTTOM,
  STEP_LIST_PADDING_TOP,
  type PipelineFlowMatrixSummary,
  type PipelineFlowStatus,
  type PipelineJobNode,
} from '@/lib/pipelineFlowGraph';
import { runStatusGlyphState } from '@canopy/ui-shared/lib';
import { Button, EmptyState, StatusGlyph } from '@canopy/ui-shared/components';
import { PlusIcon, SparkleIcon } from '@canopy/ui-shared/icons/AppIcons';

const STATUS_TONE: Record<
  PipelineFlowStatus,
  ComponentProps<typeof WorkflowNodeSurface>['tone']
> = {
  success: 'success',
  failure: 'failed',
  running: 'active',
  restarting: 'active',
  paused: 'paused',
  queued: 'neutral',
  pending: 'neutral',
  cancelled: 'neutral',
  skipped: 'neutral',
  none: 'neutral',
};

/**
 * A node's status mark: the shared status glyph, or nothing for a node with
 * no run yet (the definition view), so an unrun workflow carries no marks.
 */
function FlowStatusGlyph({
  status,
  size,
}: {
  readonly status: PipelineFlowStatus;
  readonly size: 12 | 14;
}): JSX.Element | null {
  const state = runStatusGlyphState(status);
  return state === null ? null : <StatusGlyph state={state} size={size} />;
}

interface FlowInteraction {
  onSelectJob?: (jobId: string) => void;
  onSelectStep?: (jobId: string, stepIndex: number) => void;
  onAddStep?: (jobId: string) => void;
}

const FlowInteractionContext = createContext<FlowInteraction>({});

/**
 * Matrix summary lines rendered inside one authored logical DAG node.
 */
function MatrixSummaryBody({
  jobId,
  summary,
}: {
  jobId: string;
  summary: PipelineFlowMatrixSummary;
}): JSX.Element | null {
  const lines = [
    summary.expandingLabel,
    summary.emptyLabel,
    summary.variantCountLabel,
    summary.completionLabel,
    summary.breakdownLabel,
    summary.maxParallelLabel,
  ].filter((line): line is string => line !== undefined && line !== '');

  if (lines.length === 0) {
    return null;
  }

  return (
    <WorkflowNodeSection
      kind="matrix"
      top={STEP_LIST_PADDING_TOP}
      bottom={STEP_LIST_PADDING_BOTTOM}
      data-testid={`pipeline-flow-matrix-summary-${jobId}`}
    >
      {lines.map((line) => (
        <span
          key={line}
          className="truncate text-3xs fg-secondary"
          style={{ height: MATRIX_SUMMARY_ROW_HEIGHT }}
        >
          {line}
        </span>
      ))}
    </WorkflowNodeSection>
  );
}

function PipelineJobNodeView({
  data,
  sourcePosition,
  targetPosition,
}: NodeProps<PipelineJobNode>): JSX.Element {
  const { onSelectJob, onSelectStep, onAddStep } = useContext(
    FlowInteractionContext,
  );
  return (
    <WorkflowNodeSurface
      tone={STATUS_TONE[data.status]}
      selected={data.selected}
    >
      <Handle
        type="target"
        position={targetPosition ?? Position.Top}
        className="!opacity-0"
      />
      <button
        type="button"
        className="nodrag flex shrink-0 items-center gap-2 px-3 text-left transition-colors hover:bg-fg-primary/[0.04]"
        style={{ height: JOB_HEADER_HEIGHT }}
        onClick={(e): void => {
          e.stopPropagation();
          onSelectJob?.(data.jobId);
        }}
      >
        <FlowStatusGlyph status={data.status} size={14} />
        <span className="min-w-0 flex-1 truncate text-xs font-semibold fg-primary">
          {data.label}
        </span>
        {data.matrix !== undefined && (
          <span className="shrink-0 font-mono text-3xs fg-secondary">
            matrix
          </span>
        )}
        {data.steps.length > 0 && (
          <span className="shrink-0 text-3xs fg-secondary">
            {data.steps.length}
          </span>
        )}
      </button>
      {data.matrix !== undefined && (
        <MatrixSummaryBody jobId={data.jobId} summary={data.matrix} />
      )}
      {(data.steps.length > 0 || data.canAddStep === true) && (
        <WorkflowNodeSection
          kind="steps"
          top={STEP_LIST_PADDING_TOP}
          bottom={STEP_LIST_PADDING_BOTTOM}
          rowGap={STEP_ROW_GAP}
        >
          {data.steps.map((step) => {
            const stepSelected = data.selectedStepIndex === step.stepIndex;
            const stepClass = stepSelected
              ? 'border-line-accent bg-accent-subtle'
              : 'bg-fg-primary/[0.03] hover:bg-fg-primary/[0.07]';
            return (
              <button
                key={step.stepIndex}
                type="button"
                className={`nodrag flex shrink-0 items-center gap-2 rounded border px-2 text-left transition-colors ${stepClass}`}
                style={{ height: STEP_ROW_HEIGHT }}
                onClick={(e): void => {
                  e.stopPropagation();
                  onSelectStep?.(data.jobId, step.stepIndex);
                }}
              >
                <FlowStatusGlyph status={step.status} size={12} />
                <span className="min-w-0 flex-1 truncate text-2xs fg-primary/80">
                  {step.label}
                </span>
              </button>
            );
          })}
          {data.canAddStep === true && onAddStep && (
            // `nodrag` keeps React Flow from treating the press as a drag.
            <div className="nodrag flex shrink-0">
              <Button
                variant="ghost"
                size="compact"
                data-testid="pipeline-flow-add-step"
                onClick={(e): void => {
                  e.stopPropagation();
                  onAddStep(data.jobId);
                }}
              >
                <PlusIcon size="xs" aria-hidden="true" />
                Add step
              </Button>
            </div>
          )}
        </WorkflowNodeSection>
      )}
      <Handle
        type="source"
        position={sourcePosition ?? Position.Bottom}
        className="!opacity-0"
      />
    </WorkflowNodeSurface>
  );
}

const NODE_TYPES: NodeTypes = { pipelineJob: PipelineJobNodeView };

/**
 * Space a fitted graph keeps from the diagram's edges. The left side also
 * reserves the zoom controls' column (a 15px inset plus 26px buttons, and a
 * gutter), so no fitted node sits under them at any width.
 */
const PIPELINE_FLOW_FIT_VIEW_OPTIONS: FitViewOptions = {
  padding: { top: '16px', right: '16px', bottom: '16px', left: '56px' },
};

/**
 * Fits the graph again whenever the diagram's own size changes: a panel
 * resized, its job list collapsed, a hidden panel shown at a new width.
 * React Flow fits once, when the nodes are first measured, so a graph fitted
 * at one width is otherwise cut off at another. It reads the size React Flow
 * already observes, and fitting moves only the viewport, never the size, so
 * it cannot loop. A new run state at the same size does not refit, so a
 * user's own zoom survives live updates.
 *
 * Not gated on `useNodesInitialized`: with controlled nodes and no
 * `onNodesChange`, that flag only turns true on a later node update. React
 * Flow queues the fit and applies it once the nodes are measured.
 */
function FitViewOnResize(): null {
  const width = useStore((state) => state.width);
  const height = useStore((state) => state.height);
  const { fitView } = useReactFlow();
  const fittedSizeRef = useRef<string | null>(null);
  useEffect(() => {
    if (width <= 0 || height <= 0) return;
    const size = `${width}x${height}`;
    if (fittedSizeRef.current === size) return;
    fittedSizeRef.current = size;
    void fitView(PIPELINE_FLOW_FIT_VIEW_OPTIONS);
  }, [fitView, height, width]);
  return null;
}

export type PipelineFlowSource =
  | { kind: 'definition'; pipeline: Pipeline; jobOrder: string[] }
  | { kind: 'execution'; state: ExecutionState; jobOrder: string[] };

export type PipelineFlowSelection =
  | { type: 'job'; jobId: string }
  | { type: 'step'; jobId: string; stepIndex: number };

export function PipelineFlowDiagram({
  source,
  selection,
  onSelectJob,
  onSelectStep,
  onAddStep,
  onAddFirstJob,
  onAskAssistant,
}: {
  source: PipelineFlowSource;
  selection?: PipelineFlowSelection;
  onSelectJob?: (jobId: string) => void;
  onSelectStep?: (jobId: string, stepIndex: number) => void;
  /**
   * An editable flow (CAN-4319): the selected job offers `Add step` under its
   * steps.
   */
  onAddStep?: (jobId: string) => void;
  /** An editable flow with no jobs offers its first one. */
  onAddFirstJob?: () => void;
  /**
   * An empty flow points at the assistant beside it (CAN-4319): its first
   * action puts the cursor in the assistant's composer.
   */
  onAskAssistant?: () => void;
}): JSX.Element {
  const addStepJobId = onAddStep ? selection?.jobId : undefined;
  const { nodes, edges } = useMemo(() => {
    const flow =
      source.kind === 'definition'
        ? buildDefinitionFlow(
            source.pipeline,
            source.jobOrder,
            undefined,
            addStepJobId !== undefined ? { addStepJobId } : {},
          )
        : buildExecutionFlow(source.state, source.jobOrder);
    return {
      edges: flow.edges,
      nodes: flow.nodes.map((node) => ({
        ...node,
        data: {
          ...node.data,
          selected:
            selection?.type === 'job' && selection.jobId === node.data.jobId,
          selectedStepIndex:
            selection?.type === 'step' && selection.jobId === node.data.jobId
              ? selection.stepIndex
              : undefined,
        },
      })),
    };
  }, [addStepJobId, selection, source]);

  const interaction = useMemo<FlowInteraction>(
    () => ({ onSelectJob, onSelectStep, onAddStep }),
    [onAddStep, onSelectJob, onSelectStep],
  );

  if (onAddFirstJob && source.kind === 'definition' && nodes.length === 0) {
    return (
      <div
        className="flex h-full items-center justify-center p-6"
        data-testid="pipeline-flow-empty"
      >
        <EmptyState
          title="No jobs yet"
          subtitle="Tell the assistant what it should do, and it builds the flow here."
          action={
            <div className="flex flex-wrap items-center justify-center gap-2">
              {onAskAssistant ? (
                <Button
                  variant="primary"
                  size="compact"
                  onClick={onAskAssistant}
                  data-testid="pipeline-flow-ask-assistant"
                >
                  <SparkleIcon aria-hidden="true" />
                  Describe it to the assistant
                </Button>
              ) : null}
              <Button
                variant="secondary"
                size="compact"
                onClick={onAddFirstJob}
                data-testid="pipeline-flow-add-first-job"
              >
                <PlusIcon aria-hidden="true" />
                Add the first job
              </Button>
            </div>
          }
        />
      </div>
    );
  }

  return (
    <FlowInteractionContext.Provider value={interaction}>
      <ReactFlow<PipelineJobNode>
        nodes={nodes}
        edges={edges}
        nodeTypes={NODE_TYPES}
        fitView
        fitViewOptions={PIPELINE_FLOW_FIT_VIEW_OPTIONS}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable
        proOptions={{ hideAttribution: true }}
      >
        <Background />
        <Controls
          showInteractive={false}
          fitViewOptions={PIPELINE_FLOW_FIT_VIEW_OPTIONS}
        />
        <FitViewOnResize />
      </ReactFlow>
    </FlowInteractionContext.Provider>
  );
}
