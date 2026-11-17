import type { PdfPreviewAssets } from '@canopy/ui-rich/pdf';
import type { InlineReplyPreviewContent } from './InlineReplyFilePreview';

export async function readInlineReplyDocument({
  kind,
  bytes,
  signal,
  createOfficeWorker,
  resolvePdfAssets,
}: {
  readonly kind: 'pdf' | 'xlsx';
  readonly bytes: ArrayBuffer;
  readonly signal: AbortSignal;
  readonly createOfficeWorker: () => Worker;
  readonly resolvePdfAssets: (version: string) => PdfPreviewAssets;
}): Promise<InlineReplyPreviewContent | null> {
  if (kind === 'pdf') {
    const { renderPdfReplyThumbnail } = await import('@canopy/ui-rich/pdf');
    return {
      content: await renderPdfReplyThumbnail(bytes, resolvePdfAssets, signal),
    };
  }

  const { parseOfficeDocument } = await import('@canopy/ui-rich/office');
  const workbook = await parseOfficeDocument(
    { kind: 'xlsx', bytes },
    { createWorker: createOfficeWorker, signal },
  );
  const sheet = workbook.kind === 'xlsx' ? workbook.sheets[0] : undefined;
  if (
    sheet === undefined ||
    sheet.rowCount > sheet.rows.length ||
    !sheet.rows.some((row) => row.length >= sheet.colCount)
  ) {
    return null;
  }
  return { content: '', rows: sheet.rows };
}
