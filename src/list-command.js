import { spawn } from 'node:child_process';

// Shell input is explicitly trusted. This is not a Pi tool/model operation.
export function runListCommand(command, { cwd, signal, onOutput } = {}) {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const grouped = process.platform !== 'win32';
    const child = spawn(command, { cwd, shell: true, detached: grouped,
      stdio: ['ignore', 'pipe', 'pipe'] });
    let timer;
    let outputError;
    let stopping = false;
    const kill = sig => {
      try {
        if (grouped) process.kill(-child.pid, sig);
        else child.kill(sig);
      } catch { /* already exited */ }
    };
    const cancel = () => {
      if (stopping) return;
      stopping = true;
      kill('SIGTERM');
      timer = setTimeout(() => kill('SIGKILL'), 1000);
    };
    const cleanup = () => {
      // Shell exit does not imply its process group has exited: descendants
      // may ignore TERM and close/redirect their inherited output streams.
      if (!stopping) clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
    };
    for (const stream of ['stdout', 'stderr']) {
      child[stream].setEncoding('utf8');
      child[stream].on('data', text => {
        try { onOutput?.(stream, text); }
        catch (error) { outputError ??= error; cancel(); }
      });
    }
    child.once('error', error => { cleanup(); reject(error); });
    child.once('close', (exitCode, exitSignal) => {
      cleanup();
      if (outputError) reject(outputError);
      else if (signal?.aborted) reject(signal.reason ?? new Error('Cancelled.'));
      else resolve({ exitCode, signal: exitSignal });
    });
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) cancel();
  });
}
