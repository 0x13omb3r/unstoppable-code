import { GlobalWorkerOptions, getDocument, version } from 'pdfjs-dist';
import type { PdfPreviewAssets } from './PdfPreview';

/** Render one bounded page for the reply well using the document viewer's worker assets. */
export async function renderPdfReplyThumbnail(
  bytes: ArrayBuffer,
  resolveAssets: (pdfJsVersion: string) => PdfPreviewAssets,
  signal: AbortSignal,
): Promise<string> {
  signal.throwIfAborted();
  const assets = resolveAssets(version);
  GlobalWorkerOptions.workerSrc = assets.workerSrc;
  const options: Parameters<typeof getDocument>[0] & {
    isEvalSupported: boolean;
  } = {
    data: new Uint8Array(bytes),
    isEvalSupported: false,
    enableXfa: false,
    maxImageSize: 8_388_608,
    cMapUrl: `${assets.assetBaseUrl}cmaps/`,
    standardFontDataUrl: `${assets.assetBaseUrl}standard_fonts/`,
    wasmUrl: `${assets.assetBaseUrl}wasm/`,
    iccUrl: `${assets.assetBaseUrl}iccs/`,
  };
  const loading = getDocument(options);
  const cancel = (): void => {
    void loading.destroy().catch(() => undefined);
  };
  signal.addEventListener('abort', cancel, { once: true });
  loading.onPassword = (reply: (password: string | Error) => void): void =>
    reply(new Error('Password-protected PDF'));
  try {
    const pdf = await loading.promise;
    const page = await pdf.getPage(1);
    signal.throwIfAborted();
    const original = page.getViewport({ scale: 1 });
    const scale = Math.min(800 / original.height, 1440 / original.width, 2);
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.ceil(viewport.width));
    canvas.height = Math.max(1, Math.ceil(viewport.height));
    await page.render({ canvas, viewport }).promise;
    signal.throwIfAborted();
    return canvas.toDataURL('image/png');
  } finally {
    signal.removeEventListener('abort', cancel);
    await loading.destroy().catch(() => undefined);
  }
}
