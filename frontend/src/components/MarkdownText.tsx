import Markdown from "react-markdown";
import type { FC } from "react";

interface MarkdownTextProps {
  text: string;
  fontScale?: number;
}

export const MarkdownText: FC<MarkdownTextProps> = ({ text, fontScale = 1.25 }) => {
  return (
    <Markdown
      components={{
        p: ({ children }) => (
          <p className="mb-4">{children}</p>
        ),
        ul: ({ children }) => (
          <ul className="mb-4 pl-6 list-disc">{children}</ul>
        ),
        ol: ({ children }) => (
          <ol className="mb-4 pl-6 list-decimal">{children}</ol>
        ),
        li: ({ children }) => (
          <li className="mb-1">{children}</li>
        ),
        code: ({ children, className }) => {
          const isBlock = className?.includes("language-");
          if (isBlock) {
            return (
              <pre
                className="mb-4 p-4 bg-code-bg rounded-lg overflow-x-auto font-mono"
                style={{ fontSize: `${14 * fontScale}px` }}
              >
                <code>{children}</code>
              </pre>
            );
          }
          return (
            <code
              className="px-1.5 py-0.5 bg-user-bubble rounded font-mono"
              style={{ fontSize: `${14 * fontScale}px` }}
            >
              {children}
            </code>
          );
        },
        pre: ({ children }) => <>{children}</>,
        blockquote: ({ children }) => (
          <blockquote className="mb-4 pl-4 border-l-4 border-primary italic text-muted">
            {children}
          </blockquote>
        ),
        h1: ({ children }) => (
          <h1
            className="mb-3 font-bold"
            style={{ fontSize: `${24 * fontScale}px` }}
          >
            {children}
          </h1>
        ),
        h2: ({ children }) => (
          <h2
            className="mb-2 font-bold"
            style={{ fontSize: `${20 * fontScale}px` }}
          >
            {children}
          </h2>
        ),
        h3: ({ children }) => (
          <h3
            className="mb-2 font-bold"
            style={{ fontSize: `${18 * fontScale}px` }}
          >
            {children}
          </h3>
        ),
        a: ({ href, children }) => (
          <a href={href} className="text-primary underline break-words">
            {children}
          </a>
        ),
        strong: ({ children }) => (
          <strong className="font-bold">{children}</strong>
        ),
        em: ({ children }) => (
          <em className="italic">{children}</em>
        ),
      }}
    >
      {text}
    </Markdown>
  );
};
