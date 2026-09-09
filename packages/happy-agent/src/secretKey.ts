import { decodeBase64Url } from './encryption';

// Base32 alphabet (RFC 4648) — mirrors happy-app sources/auth/secretKeyBackup.ts
const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32ToBytes(base32: string): Uint8Array {
    // Normalize common transcription mistakes, mirror the app's tolerance:
    // 0->O, 1->I, 8->B, 9->G, then strip anything outside the alphabet.
    const normalized = base32.toUpperCase()
        .replace(/0/g, 'O')
        .replace(/1/g, 'I')
        .replace(/8/g, 'B')
        .replace(/9/g, 'G');
    const cleaned = normalized.replace(/[^A-Z2-7]/g, '');

    if (cleaned.length === 0) {
        throw new Error('No valid characters found');
    }

    const bytes: number[] = [];
    let buffer = 0;
    let bufferLength = 0;

    for (const char of cleaned) {
        const value = BASE32_ALPHABET.indexOf(char);
        buffer = (buffer << 5) | value;
        bufferLength += 5;

        if (bufferLength >= 8) {
            bufferLength -= 8;
            bytes.push((buffer >> bufferLength) & 0xff);
        }
    }

    return new Uint8Array(bytes);
}

/**
 * Parses a secret key as shown by the Happy app.
 *
 * Accepts either the Backup screen format (base32 groups such as
 * `XXXXX-XXXXX-...`, dashes/spaces optional) or a raw base64url string,
 * and returns the 32-byte account secret.
 */
export function parseSecretKey(input: string): Uint8Array {
    const trimmed = input.trim();
    if (trimmed.length === 0) {
        throw new Error('Secret key is required');
    }

    // A 32-byte secret is 43 chars in base64url but 52+ chars in base32
    // (65 with dash separators), so length alone routes the formats.
    // Note: base64url itself may contain '-', so a dash is NOT a reliable
    // signal for the backup format.
    if (/\s/.test(trimmed) || trimmed.length > 50) {
        const bytes = base32ToBytes(trimmed);
        if (bytes.length !== 32) {
            throw new Error(`Invalid secret key length: expected 32 bytes, got ${bytes.length}`);
        }
        return bytes;
    }

    try {
        const bytes = decodeBase64Url(trimmed);
        if (bytes.length !== 32) {
            throw new Error('Invalid secret key');
        }
        return bytes;
    } catch {
        const bytes = base32ToBytes(trimmed);
        if (bytes.length !== 32) {
            throw new Error(`Invalid secret key length: expected 32 bytes, got ${bytes.length}`);
        }
        return bytes;
    }
}
