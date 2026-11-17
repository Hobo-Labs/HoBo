import * as crypto from 'crypto';
import type { FastifyInstance } from 'fastify';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import type { AgentRuntime } from './agentRuntime.js';
import type { AgentStateStore } from './agentStateStore.js';
import type {
  AssetCache,
  ReloadAssetsSideEffect,
  SetHooksEnabledSideEffect,
} from './clientMessageHandler.js';
import {
  SERVER_JSON_DIR,
  SERVER_JSON_NAME,
  SERVER_REGISTRY_PROTOCOL_VERSION,
  SERVERS_DIR,
} from './constants.js';
import { createHttpServer } from './httpServer.js';
import type { OtelIngestResult } from './providers/otel/otelProvider.js';
import type { ServerConfig } from './serverConfig.js';
import { isServerConfig, isServerTarget } from './serverConfig.js';

export type { ServerConfig } from './serverConfig.js';

type HookEventCallback = (providerId: string, event: Record<string, unknown>) => void;

export class PixelAgentsServer {
  private app: FastifyInstance | null = null;
  private config: ServerConfig | null = null;
  private ownsServer = false;
  private callback: HookEventCallback | null = null;

  onHookEvent(callback: HookEventCallback): void {
    this.callback = callback;
  }

  async start(options?: {
    store?: AgentStateStore;
    runtime?: AgentRuntime;
    embedded?: boolean;
    host?: string;
    port?: number;
    staticDir?: string;
    assetCache?: AssetCache;
    onSetHooksEnabled?: SetHooksEnabledSideEffect;
    onReloadAssets?: ReloadAssetsSideEffect;
    onOtelTraces?: (body: unknown) => OtelIngestResult;
  }): Promise<ServerConfig> {
    const embedded = options?.embedded ?? true;
    const wantsSpa = !embedded;

    const registry = this.readAndPruneRegistry();
    const candidate = registry.find((e) => e.servesSpa === wantsSpa);
    if (candidate) {
      this.config = candidate;
      this.ownsServer = false;
      console.log(
        `[Pixel Agents] Reusing existing ${wantsSpa ? 'standalone' : 'embedded'} server on port ${candidate.port} (PID ${candidate.pid})`,
      );
      return candidate;
    }

    const token = crypto.randomUUID();
    const store = options?.store;

    const { app, port } = await createHttpServer({
      embedded,
      host: options?.host,
      port: options?.port,
      token,
      store: store!,
      runtime: options?.runtime,
      staticDir: options?.staticDir,
      assetCache: options?.assetCache,
      onHookEvent: (providerId, event) => this.callback?.(providerId, event),
      onSetHooksEnabled: options?.onSetHooksEnabled,
      onReloadAssets: options?.onReloadAssets,
      onOtelTraces: options?.onOtelTraces,
    });

    this.app = app;
    this.config = {
      port,
      pid: process.pid,
      token,
      startedAt: Date.now(),
      servesSpa: wantsSpa,
      protocol: SERVER_REGISTRY_PROTOCOL_VERSION,
      ...(process.env['PIXEL_AGENTS_DEBUG_LOG']
        ? { debugLog: process.env['PIXEL_AGENTS_DEBUG_LOG'] }
        : {}),
    };
    this.ownsServer = true;
    this.writeServerJson(this.config);
    this.writeRegistryEntry(this.config);
    console.log(`[Pixel Agents] Server: listening on 127.0.0.1:${port}`);

    return this.config;
  }

  stop(): void {
    if (this.app) {
      this.app.close();
      this.app = null;
    }
    if (this.ownsServer) {
      this.deleteServerJson();
      this.deleteRegistryEntry();
    }
    this.config = null;
    this.ownsServer = false;
  }

  getConfig(): ServerConfig | null {
    return this.config;
  }

  private getServerJsonPath(): string {
    return path.join(os.homedir(), SERVER_JSON_DIR, SERVER_JSON_NAME);
  }

  private writeServerJson(config: ServerConfig): void {
    const filePath = this.getServerJsonPath();
    const dir = path.dirname(filePath);
    try {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      }
      const tmpPath = filePath + '.tmp';
      fs.writeFileSync(tmpPath, JSON.stringify(config, null, 2), { mode: 0o600 });
      fs.renameSync(tmpPath, filePath);
    } catch (e) {
      console.error(`[Pixel Agents] Failed to write server.json: ${e}`);
    }
  }

  private deleteServerJson(): void {
    try {
      const filePath = this.getServerJsonPath();
      if (!fs.existsSync(filePath)) return;
      const existing = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as unknown;
      if (isServerTarget(existing) && existing.pid === process.pid) {
        fs.unlinkSync(filePath);
      }
    } catch {
    }
  }

  private getRegistryDir(): string {
    return path.join(os.homedir(), SERVER_JSON_DIR, SERVERS_DIR);
  }

  private getRegistryFilePath(config: Pick<ServerConfig, 'pid' | 'port'>): string {
    return path.join(this.getRegistryDir(), `${config.pid}-${config.port}.json`);
  }

  private readAndPruneRegistry(): ServerConfig[] {
    const dir = this.getRegistryDir();
    let files: string[];
    try {
      files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
    } catch {
      return [];
    }

    const live: ServerConfig[] = [];
    for (const file of files) {
      const filePath = path.join(dir, file);
      try {
        const entry = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as unknown;
        if (!isServerConfig(entry)) {
          fs.unlinkSync(filePath);
          continue;
        }
        if (isProcessRunning(entry.pid)) {
          live.push(entry);
        } else {
          fs.unlinkSync(filePath);
        }
      } catch {
        try {
          fs.unlinkSync(filePath);
        } catch {
        }
      }
    }
    return live;
  }

  private writeRegistryEntry(config: ServerConfig): void {
    const dir = this.getRegistryDir();
    try {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      }
      const filePath = this.getRegistryFilePath(config);
      const tmpPath = `${filePath}.tmp`;
      fs.writeFileSync(tmpPath, JSON.stringify(config, null, 2), { mode: 0o600 });
      fs.renameSync(tmpPath, filePath);
    } catch (e) {
      console.error(`[Pixel Agents] Failed to write registry entry: ${e}`);
    }
  }

  private deleteRegistryEntry(): void {
    if (!this.config) return;
    try {
      const filePath = this.getRegistryFilePath(this.config);
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    } catch {
    }
  }
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
