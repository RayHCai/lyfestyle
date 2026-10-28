import {
    createCipheriv,
    createDecipheriv,
    createHmac,
    hkdfSync,
    randomBytes,
    timingSafeEqual,
} from 'node:crypto';

/** Encrypts secrets at rest and signs short-lived tokens, all from one master key. */
export interface SecretBox {
    seal(value: unknown): string;
    open<T>(sealed: string): T;
    sign(payload: object, ttlMs: number): string;
    verify<T>(token: string): T | null;
}

export function createSecretBox(masterKey: Buffer): SecretBox {
    const encKey = derive(masterKey, 'lyfestyle:secrets');
    const macKey = derive(masterKey, 'lyfestyle:tokens');

    return {
        seal(value) {
            const iv = randomBytes(12);
            const cipher = createCipheriv('aes-256-gcm', encKey, iv);
            const body = Buffer.concat([
                cipher.update(JSON.stringify(value), 'utf8'),
                cipher.final(),
            ]);
            return ['v1', iv, cipher.getAuthTag(), body]
                .map((part) => (typeof part === 'string' ? part : part.toString('base64url')))
                .join('.');
        },

        open<T>(sealed: string): T {
            const [version, iv, tag, body] = sealed.split('.');
            if (version !== 'v1' || !iv || !tag || !body) throw new Error('Malformed secret');
            // Pinning the tag length refuses a truncated tag, which would weaken the check.
            const decipher = createDecipheriv('aes-256-gcm', encKey, Buffer.from(iv, 'base64url'), {
                authTagLength: 16,
            });
            decipher.setAuthTag(Buffer.from(tag, 'base64url'));
            const plain = Buffer.concat([
                decipher.update(Buffer.from(body, 'base64url')),
                decipher.final(),
            ]);
            return JSON.parse(plain.toString('utf8')) as T;
        },

        sign(payload, ttlMs) {
            const body = Buffer.from(JSON.stringify({ ...payload, exp: Date.now() + ttlMs }));
            const encoded = body.toString('base64url');
            return `${encoded}.${mac(macKey, encoded).toString('base64url')}`;
        },

        verify<T>(token: string): T | null {
            const [encoded, signature] = token.split('.');
            if (!encoded || !signature) return null;
            if (!safeEqual(signature, mac(macKey, encoded).toString('base64url'))) return null;
            const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as {
                exp: number;
            };
            return payload.exp > Date.now() ? (payload as T) : null;
        },
    };
}

function derive(key: Buffer, info: string): Buffer {
    return Buffer.from(hkdfSync('sha256', key, Buffer.alloc(0), info, 32));
}

function mac(key: Buffer, value: string): Buffer {
    return createHmac('sha256', key).update(value).digest();
}

const equalityKey = randomBytes(32);

/** Constant-time string comparison that also hides the length of either side. */
export function safeEqual(a: string, b: string): boolean {
    return timingSafeEqual(mac(equalityKey, a), mac(equalityKey, b));
}
