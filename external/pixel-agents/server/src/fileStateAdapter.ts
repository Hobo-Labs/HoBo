
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import type { StateAdapter } from '../../core/src/adapter.js';
import type { PersistedAgent } from '../../core/src/schemas.js';
import type { AdapterSettingKey, AdapterSettings, ConfigNamespace } from './configPersistence.js';
import { ADAPTER_SETTING_KEYS, readConfig, writeConfig } from './configPersistence.js';
import { LAYOUT_FILE_DIR } from './constants.js';

const ADAPTER_SETTING_KEY_SET: ReadonlySet<string> = new Set(ADAPTER_SETTING_KEYS);

function settingNameOf(key: string): AdapterSettingKey | null {
  const bare = key.startsWith('pixel-agents.') ? key.slice('pixel-agents.'.length) : key;
  return ADAPTER_SETTING_KEY_SET.has(bare) ? (bare as AdapterSettingKey) : null;
}

interface AdapterState {
  agents: PersistedAgent[];
  seats: Record<string, { palette?: number; hueShift?: number; seatId?: string }>;
}

const EMPTY_STATE: AdapterState = { agents: [], seats: {} };

export interface FileStateAdapterOptions {
  namespace: ConfigNamespace;
}

export class FileStateAdapter implements StateAdapter {
  private readonly namespace: ConfigNamespace;
  private readonly stateFilePath: string;

  constructor(options: FileStateAdapterOptions) {
    this.namespace = options.namespace;
    this.stateFilePath = path.join(
      os.homedir(),
      LAYOUT_FILE_DIR,
      `${options.namespace}-state.json`,
    );
  }


  getSetting<T>(key: string, defaultValue: T): T {
    const field = settingNameOf(key);
    if (!field) return defaultValue;
    const config = readConfig();
    return config[this.namespace][field] as unknown as T;
  }

  setSetting<T>(key: string, value: T): void {
    const field = settingNameOf(key);
    if (!field) return;
    const config = readConfig();
    (config[this.namespace] as unknown as Record<string, unknown>)[field] = value;
    writeConfig(config);
  }


  loadAgents(): PersistedAgent[] {
    return this.readState().agents;
  }

  saveAgents(agents: PersistedAgent[]): void {
    const state = this.readState();
    state.agents = agents;
    this.writeState(state);
  }

  loadSeats(): Record<string, { palette?: number; hueShift?: number; seatId?: string }> {
    return this.readState().seats;
  }

  saveSeats(seats: Record<string, { palette?: number; hueShift?: number; seatId?: string }>): void {
    const state = this.readState();
    state.seats = seats;
    this.writeState(state);
  }


  private readState(): AdapterState {
    try {
      if (!fs.existsSync(this.stateFilePath)) {
        return { agents: [], seats: {} };
      }
      const raw = fs.readFileSync(this.stateFilePath, 'utf-8');
      const parsed = JSON.parse(raw) as Partial<AdapterState>;
      return {
        agents: Array.isArray(parsed.agents) ? (parsed.agents as PersistedAgent[]) : [],
        seats:
          parsed.seats && typeof parsed.seats === 'object'
            ? (parsed.seats as AdapterState['seats'])
            : {},
      };
    } catch (err) {
      console.error('[Pixel Agents] Failed to read adapter state:', err);
      return { ...EMPTY_STATE };
    }
  }

  private writeState(state: AdapterState): void {
    const dir = path.dirname(this.stateFilePath);
    try {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      const json = JSON.stringify(state, null, 2);
      const tmpPath = this.stateFilePath + '.tmp';
      fs.writeFileSync(tmpPath, json, 'utf-8');
      fs.renameSync(tmpPath, this.stateFilePath);
    } catch (err) {
      console.error('[Pixel Agents] Failed to write adapter state:', err);
    }
  }
}

/** @public */
export type { AdapterSettings, ConfigNamespace };
