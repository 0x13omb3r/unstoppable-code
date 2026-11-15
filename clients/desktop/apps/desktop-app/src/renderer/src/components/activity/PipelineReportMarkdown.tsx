import type { JSX } from 'react';
import {
  Markdown,
  DocumentProse,
  markdownOptions,
  type MarkdownOverrides,
} from '@canopy/ui-shared/components';

const REPORT_COMPONENTS: MarkdownOverrides = {
  a({ children }): JSX.Element {
    return <span>{children}</span>;
  },
};
const REPORT_MARKDOWN_OPTIONS = markdownOptions(REPORT_COMPONENTS);

/**
 * Renders pipeline report markdown with GFM support and the shared prose
 * styling used across the report modal and the inline Summary report view.
 */
export function PipelineReportMarkdown({
  content,
}: {
  content: string;
}): JSX.Element {
  return (
    <DocumentProse variant="report" replay="block">
      <Markdown options={REPORT_MARKDOWN_OPTIONS}>{content}</Markdown>
    </DocumentProse>
  );
}
