/** What the user can do from more than one place (the front page, the console, the sidebar, the
 *  lists), done one way. Failures land in the store's notice instead of being dropped. */
import { tabKey, useApp } from '../store/app';
import { useData } from '../store/data';
import { sendMessage } from './agent';
import { describeError } from './api';
import { confirmAction } from './confirm';
import { titleFrom } from './util';

const notify = (e: unknown) => useData.getState().notify(describeError(e));

/** Opens a new conversation titled after `prompt` and sends it. */
export async function startConversation(prompt: string): Promise<void> {
    try {
        const c = await useData.getState().createConversation(titleFrom(prompt));
        useApp.getState().navigate({ name: 'conversation', id: c.id });
        await sendMessage(c.id, prompt);
    } catch (e) {
        notify(e);
    }
}

/** Asks first, then deletes the conversation; its tab and its draft go with it. */
export async function removeConversation(id: string): Promise<void> {
    const title = useData.getState().conversations[id]?.title ?? 'this conversation';
    if (!(await confirmAction(`Delete "${title}"? This cannot be undone.`))) return;
    // The strip moves to the neighbouring tab.
    const app = useApp.getState();
    app.closeTab(tabKey({ name: 'conversation', id }));
    app.setDraft(id, '');
    try {
        await useData.getState().deleteConversation(id);
    } catch (e) {
        notify(e);
    }
}

/** Creates an empty document and opens it. */
export async function newDocument(): Promise<void> {
    try {
        const d = await useData.getState().createDoc();
        useApp.getState().navigate({ name: 'documents', id: d.id });
    } catch (e) {
        notify(e);
    }
}
