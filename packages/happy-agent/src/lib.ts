/**
 * Library entry — programmatic surface for embedding happy-agent in another
 * Node process (e.g. an orchestrator driving sessions). The default entry (`happy-agent`)
 * is the CLI and runs commander at import time; require this subpath
 * (`happy-agent/lib`) instead.
 *
 * Intentionally NOT exported: api.deleteSession, SessionClient.sendStop is
 * present on the class but embedders like happy-bridge must not call it
 * (session force-termination is a policy decision of the embedder).
 */

export { loadConfig } from './config';
export type { Config } from './config';

export { readCredentials, requireCredentials } from './credentials';
export type { Credentials } from './credentials';

export { authRestore } from './auth';
export { parseSecretKey } from './secretKey';

export {
    listSessions,
    listActiveSessions,
    listMachines,
    createSession,
    getSessionMessages,
} from './api';
export type {
    DecryptedSession,
    DecryptedMachine,
    DecryptedMessage,
    EncryptionVariant,
} from './api';

export { spawnSessionOnMachine, resumeSessionOnMachine } from './machineRpc';
export type { SupportedAgent, SpawnMachineSessionResult } from './machineRpc';

export { SessionClient } from './session';
export type { SessionClientOptions } from './session';
