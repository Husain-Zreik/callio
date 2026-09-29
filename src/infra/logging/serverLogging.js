// src/infra/logging/serverLogging.js
// Imported first by index.js, for its side effect: ES modules evaluate their
// imports in order, so this runs before any other module can log — the log
// files are open and console.* (libraries) is bridged into the logger.
import { initLogging, installConsoleBridge } from './logger.js';

initLogging();
installConsoleBridge();
