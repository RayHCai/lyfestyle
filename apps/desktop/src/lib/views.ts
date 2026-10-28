import { useData } from '../store/data';
import type { View } from './types';

const labels: Record<View['name'], string> = {
    home: 'home',
    conversation: 'conversation',
    conversations: 'conversations',
    documents: 'documents',
    automations: 'automations',
    pageviews: 'page views',
    settings: 'settings',
};

/** How the tab strip and the titlebar name a view: a conversation by its title, else the screen. */
export function useViewLabel(view: View): string {
    const title = useData((s) =>
        view.name === 'conversation' ? s.conversations[view.id]?.title : undefined,
    );
    return title ?? labels[view.name];
}
