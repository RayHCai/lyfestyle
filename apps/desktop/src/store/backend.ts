/** The connection the store modules share: the API client and API mode's local page copy, or
 *  neither in local mode. Kept outside the zustand state because nothing renders from it. */
import type { Api } from '../lib/api';
import type { PageSync } from '../lib/sync';

let api: Api | null = null;
let pages: PageSync | null = null;

/** The API client while in API mode, else null. */
export const getApi = () => api;
/** API mode: the local copy of the API's pages, else null. */
export const getPages = () => pages;

/** Switches backends. The old page copy stops pushing; its files stay for the next session. */
export function setBackend(next: { api: Api | null; pages: PageSync | null }) {
    if (pages !== next.pages) pages?.close();
    api = next.api;
    pages = next.pages;
}

/** Whether `client` is still the API the app talks to. A response that arrives after the mode or
 *  the API changed is dropped instead of overwriting the new one's state. */
export const isActive = (client: Api) => api === client;
