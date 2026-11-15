import { useFocused, useSelected, type RenderElementProps } from 'slate-react';
import type { JSX } from 'react';
import { FileReferenceChip } from '@canopy/ui-shared/components';

function getFilename(displayPath: string): string {
  const parts = displayPath.split('/');
  return parts[parts.length - 1] || displayPath;
}

export function FileReferencePillElement({
  attributes,
  children,
  element,
}: RenderElementProps): JSX.Element {
  const selected = useSelected();
  const focused = useFocused();
  if (element.type !== 'file-reference') {
    return <span {...attributes}>{children}</span>;
  }
  const label = getFilename(element.displayPath);

  return (
    <span {...attributes} contentEditable={false}>
      <FileReferenceChip
        selected={selected && focused}
        title={element.displayPath}
        data-testid="file-reference-pill"
        data-mention-kind={element.kind}
      >
        @{label}
      </FileReferenceChip>
      {children}
    </span>
  );
}
