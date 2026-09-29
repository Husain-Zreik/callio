// Worker threads follow the main thread's log levels (run by loggingCheck.mjs):
// a level change in the main thread reaches a running thread, and a thread
// started later picks up the current levels.
import { Worker, isMainThread, parentPort } from 'worker_threads';
import { logger, setLogLevels } from '../../src/infra/logging/logger.js';

if (isMainThread) {
    const ask = (worker) => new Promise((resolve) => {
        worker.once('message', resolve);
        worker.postMessage('level?');
    });
    const settle = () => new Promise((resolve) => setTimeout(resolve, 150));

    const running = new Worker(new URL(import.meta.url));
    await settle();
    const before = await ask(running);
    setLogLevels({ levels: { 'check.thread': 'trace' } });
    await settle();
    const afterChange = await ask(running);
    const late = new Worker(new URL(import.meta.url));
    await settle();
    const lateLevel = await ask(late);
    await running.terminate();
    await late.terminate();
    process.stdout.write(JSON.stringify({ before, afterChange, lateLevel }));
    process.exit(0);
} else {
    const log = logger('check.thread.Sample');
    parentPort.on('message', () => parentPort.postMessage(log.level));
}
