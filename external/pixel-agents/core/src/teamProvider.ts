export interface TeamProvider {
  providerId: string;

  teammateSpawnTools: ReadonlySet<string>;

  withinTurnSubagentTools: ReadonlySet<string>;

  isTeammateSpawnCall(toolName: string, toolInput: Record<string, unknown>): boolean;

  extractTeammateNameFromEvent(event: Record<string, unknown>): string | undefined;

  discoverTeammates(
    projectDir: string,
    leadSessionId: string,
  ): Array<{ jsonlPath: string; teammateName: string }>;

  getTeamMetadataForSession(jsonlPath: string): { teamName: string; agentName?: string } | null;

  extractTeamMetadataFromRecord(
    record: Record<string, unknown>,
  ): { teamName?: string; agentName?: string } | null;

  getTeamMembers(teamName: string): Set<string> | null;
}
