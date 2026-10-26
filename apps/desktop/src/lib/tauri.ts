/** Thin bridge to the Rust side. Everything degrades gracefully in a plain browser (vite dev). */

export const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

export async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
    const { invoke } = await import('@tauri-apps/api/core');
    return invoke<T>(cmd, args);
}

export async function onEvent<T>(name: string, handler: (payload: T) => void): Promise<() => void> {
    if (!isTauri) return () => {};
    const { listen } = await import('@tauri-apps/api/event');
    const un = await listen<T>(name, (e) => handler(e.payload));
    return un;
}

export async function windowAction(action: 'minimize' | 'maximize' | 'close') {
    if (!isTauri) return;
    const { getCurrentWindow } = await import('@tauri-apps/api/window');
    const w = getCurrentWindow();
    if (action === 'minimize') await w.minimize();
    else if (action === 'maximize') await w.toggleMaximize();
    else await w.close();
}
