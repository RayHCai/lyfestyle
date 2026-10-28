import type { CSSProperties } from 'react';
import Composer from '../components/Composer';
import { useData } from '../store/data';
import { startConversation } from '../lib/actions';
import { todayLabel } from '../lib/time';
import { isWeb } from '../lib/tauri';
import { greeting } from '../lib/util';

export default function Home() {
    const name = useData((s) => s.settings.name);
    const text = greeting(name) + '.';
    const today = todayLabel();

    return (
        <div className="home">
            <div className="home-inner">
                <p className="eyebrow home-date">{today}</p>
                <h1>
                    {/* The greeting types itself; the CSS steps once per character. */}
                    <span className="typed" style={{ '--n': text.length } as CSSProperties}>
                        {text}
                    </span>
                </h1>
                {/* No agent on the web until one runs in the cloud. */}
                {!isWeb && <Composer autoFocus onSubmit={(t) => void startConversation(t)} />}
            </div>
        </div>
    );
}
