import type { HTMLAttributes, IframeHTMLAttributes, JSX } from 'react';
import styles from './OfficeDocumentSurface.module.css';

type OfficeDocumentRegionProps = HTMLAttributes<HTMLDivElement> & {
  readonly kind:
    | 'document-edge'
    | 'unsupported-shape'
    | 'frozen-edge'
    | 'frozen-cell';
};

const REGION_CLASS: Record<OfficeDocumentRegionProps['kind'], string> = {
  'document-edge': styles.documentEdge,
  'unsupported-shape': styles.unsupportedShape,
  'frozen-edge': styles.frozenSheetEdge,
  'frozen-cell': `${styles.documentEdge} ${styles.frozenSheetEdge}`,
};

export function OfficeDocumentRegion({
  kind,
  className,
  ...props
}: OfficeDocumentRegionProps): JSX.Element {
  return (
    <div
      {...props}
      className={
        className ? `${className} ${REGION_CLASS[kind]}` : REGION_CLASS[kind]
      }
    />
  );
}

export function OfficeDocumentFrame(
  props: Omit<
    IframeHTMLAttributes<HTMLIFrameElement>,
    'className' | 'sandbox' | 'referrerPolicy'
  >,
): JSX.Element {
  return (
    <iframe
      {...props}
      className={`min-h-0 flex-1 ${styles.docxPage}`}
      sandbox=""
      referrerPolicy="no-referrer"
    />
  );
}
