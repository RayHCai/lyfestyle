import { streamRunEvents as streamFrom, type RunEvent } from '@lyfestyle/shared';
import { ApiRequestError, type ClientOptions } from './client.js';

export interface StreamOptions extends ClientOptions {
    runId: string;
    /** Resume after this event id instead of replaying the run from the start. */
    after?: number;
    signal?: AbortSignal;
    /** Failed attempts in a row to retry; any event received resets the count. Default 5. */
    retries?: number;
    /** Wait between attempts, in ms. Default 1000. */
    retryDelayMs?: number;
}

/**
 * Every event of a run as it happens, from `GET /runs/:id/stream`: the shared reader in
 * `@lyfestyle/shared`, with an HTTP error thrown as `ApiRequestError`. Reconnects after the last
 * event seen on a dropped connection or a 5xx; ends after the run's terminal status event.
 */
export function streamRunEvents(options: StreamOptions): AsyncGenerator<RunEvent> {
    return streamFrom({ ...options, toError: (response) => ApiRequestError.from(response) });
}
