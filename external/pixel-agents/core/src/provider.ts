import type { TeamProvider } from './teamProvider.js';

export const SESSION_PROVIDER_PROTOCOL_VERSION = 1;

export type AgentEvent =
  | {
      kind: 'toolStart';
      toolId: string;
      toolName: string;
      input?: unknown;
      runInBackground?: boolean;
    }
  | { kind: 'toolEnd'; toolId: string }
  | {
      kind: 'turnEnd';
      awaitingInput?: boolean;
    }
  | {
      kind: 'subagentStart';
      parentToolId: string;
      toolId: string;
      toolName: string;
      input?: unknown;
      runInBackground?: boolean;
    }
  | { kind: 'subagentEnd'; parentToolId: string; toolId: string }
  | {
      kind: 'subagentTurnEnd';
      parentToolId: string;
      reason: 'idle' | 'completed';
    }
  | { kind: 'progress'; toolId: string; data: unknown }
  | { kind: 'permissionRequest' }
  | {
      kind: 'sessionStart';
      source?: string;
      transcriptPath?: string;
      cwd?: string;
    }
  | { kind: 'sessionEnd'; reason?: string };

export interface ProviderCapabilities {
  readonly id: string;
  readonly displayName: string;
  readonly protocolVersion: number;
  formatToolStatus(toolName: string, input?: unknown): string;
  readonly permissionExemptTools: ReadonlySet<string>;
  readonly subagentToolNames: ReadonlySet<string>;
  readonly readingTools: ReadonlySet<string>;
  readonly terminalNamePrefix?: string;

  getSessionDirs?(workspacePath: string): string[];
  getAllSessionRoots?(): string[];
  readonly sessionFilePattern?: string;
  buildLaunchCommand?(
    sessionId: string,
    cwd: string,
    opts?: { bypassPermissions?: boolean },
  ): {
    command: string;
    args: string[];
    env?: Record<string, string>;
  };

  readonly team?: TeamProvider;
}

export interface HookProvider extends ProviderCapabilities {
  readonly kind: 'hook';
  normalizeHookEvent(raw: Record<string, unknown>): {
    sessionId: string;
    event: AgentEvent;
  } | null;
  installHooks(serverUrl: string, authToken: string): Promise<void>;
  uninstallHooks(): Promise<void>;
  areHooksInstalled(): Promise<boolean>;
  parseTranscriptLine?(line: string): AgentEvent | null;
}

export interface FileProvider<Context> extends ProviderCapabilities {
  readonly kind: 'file';
  readonly supportsClearDetection?: boolean;
  matchesSessionFile(fileName: string): boolean;
  sessionIdFromFile(filePath: string): string;
  processTranscriptLine(line: string, context: Context): void;
}
