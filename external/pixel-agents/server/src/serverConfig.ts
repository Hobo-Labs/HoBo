import { MAX_PORT, MIN_PORT, SERVER_REGISTRY_PROTOCOL_VERSION } from './constants.js';

export interface ServerTarget {
  port: number;
  pid: number;
  token: string;
  debugLog?: string;
}

export interface ServerConfig extends ServerTarget {
  startedAt: number;
  servesSpa: boolean;
  protocol: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function isServerTarget(value: unknown): value is ServerTarget {
  if (!isRecord(value)) return false;
  return (
    Number.isSafeInteger(value.port) &&
    (value.port as number) >= MIN_PORT &&
    (value.port as number) <= MAX_PORT &&
    Number.isSafeInteger(value.pid) &&
    (value.pid as number) > 0 &&
    typeof value.token === 'string' &&
    value.token.length > 0 &&
    (value.debugLog === undefined || typeof value.debugLog === 'string')
  );
}

export function isServerConfig(value: unknown): value is ServerConfig {
  if (!isServerTarget(value) || !isRecord(value)) return false;
  return (
    Number.isSafeInteger(value.startedAt) &&
    (value.startedAt as number) >= 0 &&
    typeof value.servesSpa === 'boolean' &&
    value.protocol === SERVER_REGISTRY_PROTOCOL_VERSION
  );
}
