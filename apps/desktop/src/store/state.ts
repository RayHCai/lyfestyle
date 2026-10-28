/** The shape of `useData`, one interface per domain module, so the modules can share it without
 *  importing each other. */
import type { StateCreator } from 'zustand';
import type { ApiAutomation, ApiAutomationDeploy } from '../lib/api';
import type { AgentEnv, Conversation, DocMeta, Settings, Skill, TrashedDoc } from '../lib/types';

export type Mode = 'local' | 'api';
export interface ApiStatus {
    state: 'off' | 'connecting' | 'ok' | 'error';
    url: string;
    error?: string;
}

/** `data.ts`: which backend the app talks to, and getting everything from it. */
export interface CoreSlice {
    ready: boolean;
    /** `local`: flat files plus a locally spawned agent. `api`: the Lyfestyle API holds everything. */
    mode: Mode;
    api: ApiStatus;
    /** A failure (or a kept conflict) with nowhere else to show, shown above the page until
     *  dismissed. */
    notice: string | null;
    notify: (notice: string | null) => void;
    load: () => Promise<void>;
    /** API mode: re-fetch the lists and sync documents. Keeps in-flight streams and loaded transcripts. */
    refresh: () => Promise<void>;
}

/** `settings.ts` */
export interface SettingsSlice {
    settings: Settings;
    env: AgentEnv;
    dataDir: string;
    /** Skills from `settings.skillsDirectory`, for the composer's `/` menu. */
    skills: Skill[];
    skillsError: string | null;
    /** API mode: why the todo server could not be registered with the API, if it could not. */
    todoError: string | null;
    /** Link the skills folder into Claude Code's user skills and list what it holds. */
    loadSkills: () => Promise<void>;
    saveSettings: (patch: Partial<Settings>) => Promise<void>;
}

/** `conversations.ts` */
export interface ConversationsSlice {
    conversations: Record<string, Conversation>;
    createConversation: (title: string) => Promise<Conversation>;
    updateConversation: (id: string, fn: (c: Conversation) => Conversation) => void;
    persistConversation: (id: string) => Promise<void>;
    /** Stops its turn if one is running, then deletes it. Throws, with the conversation back in
     *  place, when the delete fails. */
    deleteConversation: (id: string) => Promise<void>;
}

/** `docs.ts` */
export interface DocsSlice {
    docs: DocMeta[];
    /** API mode: trashed documents, most recently deleted first. Loaded when the trash opens. */
    trash: TrashedDoc[];
    /** API mode: documents edited here that the API has not accepted yet. */
    unsynced: number;
    /** Why documents cannot be saved or synced right now: an unreadable index in local mode, the
     *  last failed sync round in API mode. Null when all is well. */
    docsError: string | null;
    /** Bumped when a document changed behind the open editor (the agent wrote it, or a sync
     *  brought a new version), so the editor remounts with the new text. */
    docRevisions: Record<string, number>;
    /** Picks up documents the agent's tools may have changed: re-reads the files in local mode,
     *  syncs with the API in API mode. */
    reloadFiles: () => Promise<void>;
    createDoc: (title?: string) => Promise<DocMeta>;
    renameDoc: (id: string, title: string) => Promise<void>;
    /** Local mode removes the files; API mode moves the page to the trash. */
    deleteDoc: (id: string) => Promise<void>;
    loadTrash: () => Promise<void>;
    restoreDoc: (id: string) => Promise<DocMeta>;
    readDoc: (id: string) => Promise<string>;
    writeDoc: (id: string, markdown: string) => Promise<void>;
}

/** `automations.ts`: API mode only; local mode has no automations. */
export interface AutomationsSlice {
    automations: ApiAutomation[];
    /** Deploys waiting for the user's approval. */
    deploys: ApiAutomationDeploy[];
    /** Re-fetch automations and pending deploys. */
    loadAutomations: () => Promise<void>;
    setAutomationEnabled: (id: string, enabled: boolean) => Promise<void>;
    deleteAutomation: (id: string) => Promise<void>;
    /** Start a run of the automation now. */
    triggerAutomation: (id: string) => Promise<void>;
    /** Approve deploys the code; reject drops it. Either way the list reloads. */
    decideDeploy: (id: string, approve: boolean) => Promise<void>;
}

export type DataState = CoreSlice &
    SettingsSlice &
    ConversationsSlice &
    DocsSlice &
    AutomationsSlice;

/** One domain's part of the store, with the whole store to read and write. */
export type Slice<T> = StateCreator<DataState, [], [], T>;
