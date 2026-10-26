import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { Components } from 'react-markdown';

const components: Components = {
    // Keep the webview on the app; links are shown but never navigate the window away.
    a: ({ href, children }) => (
        <a href={href} onClick={(e) => e.preventDefault()} title={href}>
            {children}
        </a>
    ),
};

export default function Markdown({ text }: { text: string }) {
    return (
        <div className="md">
            <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
                {text}
            </ReactMarkdown>
        </div>
    );
}
