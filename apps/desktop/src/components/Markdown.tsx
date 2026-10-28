import { memo, useEffect, useRef, useState, type MouseEvent, type ReactNode } from 'react';
import ReactMarkdown, {
    defaultUrlTransform,
    type Components,
    type UrlTransform,
} from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useApp } from '../store/app';
import { openExternal } from '../lib/tauri';
import CopyButton from './CopyButton';

const plugins = [remarkGfm];
const PAGE = /^page:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
/** Inline images that need no request; anything else is never fetched. */
const INLINE_IMAGE = /^data:image\/(png|jpeg|gif|webp);/i;

/** react-markdown blanks schemes it does not know; `page:` is the app's link between documents,
 *  and a `data:` image loads nothing from anywhere. */
const urlTransform: UrlTransform = (url, key) => {
    if (PAGE.test(url)) return url;
    if (key === 'src' && INLINE_IMAGE.test(url)) return url;
    return defaultUrlTransform(url);
};

function Code({ children }: { children?: ReactNode }) {
    const ref = useRef<HTMLPreElement>(null);
    return (
        <div className="code">
            <CopyButton className="code-copy" text={() => ref.current?.textContent ?? ''} />
            <pre ref={ref}>{children}</pre>
        </div>
    );
}

/** A link that never navigates the window: `page:` links open the document in the app, anything
 *  else goes out through `openExternal`. Middle and right clicks do nothing either. */
function Link({
    href,
    children,
    image = false,
}: {
    href: string | undefined;
    children: ReactNode;
    image?: boolean;
}) {
    const [copied, setCopied] = useState(false);
    useEffect(() => {
        if (!copied) return;
        const t = setTimeout(() => setCopied(false), 1500);
        return () => clearTimeout(t);
    }, [copied]);
    const page = href ? PAGE.exec(href)?.[1] : undefined;
    const open = (e: MouseEvent) => {
        e.preventDefault();
        if (page) useApp.getState().navigate({ name: 'documents', id: page.toLowerCase() });
        else if (href)
            void openExternal(href).then(
                (how) => setCopied(how === 'copied'),
                (err: unknown) => console.error('Could not open or copy the link:', err),
            );
    };
    return (
        <a
            href={href}
            className={image ? 'img-link' : undefined}
            title={page ? 'Open the document' : href}
            onClick={open}
            onAuxClick={(e) => e.preventDefault()}
        >
            {children}
            {copied && <span className="link-note"> (link copied)</span>}
        </a>
    );
}

const components: Components = {
    a: ({ href, children }) => <Link href={href}>{children}</Link>,
    // An image URL would load the moment the reply renders, so a prompt-injected agent could leak
    // data in one. Remote images become a link the user may choose to open.
    img: ({ src, alt }) =>
        typeof src === 'string' && INLINE_IMAGE.test(src) ? (
            <img src={src} alt={alt ?? ''} />
        ) : (
            <Link href={typeof src === 'string' ? src : undefined} image>
                {alt || src || 'image'}
            </Link>
        ),
    pre: ({ children }) => <Code>{children}</Code>,
};

/** Agent-written markdown. Memoised on the text, so a long thread re-parses only what changed. */
export default memo(function Markdown({ text }: { text: string }) {
    return (
        <div className="md">
            <ReactMarkdown
                remarkPlugins={plugins}
                components={components}
                urlTransform={urlTransform}
            >
                {text}
            </ReactMarkdown>
        </div>
    );
});
