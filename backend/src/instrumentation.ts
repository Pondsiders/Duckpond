/**
 * Logfire instrumentation — must be loaded BEFORE other imports.
 *
 * This configures OpenTelemetry-based tracing and logging via Pydantic Logfire.
 * Load this via --import flag: node --import ./dist/instrumentation.js
 */

import * as logfire from '@pydantic/logfire-node';

// Configure Logfire
logfire.configure({
  serviceName: 'duckpond-backend',
  serviceVersion: '0.1.0',
});

console.log('[Duckpond] Logfire instrumentation loaded');

// Export logfire instance for use throughout the app
export { logfire };
