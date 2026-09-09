/**
 * Reads a secret from the terminal without echoing it.
 * Falls back to a plain line read when stdin is not a TTY (piped input).
 */
export function promptSecret(promptText: string): Promise<string> {
    return new Promise((resolve, reject) => {
        const stdin = process.stdin;
        const stdout = process.stdout;

        stdout.write(promptText);

        if (!stdin.isTTY) {
            let data = '';
            const onData = (chunk: Buffer) => {
                data += chunk.toString('utf8');
                const newlineIndex = data.indexOf('\n');
                if (newlineIndex >= 0) {
                    stdin.off('data', onData);
                    stdin.pause();
                    resolve(data.slice(0, newlineIndex).replace(/\r$/, ''));
                }
            };
            stdin.on('data', onData);
            stdin.once('end', () => {
                stdin.off('data', onData);
                resolve(data.replace(/\r?\n?$/, ''));
            });
            stdin.resume();
            return;
        }

        stdin.setRawMode(true);
        stdin.resume();
        stdin.setEncoding('utf8');

        let input = '';
        const cleanup = () => {
            stdin.setRawMode(false);
            stdin.pause();
            stdin.off('data', onData);
        };
        const onData = (char: string) => {
            switch (char) {
                case '\r':
                case '\n':
                    cleanup();
                    stdout.write('\n');
                    resolve(input);
                    break;
                case '': // Ctrl+C
                    cleanup();
                    stdout.write('\n');
                    reject(new Error('Cancelled'));
                    break;
                case '': // Backspace
                case '\b':
                    input = input.slice(0, -1);
                    break;
                default:
                    input += char;
                    break;
            }
        };
        stdin.on('data', onData);
    });
}
