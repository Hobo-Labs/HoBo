
import * as vscode from 'vscode';

import type { StateAdapter } from '../../core/src/adapter.js';
import type { PersistedAgent } from '../../core/src/schemas.js';
import { readLayoutFromFile, writeLayoutToFile } from '../../server/src/layoutPersistence.js';

const SETTINGS_MIGRATIONS: readonly { vscodeKey: string; settingKey: string }[] = [
  { vscodeKey: 'pixel-agents.soundEnabled', settingKey: 'pixel-agents.soundEnabled' },
  { vscodeKey: 'pixel-agents.lastSeenVersion', settingKey: 'pixel-agents.lastSeenVersion' },
  { vscodeKey: 'pixel-agents.alwaysShowLabels', settingKey: 'pixel-agents.alwaysShowLabels' },
  { vscodeKey: 'pixel-agents.watchAllSessions', settingKey: 'pixel-agents.watchAllSessions' },
  { vscodeKey: 'pixel-agents.hooksEnabled', settingKey: 'pixel-agents.hooksEnabled' },
  { vscodeKey: 'pixel-agents.hooksInfoShown', settingKey: 'pixel-agents.hooksInfoShown' },
];

const WORKSPACE_KEY_AGENTS = 'pixel-agents.agents';
const WORKSPACE_KEY_AGENT_SEATS = 'pixel-agents.agentSeats';
const WORKSPACE_KEY_LAYOUT = 'pixel-agents.layout';

export function migrateVsCodeState(context: vscode.ExtensionContext, adapter: StateAdapter): void {
  const pending: string[] = [];

  for (const { vscodeKey, settingKey } of SETTINGS_MIGRATIONS) {
    const legacyValue = context.globalState.get<unknown>(vscodeKey);
    if (legacyValue === undefined) continue;

    try {
      adapter.setSetting(settingKey, legacyValue);
      const verify = adapter.getSetting<unknown>(settingKey, undefined);
      if (deepEqual(verify, legacyValue)) {
        void context.globalState.update(vscodeKey, undefined);
      } else {
        pending.push(vscodeKey);
      }
    } catch {
      pending.push(vscodeKey);
    }
  }

  const legacyAgents = context.workspaceState.get<PersistedAgent[]>(WORKSPACE_KEY_AGENTS);
  if (legacyAgents && legacyAgents.length > 0) {
    try {
      adapter.saveAgents(legacyAgents);
      if (deepEqual(adapter.loadAgents(), legacyAgents)) {
        void context.workspaceState.update(WORKSPACE_KEY_AGENTS, undefined);
      } else {
        pending.push(WORKSPACE_KEY_AGENTS);
      }
    } catch {
      pending.push(WORKSPACE_KEY_AGENTS);
    }
  }

  type SeatsMap = Record<string, { palette?: number; hueShift?: number; seatId?: string }>;
  const legacySeats = context.workspaceState.get<SeatsMap>(WORKSPACE_KEY_AGENT_SEATS);
  if (legacySeats && Object.keys(legacySeats).length > 0) {
    try {
      adapter.saveSeats(legacySeats);
      if (deepEqual(adapter.loadSeats(), legacySeats)) {
        void context.workspaceState.update(WORKSPACE_KEY_AGENT_SEATS, undefined);
      } else {
        pending.push(WORKSPACE_KEY_AGENT_SEATS);
      }
    } catch {
      pending.push(WORKSPACE_KEY_AGENT_SEATS);
    }
  }

  const legacyLayout = context.workspaceState.get<Record<string, unknown>>(WORKSPACE_KEY_LAYOUT);
  if (legacyLayout) {
    try {
      if (readLayoutFromFile()) {
        void context.workspaceState.update(WORKSPACE_KEY_LAYOUT, undefined);
      } else {
        writeLayoutToFile(legacyLayout);
        if (deepEqual(readLayoutFromFile(), legacyLayout)) {
          void context.workspaceState.update(WORKSPACE_KEY_LAYOUT, undefined);
        } else {
          pending.push(WORKSPACE_KEY_LAYOUT);
        }
      }
    } catch {
      pending.push(WORKSPACE_KEY_LAYOUT);
    }
  }

  if (pending.length > 0) {
    console.warn(
      `[Pixel Agents] Migration incomplete -- ${pending.length} legacy VS Code ` +
        `key(s) still present. Will retry next activate. Keys: ${pending.join(', ')}`,
    );
    void vscode.window.showWarningMessage(
      `Pixel Agents: ${pending.length} legacy setting(s) could not be migrated to ` +
        `~/.pixel-agents/config.json. Check ~/.pixel-agents/ is writable.`,
    );
  }
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (typeof a !== typeof b) return false;
  if (typeof a !== 'object') return false;
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}
