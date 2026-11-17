import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import type { TeamProvider } from '../../../../../core/src/teamProvider.js';



function sidecarPath(jsonlPath: string): string {
  return jsonlPath.replace(/\.jsonl$/, '.meta.json');
}

function parseSidecarAgentType(jsonlPath: string): string | null {
  const metaPath = sidecarPath(jsonlPath);
  try {
    const raw = fs.readFileSync(metaPath, 'utf-8');
    const data = JSON.parse(raw) as { agentType?: unknown };
    return typeof data.agentType === 'string' ? data.agentType : null;
  } catch {
    return null;
  }
}

function teammateDir(projectDir: string, leadSessionId: string): string {
  return path.join(projectDir, leadSessionId, 'subagents');
}


export const claudeTeamProvider: TeamProvider = {
  providerId: 'claude',

  teammateSpawnTools: new Set(['Agent']),
  withinTurnSubagentTools: new Set(['Task']),

  isTeammateSpawnCall(toolName, toolInput) {
    return toolName === 'Agent' && toolInput.run_in_background === true;
  },

  extractTeammateNameFromEvent(event) {
    const teammateName = event.teammate_name;
    if (typeof teammateName === 'string') return teammateName;
    const agentType = event.agent_type;
    return typeof agentType === 'string' ? agentType : undefined;
  },

  discoverTeammates(projectDir, leadSessionId) {
    const dir = teammateDir(projectDir, leadSessionId);
    let entries: string[];
    try {
      entries = fs.readdirSync(dir);
    } catch {
      return [];
    }
    const result: Array<{ jsonlPath: string; teammateName: string }> = [];
    for (const entry of entries) {
      if (!entry.endsWith('.jsonl')) continue;
      const jsonlPath = path.join(dir, entry);
      const teammateName = parseSidecarAgentType(jsonlPath);
      if (teammateName) {
        result.push({ jsonlPath, teammateName });
      }
    }
    return result;
  },

  getTeamMetadataForSession(jsonlPath) {
    let raw: string;
    try {
      raw = fs.readFileSync(jsonlPath, 'utf-8');
    } catch {
      return null;
    }
    const firstNewline = raw.indexOf('\n');
    const firstLine = firstNewline === -1 ? raw : raw.slice(0, firstNewline);
    if (!firstLine.trim()) return null;
    try {
      const record = JSON.parse(firstLine) as Record<string, unknown>;
      const teamName = record.teamName;
      if (typeof teamName !== 'string') return null;
      const agentName = record.agentName;
      return {
        teamName,
        agentName: typeof agentName === 'string' ? agentName : undefined,
      };
    } catch {
      return null;
    }
  },

  extractTeamMetadataFromRecord(record) {
    const teamName = record.teamName;
    if (typeof teamName !== 'string') return null;
    const agentName = record.agentName;
    return {
      teamName,
      agentName: typeof agentName === 'string' ? agentName : undefined,
    };
  },

  getTeamMembers(teamName) {
    const configPath = path.join(os.homedir(), '.claude', 'teams', teamName, 'config.json');
    let raw: string;
    try {
      raw = fs.readFileSync(configPath, 'utf-8');
    } catch {
      return null;
    }
    try {
      const data = JSON.parse(raw) as { members?: Array<{ name?: unknown }> };
      if (!Array.isArray(data.members)) return null;
      const names = new Set<string>();
      for (const m of data.members) {
        if (m && typeof m.name === 'string') names.add(m.name);
      }
      return names;
    } catch {
      return null;
    }
  },
};
