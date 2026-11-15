/**
 * A package upload under a caller's budget (CAN-6176): a cloud chat's send
 * republishes a skill's package within its own short wait. Once that budget
 * is spent, the upload starts no further request, not a blob, a retry or
 * the commit, so nothing reaches the cloud after the send stopped waiting.
 */
import type { PipelinePackageManifestV1 } from '@canopy/protocol/pipelines';
import type * as PackageService from '../pipeline-package-service';

const calls: string[] = [];
let prepared: () => void = () => undefined;

// The client sits in an import cycle with main's other modules, so it is
// loaded whole first, then mocked over that loaded copy, and the service
// under test is loaded afresh against the mock.
const actualClient: Record<string, unknown> = jest.requireActual(
  '../canopy-server-client',
);
jest.resetModules();
jest.doMock('../canopy-server-client', () => ({
  ...actualClient,
  preparePipelinePackageUpload: (): Promise<unknown> => {
    calls.push('prepare');
    // Preparation outlasts the send's wait.
    return new Promise((resolve) => {
      prepared = (): void =>
        resolve({ uploadId: 'upload-1', missingBlobs: ['a'.repeat(64)] });
    });
  },
  uploadPipelinePackageBlob: (): Promise<void> => {
    calls.push('blob');
    return Promise.resolve();
  },
  commitPipelinePackageUpload: (): Promise<unknown> => {
    calls.push('commit');
    return Promise.resolve({ uploadId: 'upload-1', digest: 'pp:v1:x' });
  },
}));
const { commitCapabilityPackageUpload } = jest.requireActual<
  typeof PackageService
>('../pipeline-package-service');

const CONTEXT = {
  baseUrl: 'https://cloud.example',
  apiKey: 'key-acct-1',
} as const;

const MANIFEST: PipelinePackageManifestV1 = {
  version: 1,
  pipelineContentHash: 'b'.repeat(64),
  resources: [],
  bindings: [],
  environmentRequirements: [],
  totalFiles: 0,
  totalBytes: 0,
};

describe('a package upload under a caller budget (CAN-6176)', () => {
  beforeEach(() => {
    calls.length = 0;
  });

  it('starts no blob upload or commit once the budget is spent during preparation', async () => {
    let spent = false;
    const upload = commitCapabilityPackageUpload(
      MANIFEST,
      () => new Uint8Array([1]),
      undefined,
      undefined,
      CONTEXT,
      () => {
        if (spent) throw new Error('The send stopped waiting.');
      },
    ).then(
      () => 'committed',
      () => 'stopped',
    );
    await new Promise((resolve) => setImmediate(resolve));
    expect(calls).toEqual(['prepare']);
    spent = true;
    prepared();
    await expect(upload).resolves.toBe('stopped');
    expect(calls).toEqual(['prepare']);
  });

  it('starts nothing at all when the budget is already spent', async () => {
    await expect(
      commitCapabilityPackageUpload(
        MANIFEST,
        () => new Uint8Array([1]),
        undefined,
        undefined,
        CONTEXT,
        () => {
          throw new Error('The send stopped waiting.');
        },
      ),
    ).rejects.toThrow('stopped waiting');
    expect(calls).toEqual([]);
  });
});
