// Where runtime log-level overrides live in Redis: shared by LogLevelControl
// (the workers) and scripts/log-level.js (the CLI), which must not import the logger.
export const LOG_LEVELS_KEY = 'callio:log-levels';
export const LOG_LEVELS_CHANNEL = 'callio:log-levels';
