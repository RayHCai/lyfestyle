import React from 'react';
import ReactDOM from 'react-dom/client';
import '@fontsource/geist-mono/400.css';
import '@fontsource/geist-mono/500.css';
import '@fontsource/geist-mono/700.css';
import '@blocknote/mantine/style.css';
import './styles/global.css';
import App from './App';
import { isWeb } from './lib/tauri';

// The installed web app's shell, kept for opening offline (`public/sw.js`). Never in the desktop
// app, and not in `dev:web`, where a cached shell would hide the change being made.
if (isWeb && import.meta.env.PROD && 'serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        navigator.serviceWorker
            .register('/sw.js')
            .catch((e: unknown) => console.error('Could not register the service worker:', e));
    });
}

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
    <React.StrictMode>
        <App />
    </React.StrictMode>,
);
