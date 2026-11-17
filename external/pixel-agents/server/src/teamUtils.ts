import type { AgentStateStore } from './agentStateStore.js';
import type { AgentState } from './types.js';


export function isInlineTeammateOf(agent: AgentState, leadId: number): boolean {
  return agent.leadAgentId === leadId && !agent.teamUsesTmux;
}

export function getInlineTeammates(
  leadId: number,
  agents: AgentStateStore,
): Array<[number, AgentState]> {
  const out: Array<[number, AgentState]> = [];
  for (const [id, a] of agents) {
    if (isInlineTeammateOf(a, leadId)) out.push([id, a]);
  }
  return out;
}

export function hasInlineTeammates(leadId: number, agents: AgentStateStore): boolean {
  for (const a of agents.values()) {
    if (isInlineTeammateOf(a, leadId)) return true;
  }
  return false;
}
