import {
  WORKER_ARTIFACT_DOWNLOAD_CHUNK_MAX_BYTES,
  WorkerArtifactDownloadReadResultSchema,
} from '@canopy/protocol/canopy-core';
import {
  mediaTypeForAttachmentFilename,
  type CloudAttachmentMediaType,
} from '@canopy/protocol/cloud-attachments';
import { reportClientAppError } from '@canopy/desktop-instrumentation/client';
import type { CanopyCoreRelayApi } from '../../../shared/canopy-core-relay';
import {
  cloudAttachmentIdOfPath,
  cloudAttachmentPreview,
  rememberCloudAttachmentPreview,
} from './cloud-chat-attachments';

/**
 * The largest picture a transcript's image attachment is read for (CAN-6824):
 * one range of `worker.artifact.download.read`. A larger one stays a file
 * tile, and nothing past its first range is read.
 */
export const CLOUD_ATTACHMENT_THUMBNAIL_MAX_BYTES =
  WORKER_ARTIFACT_DOWNLOAD_CHUNK_MAX_BYTES;

/** Thumbnail reads running at once; the rest wait their turn. */
export const CLOUD_ATTACHMENT_THUMBNAIL_CONCURRENCY = 3;

/**
 * The raster pictures a thumbnail is drawn for, each with the bytes its file
 * starts with. An SVG is a document, not a picture, and is never drawn.
 */
const RASTER_SIGNATURES: ReadonlyMap<
  CloudAttachmentMediaType,
  (bytes: Uint8Array) => boolean
> = new Map<CloudAttachmentMediaType, (bytes: Uint8Array) => boolean>([
  [
    'image/png',
    (bytes) =>
      [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every(
        (byte, index) => bytes[index] === byte,
      ),
  ],
  [
    'image/jpeg',
    (bytes) => bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff,
  ],
  [
    'image/gif',
    (bytes) => new TextDecoder().decode(bytes.subarray(0, 4)) === 'GIF8',
  ],
  [
    'image/webp',
    (bytes) =>
      new TextDecoder().decode(bytes.subarray(0, 4)) === 'RIFF' &&
      new TextDecoder().decode(bytes.subarray(8, 12)) === 'WEBP',
  ],
]);

/** Reads in flight, by chat and path: two tiles and a hover share one. */
const reads = new Map<string, Promise<string | null>>();
/** Paths whose read failed or was refused, kept for this window's life. */
const failed = new Set<string>();
let running = 0;
const waiting: (() => void)[] = [];

async function inTurn<T>(work: () => Promise<T>): Promise<T> {
  if (running >= CLOUD_ATTACHMENT_THUMBNAIL_CONCURRENCY)
    await new Promise<void>((resolve) => {
      waiting.push(resolve);
    });
  running += 1;
  try {
    return await work();
  } finally {
    running -= 1;
    waiting.shift()?.();
  }
}

function bytesOf(base64: string): Uint8Array {
  return Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
}

/** The picture's raster type from its filename, or null for anything else. */
function rasterTypeOf(path: string): CloudAttachmentMediaType | null {
  const mediaType = mediaTypeForAttachmentFilename(
    path.slice(path.lastIndexOf('/') + 1),
  );
  return mediaType !== null && RASTER_SIGNATURES.has(mediaType)
    ? mediaType
    : null;
}

async function readThumbnail(
  relay: CanopyCoreRelayApi,
  chatId: string,
  path: string,
  id: string,
  mediaType: CloudAttachmentMediaType,
): Promise<string | null> {
  const reply = await relay.invoke({
    kind: 'request',
    method: 'worker.artifact.download.read',
    params: {
      artifactId: `attachment:${id}`,
      scope: { chatId },
      offset: 0,
      length: CLOUD_ATTACHMENT_THUMBNAIL_MAX_BYTES,
    },
    authority: 'web-core',
  });
  if (!reply.ok) return null;
  const range = WorkerArtifactDownloadReadResultSchema.safeParse(reply.value);
  if (
    !range.success ||
    range.data.offset !== 0 ||
    range.data.nextOffset !== null ||
    range.data.sizeBytes > CLOUD_ATTACHMENT_THUMBNAIL_MAX_BYTES
  )
    return null;
  const bytes = bytesOf(range.data.data);
  // The bytes must be the picture the filename names.
  if (
    bytes.byteLength !== range.data.sizeBytes ||
    RASTER_SIGNATURES.get(mediaType)?.(bytes) !== true
  )
    return null;
  rememberCloudAttachmentPreview(path, {
    filename: path.slice(path.lastIndexOf('/') + 1),
    mediaType,
    bytes,
  });
  const preview = cloudAttachmentPreview(path);
  return preview?.kind === 'image' ? preview.content : null;
}

/**
 * The picture of a cloud chat's image attachment that this window didn't
 * upload, such as one sent from the web or before a reload (CAN-6824): read
 * once through the chat's own web core read, the one its tile's save uses,
 * and kept with the uploaded ones. A PNG, JPEG, GIF or WebP only, whose bytes
 * are what its filename says, and no larger than one read. Anything else, or
 * a read that fails or is refused, answers null and its tile stays a file
 * tile; a failed path isn't read again in this window.
 */
export function loadCloudAttachmentThumbnail(
  relay: CanopyCoreRelayApi,
  chatId: string,
  path: string,
): Promise<string | null> {
  const remembered = cloudAttachmentPreview(path);
  if (remembered?.kind === 'image') return Promise.resolve(remembered.content);
  const key = `${chatId}\n${path}`;
  const id = cloudAttachmentIdOfPath(path);
  const mediaType = rasterTypeOf(path);
  if (id === null || mediaType === null || failed.has(key))
    return Promise.resolve(null);
  const pending = reads.get(key);
  if (pending !== undefined) return pending;
  // A refused read answers null; a throw is unexpected, so it is recorded.
  const read = inTurn(() => readThumbnail(relay, chatId, path, id, mediaType))
    .catch((error: unknown): null => {
      reportClientAppError(error);
      return null;
    })
    .then((src) => {
      if (src === null) failed.add(key);
      return src;
    })
    .finally(() => {
      reads.delete(key);
    });
  reads.set(key, read);
  return read;
}
