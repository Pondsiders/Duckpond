import { MessagePrimitive } from "@assistant-ui/react";
import Markdown from "react-markdown";
import type { FC } from "react";

export const MarkdownText: FC = () => {
  return (
    <MessagePrimitive.Content
      components={{
        Text: ({ text }) => (
          <Markdown
            components={{
              p: ({ children }) => <p className="mb-4 last:mb-0">{children}</p>,
              ul: ({ children }) => <ul className="mb-4 list-disc pl-6">{children}</ul>,
              ol: ({ children }) => <ol className="mb-4 list-decimal pl-6">{children}</ol>,
              li: ({ children }) => <li className="mb-1">{children}</li>,
              code: ({ children, className }) => {
                const isBlock = className?.includes("language-");
                if (isBlock) {
                  return (
                    <pre className="mb-4 overflow-x-auto rounded-lg bg-[#1a1a18] p-4 font-mono text-sm text-[#eee] dark:bg-[#1a1a18]">
                      <code>{children}</code>
                    </pre>
                  );
                }
                return (
                  <code className="rounded bg-[#DDD9CE] px-1.5 py-0.5 font-mono text-sm dark:bg-[#393937]">
                    {children}
                  </code>
                );
              },
              blockquote: ({ children }) => (
                <blockquote className="mb-4 border-l-4 border-[#ae5630] pl-4 italic">
                  {children}
                </blockquote>
              ),
              h1: ({ children }) => <h1 className="mb-4 text-2xl font-bold">{children}</h1>,
              h2: ({ children }) => <h2 className="mb-3 text-xl font-bold">{children}</h2>,
              h3: ({ children }) => <h3 className="mb-2 text-lg font-bold">{children}</h3>,
              a: ({ href, children }) => (
                <a href={href} className="text-[#ae5630] underline hover:text-[#c4633a]">
                  {children}
                </a>
              ),
            }}
          >
            {text}
          </Markdown>
        ),
      }}
    />
  );
};
