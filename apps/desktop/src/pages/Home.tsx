import Composer from '../components/Composer';
import { useApp } from '../store/app';
import { useData } from '../store/data';
import { sendMessage } from '../lib/agent';
import { greeting, titleFrom } from '../lib/util';

export default function Home() {
    const name = useData((s) => s.settings.name);
    const createConversation = useData((s) => s.createConversation);
    const navigate = useApp((s) => s.navigate);
    const text = greeting('');
    const who = name.trim();

    const start = async (prompt: string) => {
        const c = await createConversation(titleFrom(prompt));
        navigate({ name: 'conversation', id: c.id });
        void sendMessage(c.id, prompt);
    };

    return (
        <div className="home">
            <h1>
                {text}
                {who ? (
                    <>
                        , <em>{who}</em>
                    </>
                ) : null}
            </h1>
            <Composer autoFocus onSubmit={(t) => void start(t)} />
        </div>
    );
}
