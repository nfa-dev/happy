import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';

const bucket = vi.hoisted(() => ({
    objects: new Map<string, Buffer>(),
    puts: [] as Array<{ bucket: string; name: string; size: number }>,
    getError: null as (Error & { code?: string }) | null,
}));

vi.mock('minio', () => ({
    Client: class {
        async putObject(name: string, key: string, data: Buffer, size: number) {
            bucket.puts.push({ bucket: name, name: key, size });
            bucket.objects.set(key, Buffer.from(data));
            return {};
        }
        async getObject(_name: string, key: string) {
            if (bucket.getError) throw bucket.getError;
            const data = bucket.objects.get(key);
            if (!data) throw Object.assign(new Error('The specified key does not exist.'), { code: 'NoSuchKey' });
            // Two chunks, like a real response body.
            return Readable.from([data.subarray(0, 2), data.subarray(2)]);
        }
    },
}));

// files.ts reads its storage configuration at import time.
async function loadFiles(env: Record<string, string>) {
    vi.resetModules();
    vi.unstubAllEnvs();
    for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
    return import('./files');
}

describe('files storage', () => {
    let dataDir: string | null = null;
    afterEach(async () => {
        vi.unstubAllEnvs();
        bucket.objects.clear();
        bucket.puts = [];
        bucket.getError = null;
        if (dataDir) await rm(dataDir, { recursive: true, force: true });
        dataDir = null;
    });

    it('transfers through the server for local storage and for S3 unless direct transfers are on', async () => {
        expect((await loadFiles({ S3_HOST: '', S3_DIRECT_TRANSFERS: 'true' })).transfersViaServer()).toBe(true);
        expect((await loadFiles({ S3_HOST: 's3.test', S3_BUCKET: 'blobs', S3_DIRECT_TRANSFERS: '' })).transfersViaServer()).toBe(true);
        expect((await loadFiles({ S3_HOST: 's3.test', S3_BUCKET: 'blobs', S3_DIRECT_TRANSFERS: 'true' })).transfersViaServer()).toBe(false);
    });

    it('stores and reads S3 objects, and reports a missing key as null', async () => {
        const files = await loadFiles({ S3_HOST: 's3.test', S3_BUCKET: 'blobs' });
        await files.putFile('sessions/s1/attachments/a.enc', Buffer.from('payload'));
        expect(bucket.puts).toEqual([{ bucket: 'blobs', name: 'sessions/s1/attachments/a.enc', size: 7 }]);
        expect(await files.getFile('sessions/s1/attachments/a.enc')).toEqual(Buffer.from('payload'));
        expect(await files.getFile('sessions/s1/attachments/missing.enc')).toBeNull();
    });

    it('rethrows S3 errors other than a missing key', async () => {
        const files = await loadFiles({ S3_HOST: 's3.test', S3_BUCKET: 'blobs' });
        bucket.getError = Object.assign(new Error('Access Denied'), { code: 'AccessDenied' });
        await expect(files.getFile('sessions/s1/attachments/a.enc')).rejects.toThrow('Access Denied');
    });

    it('stores and reads local files, and reports a missing file as null', async () => {
        dataDir = await mkdtemp(join(tmpdir(), 'happy-files-'));
        const files = await loadFiles({ S3_HOST: '', DATA_DIR: dataDir });
        await files.putFile('sessions/s1/attachments/a.enc', Buffer.from('payload'));
        expect(await files.getFile('sessions/s1/attachments/a.enc')).toEqual(Buffer.from('payload'));
        expect(await files.getFile('sessions/s1/attachments/missing.enc')).toBeNull();
        expect(bucket.puts).toEqual([]);
    });
});
