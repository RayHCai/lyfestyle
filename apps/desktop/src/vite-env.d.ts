/// <reference types="vite/client" />

interface ImportMetaEnv {
    /** The web build's API, fixed when it is built (`lib/web.ts`). */
    readonly VITE_API_URL?: string;
}
