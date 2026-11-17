import type * as vscode from 'vscode';

export interface AgentState {
  id: number;
  sessionId: string;
  terminalRef?: vscode.Terminal;
  isExternal: boolean;
  projectDir: string;
  jsonlFile: string;
  fileOffset: number;
  lineBuffer: string;
  activeToolIds: Set<string>;
  activeToolStatuses: Map<string, string>;
  activeToolNames: Map<string, string>;
  activeSubagentToolIds: Map<string, Set<string>>;
  activeSubagentToolNames: Map<string, Map<string, string>>;
  backgroundAgentToolIds: Set<string>;
  isWaiting: boolean;
  permissionSent: boolean;
  hadToolsInTurn: boolean;
  folderName?: string;
  lastDataAt: number;
  linesProcessed: number;
  seenUnknownRecordTypes: Set<string>;
  hookDelivered: boolean;
  hooksOnly?: boolean;
  providerId?: string;
  pendingClear?: boolean;
  currentHookToolId?: string;
  currentHookToolName?: string;
  currentHookIsTeammateSpawn?: boolean;

  inputTokens: number;
  outputTokens: number;

  teamName?: string;
  agentName?: string;
  isTeamLead?: boolean;
  leadAgentId?: number;
  teamUsesTmux?: boolean;
}

export interface PersistedAgent {
  id: number;
  sessionId?: string;
  terminalName: string;
  isExternal?: boolean;
  jsonlFile: string;
  projectDir: string;
  folderName?: string;

  teamName?: string;
  agentName?: string;
  isTeamLead?: boolean;
  leadAgentId?: number;
  teamUsesTmux?: boolean;
}
