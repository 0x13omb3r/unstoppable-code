import { AdvisorCodeExcerpt } from '@canopy/ui-shared/components';
import { InlineCode } from '@canopy/ui-shared/components';
import type { JSX } from 'react';
import {
  Markdown,
  markdownOptions,
  type MarkdownOverrides,
} from '@canopy/ui-shared/components';

const ADVISOR_MARKDOWN_COMPONENTS: MarkdownOverrides = {
  p({ children }): JSX.Element {
    return <>{children}</>;
  },
  a({ children, href }): JSX.Element {
    const isSafe = typeof href === 'string' && /^(https?:|mailto:)/.test(href);
    if (!isSafe) {
      return <span>{children}</span>;
    }
    return (
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className="fg-accent underline decoration-accent/40 underline-offset-2"
      >
        {children}
      </a>
    );
  },
  code({ children, className }): JSX.Element {
    if (className) {
      return (
        <code className={`${className} whitespace-pre-wrap`}>{children}</code>
      );
    }
    return <InlineCode variant="advisor-markdown">{children}</InlineCode>;
  },
  pre({ children }): JSX.Element {
    return <AdvisorCodeExcerpt>{children}</AdvisorCodeExcerpt>;
  },
  ul({ children }): JSX.Element {
    return <span className="pt-1 flex flex-col gap-0.5">{children}</span>;
  },
  ol({ children }): JSX.Element {
    return <span className="pt-1 flex flex-col gap-0.5">{children}</span>;
  },
  li({ children }): JSX.Element {
    return <span className="block">{children}</span>;
  },
};
const ADVISOR_MARKDOWN_OPTIONS = markdownOptions(ADVISOR_MARKDOWN_COMPONENTS);

export function PipelineAdvisorMarkdownText({
  children,
  className,
}: {
  children: string;
  className?: string;
}): JSX.Element {
  return (
    <span className={className}>
      <Markdown options={ADVISOR_MARKDOWN_OPTIONS}>{children}</Markdown>
    </span>
  );
}
