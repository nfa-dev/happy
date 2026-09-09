import { describe, it, expect } from 'vitest';
import { parseSecretKey } from './secretKey';
import { encodeBase64Url, getRandomBytes } from './encryption';

// Mirror of the app's formatSecretKeyForBackup (sources/auth/secretKeyBackup.ts)
const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function formatForBackup(bytes: Uint8Array): string {
    let base32 = '';
    let buffer = 0;
    let bufferLength = 0;
    for (const byte of bytes) {
        buffer = (buffer << 8) | byte;
        bufferLength += 8;
        while (bufferLength >= 5) {
            bufferLength -= 5;
            base32 += BASE32_ALPHABET[(buffer >> bufferLength) & 0x1f];
        }
    }
    if (bufferLength > 0) {
        base32 += BASE32_ALPHABET[(buffer << (5 - bufferLength)) & 0x1f];
    }
    const groups: string[] = [];
    for (let i = 0; i < base32.length; i += 5) {
        groups.push(base32.slice(i, i + 5));
    }
    return groups.join('-');
}

describe('parseSecretKey', () => {
    it('parses the app backup format (base32 with dashes)', () => {
        const secret = getRandomBytes(32);
        const formatted = formatForBackup(secret);
        expect(formatted).toMatch(/^[A-Z2-7]{5}(-[A-Z2-7]{1,5})+$/);
        expect(parseSecretKey(formatted)).toEqual(secret);
    });

    it('parses the backup format case-insensitively and with spaces', () => {
        const secret = getRandomBytes(32);
        const formatted = formatForBackup(secret).toLowerCase().replaceAll('-', ' ');
        expect(parseSecretKey(formatted)).toEqual(secret);
    });

    it('tolerates common transcription mistakes (0/1/8 for O/I/B)', () => {
        const secret = getRandomBytes(32);
        const formatted = formatForBackup(secret)
            .replaceAll('O', '0')
            .replaceAll('I', '1')
            .replaceAll('B', '8');
        expect(parseSecretKey(formatted)).toEqual(secret);
    });

    it('parses a raw base64url secret', () => {
        const secret = getRandomBytes(32);
        expect(parseSecretKey(encodeBase64Url(secret))).toEqual(secret);
    });

    it('rejects empty input', () => {
        expect(() => parseSecretKey('   ')).toThrow('Secret key is required');
    });

    it('rejects keys of the wrong length', () => {
        expect(() => parseSecretKey(formatForBackup(getRandomBytes(16)))).toThrow(/expected 32 bytes/);
        expect(() => parseSecretKey(encodeBase64Url(getRandomBytes(16)))).toThrow();
    });
});
