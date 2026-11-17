import * as path from 'path';

import type { FileProvider } from '../../../../core/src/provider.js';
import type { TranscriptContext } from '../../fileWatcher.js';
import { processTranscriptLine } from '../../transcriptParser.js';
import { claudeProvider } from '../hook/claude/claude.js';

export const claudeFileProvider: FileProvider<TranscriptContext> = {
  kind: 'file',
  id: claudeProvider.id,
  displayName: claudeProvider.displayName,
  protocolVersion: claudeProvider.protocolVersion,
  formatToolStatus: claudeProvider.formatToolStatus,
  permissionExemptTools: claudeProvider.permissionExemptTools,
  subagentToolNames: claudeProvider.subagentToolNames,
  readingTools: claudeProvider.readingTools,
  terminalNamePrefix: claudeProvider.terminalNamePrefix,
  getSessionDirs: (workspacePath) => claudeProvider.getSessionDirs?.(workspacePath) ?? [],
  getAllSessionRoots: () => claudeProvider.getAllSessionRoots?.() ?? [],
  sessionFilePattern: '*.jsonl',
  ...(claudeProvider.buildLaunchCommand
    ? { buildLaunchCommand: claudeProvider.buildLaunchCommand }
    : {}),
  ...(claudeProvider.team ? { team: claudeProvider.team } : {}),
  supportsClearDetection: true,
  matchesSessionFile: (fileName) => fileName.endsWith('.jsonl'),
  sessionIdFromFile: (filePath) => path.basename(filePath, '.jsonl'),
  processTranscriptLine: (line, context) =>
    processTranscriptLine(
      context.agentId,
      line,
      context.agents,
      context.waitingTimers,
      context.permissionTimers,
    ),
};
