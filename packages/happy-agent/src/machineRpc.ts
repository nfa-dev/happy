import { io, Socket } from 'socket.io-client';
import type { Config } from './config';
import type { DecryptedMachine } from './api';
import { decodeBase64, encodeBase64, encrypt, decrypt } from './encryption';

export type SupportedAgent = 'claude' | 'codex' | 'gemini' | 'openclaw' | 'agy';

export type SpawnMachineSessionResult =
    | { type: 'success'; sessionId: string }
    | { type: 'requestToApproveDirectoryCreation'; directory: string }
    | { type: 'error'; errorMessage: string };

type RpcAck = {
    ok: boolean;
    result?: string;
    error?: string;
};

function waitForConnect(socket: Socket, timeoutMs = 10_000): Promise<void> {
    return new Promise<void>((resolve, reject) => {
        if (socket.connected) {
            resolve();
            return;
        }

        const timeout = setTimeout(() => {
            socket.off('connect', onConnect);
            socket.off('connect_error', onError);
            reject(new Error('Timeout waiting for socket connection'));
        }, timeoutMs);

        const onConnect = () => {
            clearTimeout(timeout);
            socket.off('connect_error', onError);
            resolve();
        };

        const onError = (error: Error) => {
            clearTimeout(timeout);
            socket.off('connect', onConnect);
            reject(error);
        };

        socket.once('connect', onConnect);
        socket.once('connect_error', onError);
    });
}

function normalizeRpcError(error: string | undefined, machineId: string): string {
    if (!error) {
        return 'RPC call failed';
    }
    if (error === 'RPC method not available') {
        return `Machine ${machineId} is offline or its daemon is not connected.`;
    }
    return error;
}

export async function spawnSessionOnMachine(
    config: Config,
    machine: DecryptedMachine,
    token: string,
    options: {
        directory: string;
        approvedNewDirectoryCreation?: boolean;
        agent?: SupportedAgent;
        providerToken?: string;
        // daemon 의 spawn-happy-session 이 받는 스폰 모드 (happy-cli apiMachine.ts) — 생략 시 daemon 기본값
        // (permission 은 'default' = 도구마다 승인 요청). 헤드리스 e2e 는 'yolo' 를 넘겨야 한다.
        permissionMode?: string;
        modelMode?: string;
        effortLevel?: string;
    },
): Promise<SpawnMachineSessionResult> {
    const socket = io(config.serverUrl, {
        auth: {
            token,
        },
        path: '/v1/updates',
        transports: ['websocket'],
        autoConnect: false,
        reconnection: false,
    });

    socket.connect();

    try {
        await waitForConnect(socket);

        const params = encodeBase64(
            encrypt(machine.encryption.key, machine.encryption.variant, {
                type: 'spawn-in-directory',
                directory: options.directory,
                approvedNewDirectoryCreation: options.approvedNewDirectoryCreation ?? false,
                token: options.providerToken,
                agent: options.agent,
                permissionMode: options.permissionMode,
                modelMode: options.modelMode,
                effortLevel: options.effortLevel,
            }),
        );

        const response = await socket.timeout(30_000).emitWithAck('rpc-call', {
            method: `${machine.id}:spawn-happy-session`,
            params,
        }) as RpcAck;

        if (!response.ok) {
            throw new Error(normalizeRpcError(response.error, machine.id));
        }
        if (!response.result) {
            throw new Error('RPC call returned no result');
        }

        const decrypted = decrypt(
            machine.encryption.key,
            machine.encryption.variant,
            decodeBase64(response.result),
        );

        if (decrypted == null || typeof decrypted !== 'object' || Array.isArray(decrypted)) {
            throw new Error('RPC call returned invalid data');
        }

        if ('error' in decrypted && typeof decrypted.error === 'string') {
            throw new Error(String(decrypted.error));
        }

        if (
            !('type' in decrypted)
            || (
                decrypted.type !== 'success'
                && decrypted.type !== 'requestToApproveDirectoryCreation'
                && decrypted.type !== 'error'
            )
        ) {
            throw new Error('RPC call returned unexpected data');
        }

        return decrypted as SpawnMachineSessionResult;
    } finally {
        socket.close();
    }
}

// daemon 의 stop-session RPC — 세션 프로세스 종료 (승인 대기 등으로 멈춘 헤드리스 세션 정리용).
export async function stopSessionOnMachine(
    config: Config,
    machine: DecryptedMachine,
    token: string,
    sessionId: string,
): Promise<unknown> {
    const socket = io(config.serverUrl, {
        auth: { token },
        path: '/v1/updates',
        transports: ['websocket'],
        autoConnect: false,
        reconnection: false,
    });
    socket.connect();
    try {
        await waitForConnect(socket);
        const params = encodeBase64(encrypt(machine.encryption.key, machine.encryption.variant, { sessionId }));
        const response = await socket.timeout(30_000).emitWithAck('rpc-call', {
            method: `${machine.id}:stop-session`,
            params,
        }) as RpcAck;
        if (!response.ok) throw new Error(normalizeRpcError(response.error, machine.id));
        if (!response.result) return null;
        return decrypt(machine.encryption.key, machine.encryption.variant, decodeBase64(response.result));
    } finally {
        socket.close();
    }
}

export async function resumeSessionOnMachine(
    config: Config,
    machine: DecryptedMachine,
    token: string,
    sessionId: string,
): Promise<SpawnMachineSessionResult> {
    const socket = io(config.serverUrl, {
        auth: {
            token,
        },
        path: '/v1/updates',
        transports: ['websocket'],
        autoConnect: false,
        reconnection: false,
    });

    socket.connect();

    try {
        await waitForConnect(socket);

        const params = encodeBase64(
            encrypt(machine.encryption.key, machine.encryption.variant, {
                sessionId,
            }),
        );

        const response = await socket.timeout(30_000).emitWithAck('rpc-call', {
            method: `${machine.id}:resume-happy-session`,
            params,
        }) as RpcAck;

        if (!response.ok) {
            throw new Error(normalizeRpcError(response.error, machine.id));
        }
        if (!response.result) {
            throw new Error('RPC call returned no result');
        }

        const decrypted = decrypt(
            machine.encryption.key,
            machine.encryption.variant,
            decodeBase64(response.result),
        );

        if (decrypted == null || typeof decrypted !== 'object' || Array.isArray(decrypted)) {
            throw new Error('RPC call returned invalid data');
        }

        if ('error' in decrypted && typeof decrypted.error === 'string') {
            throw new Error(String(decrypted.error));
        }

        if (
            !('type' in decrypted)
            || (
                decrypted.type !== 'success'
                && decrypted.type !== 'requestToApproveDirectoryCreation'
                && decrypted.type !== 'error'
            )
        ) {
            throw new Error('RPC call returned unexpected data');
        }

        return decrypted as SpawnMachineSessionResult;
    } finally {
        socket.close();
    }
}
