import { useCallback, useState } from 'react';
import { describeError } from '../lib/api';

/** Runs an action, keeping its failure for the UI instead of throwing. Resolves true when it
 *  succeeded. */
export type Attempt = (fn: () => Promise<unknown>) => Promise<boolean>;

/** The last failure (cleared by the next success) and the `attempt` that records it. */
export function useAttempt(): [problem: string | undefined, attempt: Attempt] {
    const [problem, setProblem] = useState<string | undefined>();
    const attempt = useCallback<Attempt>(async (fn) => {
        try {
            await fn();
            setProblem(undefined);
            return true;
        } catch (e) {
            setProblem(describeError(e));
            return false;
        }
    }, []);
    return [problem, attempt];
}
