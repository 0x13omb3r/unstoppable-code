import {
  isSharedContainerForkProvenance,
  type SharedContainerForkProvenance,
  type SharedContainerForkRequest,
  type SharedContainerForkResponse,
} from '@canopy/protocol/shared-containers';
import { getSharedContainerReader } from '../read/reader';
import { forkSharedCodeContainer } from './code';
import { forkSharedCoworkContainer } from './cowork';
import { withSharedContainerForkGuard } from './fork-guard';
import { installForkCapabilityPackage } from '../capability-package/install';
import { z } from 'zod';
import { validateId } from '../../lib/validation';
import {
  SharedContainerForkError,
  validateForkDestination,
  resolveForkSourceContext,
  assertNewForkOwner,
  assertForkWorkspaceOwner,
} from './destination';
import {
  runW5BoundaryOperation,
  w5ExpectedRevision,
  type W5BoundaryOptions,
} from '../../lib/w5-boundary-operation';
import { W5RevisionConflictError } from '../../lib/w5-commit-log-file-store';
import {
  admitW5Composition,
  checkW5CompositionRevisions,
  decodeW5CompositionOutcome,
} from '../../lib/w5-composition-operation';
import {
  w5LifecycleReceiptCaller,
  type W5WireCall,
} from '../../lib/w5-wire-call';

const forkOutcomeSchema = z.object({
  containerType: z.enum(['CODE_WORKTREE', 'COWORK_WORK_ENTRY']),
  projectId: z.string(),
  worktreeId: z.string(),
  warnings: z.array(z.string()),
  provenance: z.custom<SharedContainerForkProvenance>(
    isSharedContainerForkProvenance,
  ),
});
export type SharedContainerForkCommand = SharedContainerForkRequest &
  W5BoundaryOptions & {
    /** A registered wire call's receipt scope and admission (W7b-4). */
    wireCall?: W5WireCall;
  };

type ForkSourceContext = Awaited<ReturnType<typeof resolveForkSourceContext>>;

interface ValidatedForkCommand {
  request: SharedContainerForkCommand;
  authorize: () => Promise<ForkSourceContext>;
  /** IPC's context, authorized before the boundary; wire calls admit inside. */
  sourceContext?: ForkSourceContext;
}

/**
 * New organization copies running over IPC, by submission (CAN-4856). An
 * identical submission while one runs joins it instead of starting a second
 * copy, so both callers get the same response (or refusal) and the copy and
 * its package install happen once. The publication's project reservation
 * stays the backstop for anything that does not join.
 */
const organizationCopiesInFlight = new Map<
  string,
  Promise<SharedContainerForkResponse>
>();

/**
 * Only an identical, already-authorized new organization copy joins, of any
 * shape: single-repo and Cowork copies join too, as the CAN-4856 inventory
 * records. The key deliberately leaves out `idempotencyKey` (each submission
 * mints its own, so keying on it would never join a repeated one) and
 * `expectedRevision` (both callers want the same copy; the joiner takes the
 * running copy's outcome instead of a revision conflict against it).
 */
function organizationCopyFlightKey(
  validated: ValidatedForkCommand,
): string | undefined {
  const { request, sourceContext } = validated;
  const { destination } = request;
  if (
    request.wireCall ||
    !sourceContext ||
    destination.kind !== 'new-workspace' ||
    sourceContext.owner.kind !== 'organization'
  )
    return undefined;
  return JSON.stringify([
    sourceContext.organizationId ?? null,
    request.containerId,
    request.revisionId,
    destination.owner,
    destination.parentDirectory ?? null,
    request.expectedPackageDigest ?? null,
  ]);
}

/** IPC keeps its post-copy install; wire calls save the install warnings too. */
export async function forkSharedContainer(
  request: SharedContainerForkCommand,
): Promise<SharedContainerForkResponse> {
  const validated = validateForkCommand(request);
  // IPC retains its receipt bytes and admission; wire identity is
  // request-only. Each caller authorizes on its own before it may join.
  if (!validated.request.wireCall) {
    const sourceContext = await validated.authorize();
    validated.sourceContext = sourceContext;
    validated.request = {
      ...validated.request,
      organizationId: sourceContext.organizationId,
    };
  }
  const run = async (): Promise<SharedContainerForkResponse> => {
    const response = await forkSharedContainerCopy(validated);
    return validated.request.wireCall
      ? response
      : installForkPackage(validated.request, response);
  };
  const flightKey = organizationCopyFlightKey(validated);
  if (flightKey === undefined) return run();
  const running = organizationCopiesInFlight.get(flightKey);
  if (running) return running;
  const flight = run().finally((): void => {
    if (organizationCopiesInFlight.get(flightKey) === flight)
      organizationCopiesInFlight.delete(flightKey);
  });
  organizationCopiesInFlight.set(flightKey, flight);
  return flight;
}

async function installForkPackage(
  request: SharedContainerForkCommand,
  response: SharedContainerForkResponse,
): Promise<SharedContainerForkResponse> {
  const warnings = await installForkCapabilityPackage({ request, response });
  return warnings.length > 0
    ? { ...response, warnings: [...response.warnings, ...warnings] }
    : response;
}

function validateForkCommand(
  request: SharedContainerForkCommand,
): ValidatedForkCommand {
  validateId(request.containerId, 'containerId');
  validateId(request.revisionId, 'revisionId');
  if (
    typeof request.sourceOwnerDisplayName !== 'string' ||
    !request.sourceOwnerDisplayName.trim() ||
    request.sourceOwnerDisplayName.length > 256
  ) {
    throw new Error('Invalid sourceOwnerDisplayName');
  }
  const destination = validateForkDestination(request.destination);
  const validated: SharedContainerForkCommand = { ...request, destination };
  const authorize = async (): Promise<ForkSourceContext> => {
    await validated.wireCall?.admit?.();
    const context = await resolveForkSourceContext(validated);
    if (destination.kind === 'new-workspace') {
      assertNewForkOwner(destination, context.owner);
    } else {
      await assertForkWorkspaceOwner(destination.workspaceId, context.owner);
    }
    return context;
  };
  return { request: validated, authorize };
}

async function forkSharedContainerCopy(
  validated: ValidatedForkCommand,
): Promise<SharedContainerForkResponse> {
  let { request, sourceContext } = validated;
  const { authorize } = validated;
  const { expectedRevision, idempotencyKey } = request;
  return runW5BoundaryOperation(
    {
      operation: 'core.sharedContainer.fork',
      caller: w5LifecycleReceiptCaller(
        'shared-container-fork',
        request.wireCall,
      ),
      idempotencyKey,
      admit: request.wireCall
        ? async () => {
            sourceContext = await authorize();
          }
        : undefined,
      parameters: {
        containerId: request.containerId,
        revisionId: request.revisionId,
        organizationId: request.organizationId,
        sourceOwnerDisplayName: request.sourceOwnerDisplayName,
        ...(request.wireCall
          ? { expectedPackageDigest: request.expectedPackageDigest }
          : {
              owner: sourceContext?.owner,
              acceptedAt: sourceContext?.acceptedAt,
            }),
        destination:
          request.destination.kind === 'existing-workspace'
            ? {
                kind: request.destination.kind,
                workspaceId: request.destination.workspaceId,
              }
            : {
                kind: request.destination.kind,
                owner: request.destination.owner,
                parentDirectory: request.destination.parentDirectory,
              },
      },
      recheckAtOutcome: true,
      // Only a refusal before the attempt's first effect releases the
      // reservation. Organization refusals can follow promotion, but both
      // creation paths call `beforeEffects` (directly, or through the
      // workspace creation commit) before their first effect, so those are
      // kept for recovery instead.
      isPreEffectRefusal: (error) =>
        error instanceof W5RevisionConflictError ||
        error instanceof SharedContainerForkError,
    },
    (outcome) => decodeW5CompositionOutcome(forkOutcomeSchema, outcome),
    async (commit, attempt) => {
      const context = sourceContext ?? (await authorize());
      request = { ...request, organizationId: context.organizationId };
      commit.expectedRevisions = w5ExpectedRevision(
        { kind: 'workspaces' },
        expectedRevision,
      );
      await checkW5CompositionRevisions(commit);
      const response = await admitW5Composition(attempt, () =>
        withSharedContainerForkGuard(
          request,
          async (revisionRoot, revision) => {
            const reader = getSharedContainerReader();
            const source = await reader.readForkLayout({
              containerId: request.containerId,
              revisionId: request.revisionId,
            });
            if (source.root !== revisionRoot) {
              throw new Error('Shared-container revision changed during fork');
            }
            // Layout validation can outlive a revocation or ownership change.
            // Authorize after that read, immediately before dispatching effects.
            const latestContext = await resolveForkSourceContext(request);
            if (
              latestContext.acceptedAt !== context.acceptedAt ||
              latestContext.access !== context.access
            ) {
              throw new SharedContainerForkError(
                'source-unavailable',
                'The share’s access changed. Open the share again before making a copy.',
              );
            }
            if (request.destination.kind === 'existing-workspace') {
              await assertForkWorkspaceOwner(
                request.destination.workspaceId,
                context.owner,
              );
            }
            const provenance = {
              sourceContainerId: request.containerId,
              sourceRevisionId: revision.revisionId,
              sourceRevisionCreatedAt: revision.revisionCreatedAt,
              sourceOwnerDisplayName: request.sourceOwnerDisplayName,
              ...(request.organizationId !== undefined
                ? { organizationId: request.organizationId }
                : {}),
              forkedAt: new Date().toISOString(),
            };
            const options = {
              request,
              owner: context.owner,
              organizationName: latestContext.organizationName,
              provenance,
              revisionRoot,
              layout: source.layout,
              store: reader.store,
              commit,
              attempt,
            };
            if (source.layout.containerType === 'CODE_WORKTREE') {
              return forkSharedCodeContainer({
                ...options,
                layout: source.layout,
              });
            }
            if (source.layout.schemaVersion === 2) {
              throw new Error(
                'Cowork shared-container layout cannot use schema v2',
              );
            }
            return forkSharedCoworkContainer({
              ...options,
              layout: source.layout,
            });
          },
        ),
      );
      if (!request.wireCall) return response;
      attempt?.beforeEffects();
      return installForkPackage(request, response);
    },
  );
}
