// src/infra/cluster/WorkerBoot.js
// This process's boot id: random per start, unlike WORKER_ID / pm_id, which a
// restarted worker reuses. Call leases and media legs are tagged with it, so
// "the worker that set this up is gone" is a fact, not a guess.
import { randomBytes } from 'crypto';

export const bootId = randomBytes(4).toString('hex');
