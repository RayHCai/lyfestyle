/** A base URL without trailing slashes, so `${base}/path` never doubles one. */
export const trimTrailingSlashes = (url: string) => url.replace(/\/+$/, '');

/** Whether a failed response is worth retrying: a server error, a timeout or a rate limit. */
export const retryableStatus = (status: number) =>
    status >= 500 || status === 408 || status === 429;
