import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

/** AI の回答を表示。`path/to/file` 形式のインラインコードが実在ファイルならクリックで開ける */
export function Markdown({ text, paths, onOpen }: { text: string; paths: Set<string>; onOpen: (path: string) => void }) {
  return (
    <div className="markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          code({ className, children }) {
            const value = String(children);
            if (!className && !value.includes("\n")) {
              const clean = value.replace(/^\.?\//, "").replace(/:(\d+)(-\d+)?$/, "");
              if (paths.has(clean)) {
                return (
                  <code className="file-link" onClick={() => onOpen(clean)} title="ファイルを開く">
                    {value}
                  </code>
                );
              }
            }
            return <code className={className}>{children}</code>;
          },
          a({ href, children }) {
            return (
              <a href={href} target="_blank" rel="noreferrer noopener">
                {children}
              </a>
            );
          },
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}
