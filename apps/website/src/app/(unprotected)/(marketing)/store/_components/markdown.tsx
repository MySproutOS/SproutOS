import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"

/**
 * Listing bodies are markdown written by whoever submitted the listing, and a published listing
 * has been *moderated*, which is not the same as sanitized. So this deliberately does not add
 * `rehype-raw`: react-markdown drops raw HTML unless that plugin is installed, which makes an
 * embedded `<script>` or an `onerror` attribute inert text rather than a stored XSS on our own
 * origin. There is no sanitizer here because there is nothing to sanitize — the parser never
 * produces the dangerous nodes in the first place.
 *
 * If a future listing genuinely needs inline HTML, the answer is a rendering allowlist, not
 * rehype-raw.
 */
export function Markdown({ children }: { children: string }) {
  return (
    <div className="prose prose-invert max-w-none prose-headings:font-display prose-headings:tracking-tight prose-a:text-primary prose-code:font-mono prose-code:text-[0.875em] prose-pre:rule-soft prose-pre:border prose-pre:bg-card/60 prose-img:rounded-lg">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          // Listing bodies link off-site by nature. `noopener` denies the target a handle on
          // our window; `ugc` tells crawlers this is user-contributed and not an endorsement.
          a: ({ href, children: text }) => (
            <a href={href} rel="nofollow ugc noopener noreferrer" target="_blank">
              {text}
            </a>
          ),
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  )
}
