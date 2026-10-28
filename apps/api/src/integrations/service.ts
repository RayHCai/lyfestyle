import type { Requirement } from '../tools/registry.js';
import type { Resend } from './resend.js';
import type { IntegrationStore } from './store.js';

/** What is connected, for the settings screen and for deciding which tools the agent gets. */
export function createIntegrationsService(deps: { store: IntegrationStore; resend: Resend }) {
    const { store, resend } = deps;
    return {
        async status() {
            const canvas = await store.describe('canvas');
            return {
                canvas: {
                    connected: canvas !== null,
                    account: canvas?.account ?? null,
                    baseUrl: (canvas?.config.baseUrl as string | undefined) ?? null,
                    updatedAt: canvas?.updatedAt ?? null,
                },
                resend: { configured: resend.configured, from: resend.from },
            };
        },

        /** The tool requirements that are met right now. */
        async met(): Promise<Set<Requirement>> {
            const met = new Set<Requirement>();
            if ((await store.connected()).has('canvas')) met.add('canvas');
            if (resend.configured) met.add('resend');
            return met;
        },
    };
}
