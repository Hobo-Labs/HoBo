import * as fs from 'node:fs';

import type { AgentStateStore } from './agentStateStore.js';

export interface AgentDiagnosticsEntry {
  id: number;
  projectDir: string;
  projectDirExists: boolean;
  jsonlFile: string;
  jsonlExists: boolean;
  fileSize: number;
  fileOffset: number;
  lastDataAt: number;
  linesProcessed: number;
}

export function buildAgentDiagnostics(store: AgentStateStore): AgentDiagnosticsEntry[] {
  const diagnostics: AgentDiagnosticsEntry[] = [];
  for (const agent of store.values()) {
    let jsonlExists = false;
    let fileSize = 0;
    try {
      const stat = fs.statSync(agent.jsonlFile);
      jsonlExists = true;
      fileSize = stat.size;
    } catch {
    }
    diagnostics.push({
      id: agent.id,
      projectDir: agent.projectDir,
      projectDirExists: fs.existsSync(agent.projectDir),
      jsonlFile: agent.jsonlFile,
      jsonlExists,
      fileSize,
      fileOffset: agent.fileOffset,
      lastDataAt: agent.lastDataAt,
      linesProcessed: agent.linesProcessed,
    });
  }
  return diagnostics;
}
