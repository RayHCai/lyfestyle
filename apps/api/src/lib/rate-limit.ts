// In-memory limits: right for the single API replica (ADR 0003), and a restart only forgives a
// little.

/** A token bucket per key: `perMinute` actions, refilled evenly over each minute. */
export function createRateLimiter(options: { perMinute: number; maxKeys?: number }) {
    const { perMinute } = options;
    const maxKeys = options.maxKeys ?? 10_000;
    const buckets = new Map<string, { tokens: number; at: number }>();
    const level = (bucket: { tokens: number; at: number }, at: number) =>
        Math.min(perMinute, bucket.tokens + (Math.max(0, at - bucket.at) * perMinute) / 60_000);

    function prune(at: number) {
        for (const [key, bucket] of buckets) {
            if (level(bucket, at) >= perMinute) buckets.delete(key);
        }
        // Still full means a flood of distinct keys: forget them rather than grow without bound.
        if (buckets.size >= maxKeys) buckets.clear();
    }

    return {
        /** Whether `key` may act at `at` (epoch ms); spends one token when it may. */
        take(key: string, at: number): boolean {
            const bucket = buckets.get(key);
            const tokens = bucket ? level(bucket, at) : perMinute;
            if (!bucket && buckets.size >= maxKeys) prune(at);
            buckets.set(key, { tokens: tokens >= 1 ? tokens - 1 : tokens, at });
            return tokens >= 1;
        },
    };
}

/** At most `limit` actions per UTC day. */
export function createDailyCap(limit: number) {
    let day = '';
    let count = 0;
    return {
        take(at: Date): boolean {
            const today = at.toISOString().slice(0, 10);
            if (today !== day) {
                day = today;
                count = 0;
            }
            if (count >= limit) return false;
            count++;
            return true;
        },
    };
}
