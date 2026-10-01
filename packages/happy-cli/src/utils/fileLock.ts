/**
 * Cross-process exclusive section via an O_EXCL lock file
 *
 * Same protocol as persistence.ts updateSettings (that helper is hardwired to
 * the settings file): create the lock file exclusively, retry while another
 * process holds it, and reclaim a lock old enough to belong to a crashed
 * process.
 */

import { constants } from 'node:fs';
import { open, stat, unlink } from 'node:fs/promises';

export async function withFileLock<T>(lockFile: string, run: () => Promise<T>): Promise<T> {
  const LOCK_RETRY_INTERVAL_MS = 100;
  const MAX_LOCK_ATTEMPTS = 50;
  const STALE_LOCK_TIMEOUT_MS = 10_000;

  let fileHandle;
  for (let attempts = 0; attempts < MAX_LOCK_ATTEMPTS && !fileHandle; attempts++) {
    try {
      fileHandle = await open(lockFile, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY);
    } catch (err: any) {
      if (err.code !== 'EEXIST') throw err;
      await new Promise(resolve => setTimeout(resolve, LOCK_RETRY_INTERVAL_MS));
      try {
        const stats = await stat(lockFile);
        if (Date.now() - stats.mtimeMs > STALE_LOCK_TIMEOUT_MS) {
          await unlink(lockFile).catch(() => { });
        }
      } catch { }
    }
  }
  if (!fileHandle) {
    throw new Error(`Failed to acquire lock: ${lockFile}`);
  }
  try {
    return await run();
  } finally {
    await fileHandle.close();
    await unlink(lockFile).catch(() => { });
  }
}
