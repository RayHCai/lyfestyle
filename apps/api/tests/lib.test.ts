import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { createSecretBox, safeEqual } from '../src/lib/crypto.js';
import { htmlToText } from '../src/lib/html.js';

const box = createSecretBox(Buffer.alloc(32, 1));

describe('SecretBox', () => {
    it('round-trips sealed values', () => {
        const sealed = box.seal({ token: 'abc', n: 1 });
        expect(sealed).not.toContain('abc');
        expect(box.open(sealed)).toEqual({ token: 'abc', n: 1 });
    });

    it('refuses tampered, truncated or foreign ciphertext', () => {
        const [version, iv, tag, body] = box.seal('secret').split('.') as [
            string,
            string,
            string,
            string,
        ];
        const flipped = Buffer.from(body, 'base64url');
        flipped[0]! ^= 1;
        expect(() => box.open([version, iv, tag, flipped.toString('base64url')].join('.'))).toThrow(
            /authenticate/,
        );
        // A shortened tag would weaken GCM's check; the decipher pins it to 16 bytes.
        const short = Buffer.from(tag, 'base64url').subarray(0, 4).toString('base64url');
        expect(() => box.open([version, iv, short, body].join('.'))).toThrow(
            /authentication tag length/i,
        );
        expect(() => box.open('v1.only')).toThrow('Malformed secret');
        const other = createSecretBox(Buffer.alloc(32, 2));
        expect(() => other.open(box.seal('secret'))).toThrow(/authenticate/);
    });

    it('signs tokens that expire and cannot be altered', () => {
        const token = box.sign({ kind: 'agent', runId: 'r1' }, 60_000);
        expect(box.verify(token)).toMatchObject({ kind: 'agent', runId: 'r1' });
        const [payload, signature] = token.split('.') as [string, string];
        const forged = Buffer.from(JSON.stringify({ kind: 'agent', runId: 'r2', exp: 9e15 }));
        expect(box.verify(`${forged.toString('base64url')}.${signature}`)).toBeNull();
        expect(box.verify(`${payload}.${signature.slice(1)}`)).toBeNull();
        expect(box.verify(payload)).toBeNull();
        expect(box.verify(box.sign({ kind: 'agent' }, -1))).toBeNull();
        expect(createSecretBox(Buffer.alloc(32, 2)).verify(token)).toBeNull();
    });

    it('compares strings of any length', () => {
        expect(safeEqual('same-token', 'same-token')).toBe(true);
        expect(safeEqual('same-token', 'same-tokem')).toBe(false);
        expect(safeEqual('short', 'a much longer string')).toBe(false);
        expect(safeEqual('', '')).toBe(true);
    });
});

describe('htmlToText', () => {
    it('decodes entities and keeps the ones it cannot', () => {
        expect(htmlToText('a &amp; b &#65;&#x42; &unknown; &nbsp;c')).toBe('a & b AB &unknown;  c');
        // Beyond Unicode, zero and garbage stay as written instead of throwing.
        expect(htmlToText('&#99999999; &#0; &#x110000; &#xzz;')).toBe(
            '&#99999999; &#0; &#x110000; &#xzz;',
        );
        expect(htmlToText('&#x1F600;')).toBe('😀');
    });

    it('drops scripts and styles and turns blocks into lines', () => {
        expect(
            htmlToText(
                '<style>p{}</style><script>alert(1)</script><p>One</p><p>Two<br>Three</p>\n\n\n\n<div>Four</div>',
            ),
        ).toBe('One\nTwo\nThree\n\nFour');
    });
});

describe('loadConfig', () => {
    const env = {
        DATABASE_URL: 'postgresql://localhost/test',
        API_TOKEN: 'x'.repeat(24),
        ENCRYPTION_KEY: Buffer.alloc(32).toString('base64'),
    };

    it('names every invalid variable', () => {
        expect(() => loadConfig({})).toThrow(/DATABASE_URL[\s\S]*API_TOKEN[\s\S]*ENCRYPTION_KEY/);
        expect(() => loadConfig({ ...env, API_TOKEN: 'short' })).toThrow(
            'API_TOKEN must be at least 24 characters',
        );
        expect(() => loadConfig({ ...env, ENCRYPTION_KEY: 'c2hvcnQ=' })).toThrow(
            'ENCRYPTION_KEY must be 32 bytes',
        );
        expect(() => loadConfig({ ...env, DATABASE_URL: 'mysql://x' })).toThrow('postgres://');
        expect(() => loadConfig({ ...env, METRICS_RETENTION_DAYS: '-1' })).toThrow(
            'METRICS_RETENTION_DAYS',
        );
    });

    it('fills in defaults', () => {
        expect(loadConfig(env)).toMatchObject({
            publicUrl: 'http://localhost:3000',
            corsOrigins: '*',
            metricsOrigins: '*',
            metricsRetentionDays: 365,
            resend: undefined,
        });
    });
});
