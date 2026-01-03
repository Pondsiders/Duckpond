import Markdown from "react-markdown";
import type { FC } from "react";

// Claude dark palette
const colors = {
  text: "#eee",
  muted: "#9a9893",
  primary: "#ae5630",
  codeBg: "#1a1a18",
  inlineCodeBg: "#393937",
};

interface MarkdownTextProps {
  text: string;
  fontScale?: number;
}

export const MarkdownText: FC<MarkdownTextProps> = ({ text, fontScale = 1.25 }) => {
  return (
    <Markdown
      components={{
        p: ({ children }) => (
          <p style={{ marginBottom: "1em" }}>{children}</p>
        ),
        ul: ({ children }) => (
          <ul style={{ marginBottom: "1em", paddingLeft: "1.5em", listStyleType: "disc" }}>
            {children}
          </ul>
        ),
        ol: ({ children }) => (
          <ol style={{ marginBottom: "1em", paddingLeft: "1.5em", listStyleType: "decimal" }}>
            {children}
          </ol>
        ),
        li: ({ children }) => (
          <li style={{ marginBottom: "0.25em" }}>{children}</li>
        ),
        code: ({ children, className }) => {
          const isBlock = className?.includes("language-");
          if (isBlock) {
            return (
              <pre
                style={{
                  marginBottom: "1em",
                  padding: "1em",
                  background: colors.codeBg,
                  borderRadius: "8px",
                  overflowX: "auto",
                  fontFamily: "monospace",
                  fontSize: `${14 * fontScale}px`,
                }}
              >
                <code>{children}</code>
              </pre>
            );
          }
          return (
            <code
              style={{
                padding: "0.15em 0.4em",
                background: colors.inlineCodeBg,
                borderRadius: "4px",
                fontFamily: "monospace",
                fontSize: `${14 * fontScale}px`,
              }}
            >
              {children}
            </code>
          );
        },
        pre: ({ children }) => <>{children}</>,
        blockquote: ({ children }) => (
          <blockquote
            style={{
              marginBottom: "1em",
              paddingLeft: "1em",
              borderLeft: `4px solid ${colors.primary}`,
              fontStyle: "italic",
              color: colors.muted,
            }}
          >
            {children}
          </blockquote>
        ),
        h1: ({ children }) => (
          <h1 style={{ marginBottom: "0.75em", fontSize: `${24 * fontScale}px`, fontWeight: "bold" }}>
            {children}
          </h1>
        ),
        h2: ({ children }) => (
          <h2 style={{ marginBottom: "0.5em", fontSize: `${20 * fontScale}px`, fontWeight: "bold" }}>
            {children}
          </h2>
        ),
        h3: ({ children }) => (
          <h3 style={{ marginBottom: "0.5em", fontSize: `${18 * fontScale}px`, fontWeight: "bold" }}>
            {children}
          </h3>
        ),
        a: ({ href, children }) => (
          <a
            href={href}
            style={{
              color: colors.primary,
              textDecoration: "underline",
            }}
          >
            {children}
          </a>
        ),
        strong: ({ children }) => (
          <strong style={{ fontWeight: "bold" }}>{children}</strong>
        ),
        em: ({ children }) => (
          <em style={{ fontStyle: "italic" }}>{children}</em>
        ),
      }}
    >
      {text}
    </Markdown>
  );
};
