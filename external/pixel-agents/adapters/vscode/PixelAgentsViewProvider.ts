import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

import type { StateAdapter } from '../../core/src/adapter.js';
import { buildAgentDiagnostics } from '../../server/src/agentDiagnostics.js';
import { AgentRuntime } from '../../server/src/agentRuntime.js';
import { AgentStateStore } from '../../server/src/agentStateStore.js';
import type {
  LoadedAssets,
  LoadedCharacterSprites,
  LoadedPetSprites,
} from '../../server/src/assetLoader.js';
import {
  loadCarpetTiles,
  loadDefaultLayout,
  loadFloorTiles,
  loadWallTiles,
  sendAssetsToWebview,
  sendCarpetTilesToWebview,
  sendCharacterSpritesToWebview,
  sendFloorTilesToWebview,
  sendPetSpritesToWebview,
  sendWallTilesToWebview,
} from '../../server/src/assetLoader.js';
import { loadAllCharacters, loadAllFurniture, loadAllPets } from '../../server/src/assetReload.js';
import { readConfig, writeConfig } from '../../server/src/configPersistence.js';
import { setFolderNameResolver, setTerminalAdapter } from '../../server/src/fileWatcher.js';
import type { LayoutWatcher } from '../../server/src/layoutPersistence.js';
import {
  readLayoutFromFile,
  watchLayoutFile,
  writeLayoutToFile,
} from '../../server/src/layoutPersistence.js';
import { PathSet } from '../../server/src/pathKey.js';
import { claudeProvider, copyHookScript } from '../../server/src/providers/index.js';
import { PixelAgentsServer } from '../../server/src/server.js';
import {
  getProjectDirPath,
  launchNewTerminal,
  restoreAgents,
  sendCurrentAgentStatuses,
  sendExistingAgents,
  sendLayout,
} from './agentManager.js';
import {
  CONFIG_KEY_AUTO_SHOW_PANEL,
  CONFIG_KEY_AUTO_SPAWN_AGENT,
  GLOBAL_KEY_ALWAYS_SHOW_LABELS,
  GLOBAL_KEY_HOOKS_ENABLED,
  GLOBAL_KEY_HOOKS_INFO_SHOWN,
  GLOBAL_KEY_LAST_SEEN_VERSION,
  GLOBAL_KEY_SHOW_AREAS,
  GLOBAL_KEY_SOUND_ENABLED,
  GLOBAL_KEY_WATCH_ALL_SESSIONS,
  LAYOUT_REVISION_KEY,
} from './constants.js';
import { VscodeTerminalAdapter } from './vscodeTerminalAdapter.js';

const MAX_PENDING_BROADCASTS = 1_000;

export class PixelAgentsViewProvider implements vscode.WebviewViewProvider {
  store = new AgentStateStore();
  webviewView: vscode.WebviewView | undefined;

  private isWebviewReady = false;
  private pendingBroadcasts: Array<Record<string, unknown>> = [];

  private runtime: AgentRuntime;

  private globalDismissedFiles = new Set<string>();

  defaultLayout: Record<string, unknown> | null = null;

  private assetsRoot: string | null = null;

  layoutWatcher: LayoutWatcher | null = null;

  private pixelAgentsServer: PixelAgentsServer | null = null;
  private adapter: StateAdapter;

  private autoSpawnAttempted = false;

  constructor(
    private readonly context: vscode.ExtensionContext,
    adapter: StateAdapter,
  ) {
    this.adapter = adapter;
    this.store.setAdapter(this.adapter);
    this.store.on('agentAdded', (id, agent) => {
      this.sendOrBuffer({
        type: 'agentCreated',
        id,
        folderName: agent.folderName,
        isExternal: agent.isExternal || undefined,
        isTeammate: agent.leadAgentId !== undefined || undefined,
        teammateName: agent.agentName,
        parentAgentId: agent.leadAgentId,
        teamName: agent.teamName,
        hooksOnly: agent.hooksOnly || undefined,
      });
    });
    this.store.on('agentRemoved', (id) => {
      this.sendOrBuffer({ type: 'agentClosed', id });
    });
    this.store.on('broadcast', (message) => {
      this.sendOrBuffer(message);
    });

    setTerminalAdapter(new VscodeTerminalAdapter());

    setFolderNameResolver(({ cwd, projectDir }) => {
      const folders = vscode.workspace.workspaceFolders;
      if (!folders || folders.length <= 1) return undefined;
      if (cwd) {
        const owning = folders
          .filter((f) => cwd === f.uri.fsPath || cwd.startsWith(f.uri.fsPath + path.sep))
          .sort((a, b) => b.uri.fsPath.length - a.uri.fsPath.length)[0];
        if (owning) return owning.name;
      }
      if (projectDir) {
        const target = path.basename(projectDir);
        const hashOf = (fsPath: string): string => {
          try {
            return path.basename(getProjectDirPath(fsPath));
          } catch {
            return '';
          }
        };
        const owning = folders
          .map((f) => ({ f, hash: hashOf(f.uri.fsPath) }))
          .filter(
            ({ hash }) => hash.length > 0 && (target === hash || target.startsWith(`${hash}-`)),
          )
          .sort((a, b) => b.hash.length - a.hash.length)[0];
        if (owning) return owning.f.name;
      }
      return undefined;
    });

    this.runtime = new AgentRuntime(this.store, claudeProvider);

    this.initServer();
  }

  private get extensionUri(): vscode.Uri {
    return this.context.extensionUri;
  }

  private get webview(): vscode.Webview | undefined {
    return this.webviewView?.webview;
  }

  private sendOrBuffer(message: Record<string, unknown>): void {
    const wv = this.webview;
    if (!wv) return;
    if (this.isWebviewReady) {
      wv.postMessage(message);
      return;
    }
    if (this.pendingBroadcasts.length >= MAX_PENDING_BROADCASTS) {
      console.warn(
        `[Pixel Agents] Webview buffer overflow (${MAX_PENDING_BROADCASTS}). webviewReady never arrived — dropping oldest message.`,
      );
      this.pendingBroadcasts.shift();
    }
    this.pendingBroadcasts.push(message);
  }

  private initServer(): void {
    this.pixelAgentsServer = new PixelAgentsServer();
    this.pixelAgentsServer.onHookEvent((providerId, event) => {
      this.runtime.handleHookEvent(providerId, event);
    });

    this.pixelAgentsServer
      .start({ store: this.store, embedded: true })
      .then((config) => {
        const hooksEnabled = this.adapter.getSetting<boolean>(GLOBAL_KEY_HOOKS_ENABLED, true);
        this.runtime.hooksEnabled.current = hooksEnabled;
        if (hooksEnabled) {
          void claudeProvider.installHooks(`http://127.0.0.1:${config.port}`, config.token);
          copyHookScript(this.context.extensionPath);
        }
        console.log(`[Pixel Agents] Server: ready on port ${config.port}`);
      })
      .catch((e) => {
        console.error(`[Pixel Agents] Failed to start server: ${e}`);
      });
  }

  resolveWebviewView(webviewView: vscode.WebviewView) {
    this.webviewView = webviewView;
    this.isWebviewReady = false;
    this.pendingBroadcasts = [];
    webviewView.webview.options = { enableScripts: true };
    webviewView.webview.html = getWebviewContent(webviewView.webview, this.extensionUri);

    webviewView.webview.onDidReceiveMessage(async (message) => {
      if (message.type === 'launchAgent') {
        const prevAgentIds = new Set(this.store.keys());
        await launchNewTerminal(
          this.store.nextAgentId,
          this.store.nextTerminalIndex,
          this.store,
          this.runtime.activeAgentId,
          this.runtime.knownJsonlFiles,
          this.runtime.fileWatchers,
          this.runtime.pollingTimers,
          this.runtime.waitingTimers,
          this.runtime.permissionTimers,
          this.runtime.jsonlPollTimers,
          this.runtime.projectScanTimer,
          () => this.store.persist(),
          message.folderPath as string | undefined,
          message.bypassPermissions as boolean | undefined,
        );
        for (const [id, agent] of this.store) {
          if (!prevAgentIds.has(id)) {
            this.runtime.registerAgent(agent.sessionId, id);
          }
        }
      } else if (message.type === 'focusAgent') {
        const agent = this.store.get(message.id);
        if (agent) {
          if (agent.terminalRef) {
            agent.terminalRef.show();
          } else if (agent.leadAgentId !== undefined) {
            const lead = this.store.get(agent.leadAgentId);
            if (lead?.terminalRef) {
              lead.terminalRef.show();
            }
          }
        }
      } else if (message.type === 'closeAgent') {
        const agent = this.store.get(message.id);
        if (agent) {
          if (agent.terminalRef) {
            agent.terminalRef.dispose();
          } else {
            this.runtime.dismissalTracker.dismiss(agent.jsonlFile);
            this.runtime.removeAgent(message.id);
          }
        }
      } else if (message.type === 'saveAgentSeats') {
        console.log(`[Pixel Agents] State: saveAgentSeats:`, JSON.stringify(message.seats));
        this.adapter.saveSeats(message.seats);
      } else if (message.type === 'saveLayout') {
        this.layoutWatcher?.markOwnWrite();
        writeLayoutToFile(message.layout as Record<string, unknown>);
      } else if (message.type === 'setSoundEnabled') {
        this.adapter.setSetting(GLOBAL_KEY_SOUND_ENABLED, message.enabled);
      } else if (message.type === 'setLastSeenVersion') {
        this.adapter.setSetting(GLOBAL_KEY_LAST_SEEN_VERSION, message.version as string);
      } else if (message.type === 'setAlwaysShowLabels') {
        this.adapter.setSetting(GLOBAL_KEY_ALWAYS_SHOW_LABELS, message.enabled);
      } else if (message.type === 'setHooksEnabled') {
        const enabled = message.enabled as boolean;
        this.adapter.setSetting(GLOBAL_KEY_HOOKS_ENABLED, enabled);
        this.runtime.hooksEnabled.current = enabled;
        if (enabled) {
          const serverConfig = this.pixelAgentsServer?.getConfig();
          void claudeProvider.installHooks(
            serverConfig ? `http://127.0.0.1:${serverConfig.port}` : '',
            serverConfig?.token ?? '',
          );
          copyHookScript(this.context.extensionPath);
          console.log('[Pixel Agents] Hooks enabled by user');
        } else {
          void claudeProvider.uninstallHooks();
          console.log('[Pixel Agents] Hooks disabled by user');
        }
      } else if (message.type === 'setHooksInfoShown') {
        this.adapter.setSetting(GLOBAL_KEY_HOOKS_INFO_SHOWN, true);
      } else if (message.type === 'setShowAreas') {
        const enabled = message.enabled as boolean;
        this.adapter.setSetting(GLOBAL_KEY_SHOW_AREAS, enabled);
      } else if (message.type === 'saveAreaMappings') {
        const mappings = message.mappings as Record<string, string[]>;
        const cfg = readConfig();
        cfg.vscode.areaMappings = mappings;
        writeConfig(cfg);
      } else if (message.type === 'setWatchAllSessions') {
        const enabled = message.enabled as boolean;
        this.adapter.setSetting(GLOBAL_KEY_WATCH_ALL_SESSIONS, enabled);
        this.runtime.watchAllSessions.current = enabled;
        if (enabled) {
          for (const file of this.globalDismissedFiles) {
            this.runtime.dismissalTracker.clearDismissal(file);
          }
          this.globalDismissedFiles.clear();
        } else {
          const workspaceDirs = new PathSet();
          for (const folder of vscode.workspace.workspaceFolders ?? []) {
            const dir = getProjectDirPath(folder.uri.fsPath);
            if (dir) workspaceDirs.add(dir);
          }
          const toRemove: number[] = [];
          for (const [id, agent] of this.store) {
            if (agent.isExternal && !workspaceDirs.has(agent.projectDir)) {
              toRemove.push(id);
            }
          }
          for (const id of toRemove) {
            const agent = this.store.get(id);
            if (agent) {
              this.runtime.dismissalTracker.dismiss(agent.jsonlFile);
              this.globalDismissedFiles.add(agent.jsonlFile);
              this.runtime.knownJsonlFiles.delete(agent.jsonlFile);
            }
            this.runtime.removeAgent(id);
          }
        }
      } else if (message.type === 'webviewReady') {
        this.isWebviewReady = true;
        const buffered = this.pendingBroadcasts;
        this.pendingBroadcasts = [];
        for (const msg of buffered) {
          this.webview?.postMessage(msg);
        }
        this.webview?.postMessage({
          type: 'providerCapabilities',
          readingTools: [...claudeProvider.readingTools],
          subagentToolNames: [...claudeProvider.subagentToolNames],
        });

        const soundEnabled = this.adapter.getSetting<boolean>(GLOBAL_KEY_SOUND_ENABLED, true);
        const lastSeenVersion = this.adapter.getSetting<string>(GLOBAL_KEY_LAST_SEEN_VERSION, '');
        const extensionVersion =
          (this.context.extension.packageJSON as { version?: string }).version ?? '';
        const watchAllSessions = this.adapter.getSetting<boolean>(
          GLOBAL_KEY_WATCH_ALL_SESSIONS,
          false,
        );
        const alwaysShowLabels = this.adapter.getSetting<boolean>(
          GLOBAL_KEY_ALWAYS_SHOW_LABELS,
          false,
        );
        this.runtime.watchAllSessions.current = watchAllSessions;
        const hooksEnabled = this.adapter.getSetting<boolean>(GLOBAL_KEY_HOOKS_ENABLED, true);
        const hooksInfoShown = this.adapter.getSetting<boolean>(GLOBAL_KEY_HOOKS_INFO_SHOWN, false);
        const showAreas = this.adapter.getSetting<boolean>(GLOBAL_KEY_SHOW_AREAS, false);
        const config = readConfig();
        this.webview?.postMessage({
          type: 'settingsLoaded',
          soundEnabled,
          lastSeenVersion,
          extensionVersion,
          watchAllSessions,
          alwaysShowLabels,
          hooksEnabled,
          hooksInfoShown,
          externalAssetDirectories: config.externalAssetDirectories,
          showAreas,
        });

        this.webview?.postMessage({
          type: 'areaMappingsLoaded',
          mappings: config.vscode.areaMappings ?? {},
        });

        restoreAgents(
          this.adapter,
          this.store.nextAgentId,
          this.store.nextTerminalIndex,
          this.store,
          this.runtime.knownJsonlFiles,
          this.runtime.fileWatchers,
          this.runtime.pollingTimers,
          this.runtime.waitingTimers,
          this.runtime.permissionTimers,
          this.runtime.jsonlPollTimers,
          this.runtime.projectScanTimer,
          this.runtime.activeAgentId,
        );
        for (const agent of this.store.values()) {
          this.runtime.registerAgent(agent.sessionId, agent.id);
        }

        if (
          !this.autoSpawnAttempted &&
          vscode.workspace.getConfiguration().get<boolean>(CONFIG_KEY_AUTO_SPAWN_AGENT, false) &&
          this.store.size === 0
        ) {
          this.autoSpawnAttempted = true;
          console.log('[Pixel Agents] Auto-spawning agent on startup');
          const autoShowPanel = vscode.workspace
            .getConfiguration()
            .get<boolean>(CONFIG_KEY_AUTO_SHOW_PANEL, false);
          const prevAgentIds = new Set(this.store.keys());
          await launchNewTerminal(
            this.store.nextAgentId,
            this.store.nextTerminalIndex,
            this.store,
            this.runtime.activeAgentId,
            this.runtime.knownJsonlFiles,
            this.runtime.fileWatchers,
            this.runtime.pollingTimers,
            this.runtime.waitingTimers,
            this.runtime.permissionTimers,
            this.runtime.jsonlPollTimers,
            this.runtime.projectScanTimer,
            () => this.store.persist(),
            undefined,
            undefined,
            autoShowPanel,
          );
          for (const [id, agent] of this.store) {
            if (!prevAgentIds.has(id)) {
              this.runtime.registerAgent(agent.sessionId, id);
            }
          }
        } else {
          this.autoSpawnAttempted = true;
        }

        const wsFolders = vscode.workspace.workspaceFolders;
        if (wsFolders && wsFolders.length > 1) {
          this.webview?.postMessage({
            type: 'workspaceFolders',
            folders: wsFolders.map((f) => ({ name: f.name, path: f.uri.fsPath })),
          });
        }

        const projectDir = getProjectDirPath();
        const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        console.log(`[Pixel Agents] Debug: Platform: ${process.platform}, arch: ${process.arch}`);
        console.log('[Extension] workspaceRoot:', workspaceRoot);
        console.log('[Extension] projectDir:', projectDir);
        this.runtime.startProjectScan(projectDir);

        this.runtime.startExternalScanning(projectDir);

        if (wsFolders && wsFolders.length > 1) {
          for (const folder of wsFolders) {
            const folderProjectDir = getProjectDirPath(folder.uri.fsPath);
            if (folderProjectDir && folderProjectDir !== projectDir) {
              console.log(`[Pixel Agents] Registering additional project dir: ${folderProjectDir}`);
              this.runtime.startProjectScan(folderProjectDir);
            }
          }
        }

        this.runtime.startStaleCheck();

        (async () => {
          try {
            console.log('[Extension] Loading furniture assets...');
            const extensionPath = this.extensionUri.fsPath;
            console.log('[Extension] extensionPath:', extensionPath);

            const bundledAssetsDir = path.join(extensionPath, 'dist', 'assets');
            let assetsRoot: string | null = null;
            if (fs.existsSync(bundledAssetsDir)) {
              console.log('[Extension] Found bundled assets at dist/');
              assetsRoot = path.join(extensionPath, 'dist');
            } else if (workspaceRoot) {
              console.log('[Extension] Trying workspace for assets...');
              assetsRoot = workspaceRoot;
            }

            if (!assetsRoot) {
              console.log('[Extension] ⚠️  No assets directory found');
              if (this.webview) {
                sendLayout(this.webview, this.defaultLayout);
                sendCurrentAgentStatuses(this.store, this.webview);
                this.startLayoutWatcher();
              }
              return;
            }

            console.log('[Extension] Using assetsRoot:', assetsRoot);
            this.assetsRoot = assetsRoot;

            this.defaultLayout = loadDefaultLayout(assetsRoot);

            const charSprites = await this.loadAllCharacterSprites();
            if (charSprites && this.webview) {
              console.log(
                `[Extension] ${charSprites.characters.length} character sprites loaded, sending to webview`,
              );
              sendCharacterSpritesToWebview(this.webview, charSprites);
            }

            const petSprites = await this.loadAllPetSprites();
            if (petSprites && this.webview) {
              console.log(
                `[Extension] ${petSprites.pets.length} pet sprites loaded, sending to webview`,
              );
              sendPetSpritesToWebview(this.webview, petSprites);
            }

            const floorTiles = await loadFloorTiles(assetsRoot);
            if (floorTiles && this.webview) {
              console.log('[Extension] Floor tiles loaded, sending to webview');
              sendFloorTilesToWebview(this.webview, floorTiles);
            }

            const wallTiles = await loadWallTiles(assetsRoot);
            if (wallTiles && this.webview) {
              console.log('[Extension] Wall tiles loaded, sending to webview');
              sendWallTilesToWebview(this.webview, wallTiles);
            }

            const carpetTiles = await loadCarpetTiles(assetsRoot);
            if (carpetTiles && this.webview) {
              console.log('[Extension] Carpet tiles loaded, sending to webview');
              sendCarpetTilesToWebview(this.webview, carpetTiles);
            }

            const assets = await this.loadAllFurnitureAssets();
            if (assets && this.webview) {
              console.log('[Extension] ✅ Assets loaded, sending to webview');
              sendAssetsToWebview(this.webview, assets);
            }
          } catch (err) {
            console.error('[Extension] ❌ Error loading assets:', err);
          }
          if (this.webview) {
            console.log('[Extension] Sending saved layout');
            sendLayout(this.webview, this.defaultLayout);
            sendCurrentAgentStatuses(this.store, this.webview);
            this.startLayoutWatcher();
          }
        })();
        sendExistingAgents(this.store, this.adapter, this.webview);
      } else if (message.type === 'requestDiagnostics') {
        this.webview?.postMessage({
          type: 'agentDiagnostics',
          agents: buildAgentDiagnostics(this.store),
        });
      } else if (message.type === 'openSessionsFolder') {
        const projectDir = getProjectDirPath();
        if (projectDir && fs.existsSync(projectDir)) {
          vscode.env.openExternal(vscode.Uri.file(projectDir));
        }
      } else if (message.type === 'exportLayout') {
        const layout = readLayoutFromFile();
        if (!layout) {
          vscode.window.showWarningMessage('Pixel Agents: No saved layout to export.');
          return;
        }
        const uri = await vscode.window.showSaveDialog({
          filters: { 'JSON Files': ['json'] },
          defaultUri: vscode.Uri.file(path.join(os.homedir(), 'pixel-agents-layout.json')),
        });
        if (uri) {
          fs.writeFileSync(uri.fsPath, JSON.stringify(layout, null, 2), 'utf-8');
          vscode.window.showInformationMessage('Pixel Agents: Layout exported successfully.');
        }
      } else if (message.type === 'addExternalAssetDirectory') {
        const uris = await vscode.window.showOpenDialog({
          canSelectFolders: true,
          canSelectFiles: false,
          canSelectMany: false,
          openLabel: 'Select Asset Directory',
        });
        if (!uris || uris.length === 0) return;
        const newPath = uris[0].fsPath;
        const cfg = readConfig();
        if (!cfg.externalAssetDirectories.includes(newPath)) {
          cfg.externalAssetDirectories.push(newPath);
          writeConfig(cfg);
        }
        await this.reloadAndSendCharacters();
        await this.reloadAndSendPets();
        await this.reloadAndSendFurniture();
        this.webview?.postMessage({
          type: 'externalAssetDirectoriesUpdated',
          dirs: cfg.externalAssetDirectories,
        });
      } else if (message.type === 'removeExternalAssetDirectory') {
        const cfg = readConfig();
        cfg.externalAssetDirectories = cfg.externalAssetDirectories.filter(
          (d) => d !== (message.path as string),
        );
        writeConfig(cfg);
        await this.reloadAndSendCharacters();
        await this.reloadAndSendPets();
        await this.reloadAndSendFurniture();
        this.webview?.postMessage({
          type: 'externalAssetDirectoriesUpdated',
          dirs: cfg.externalAssetDirectories,
        });
      } else if (message.type === 'importLayout') {
        const uris = await vscode.window.showOpenDialog({
          filters: { 'JSON Files': ['json'] },
          canSelectMany: false,
        });
        if (!uris || uris.length === 0) return;
        try {
          const raw = fs.readFileSync(uris[0].fsPath, 'utf-8');
          const imported = JSON.parse(raw) as Record<string, unknown>;
          if (imported.version !== 1 || !Array.isArray(imported.tiles)) {
            vscode.window.showErrorMessage('Pixel Agents: Invalid layout file.');
            return;
          }
          this.layoutWatcher?.markOwnWrite();
          writeLayoutToFile(imported);
          this.webview?.postMessage({ type: 'layoutLoaded', layout: imported });
          vscode.window.showInformationMessage('Pixel Agents: Layout imported successfully.');
        } catch {
          vscode.window.showErrorMessage('Pixel Agents: Failed to read or parse layout file.');
        }
      }
    });

    vscode.window.onDidChangeActiveTerminal((terminal) => {
      if (!terminal) return;
      this.runtime.activeAgentId.current = null;
      for (const [id, agent] of this.store) {
        if (agent.terminalRef && agent.terminalRef === terminal) {
          this.runtime.activeAgentId.current = id;
          webviewView.webview.postMessage({ type: 'agentSelected', id });
          break;
        }
      }
    });

    vscode.window.onDidCloseTerminal((closed) => {
      for (const [id, agent] of this.store) {
        if (agent.terminalRef && agent.terminalRef === closed) {
          if (this.runtime.activeAgentId.current === id) {
            this.runtime.activeAgentId.current = null;
          }
          if (agent.isTeamLead) {
            this.runtime.removeTeammates(id);
          }
          this.runtime.dismissalTracker.dismiss(agent.jsonlFile);
          this.runtime.unregisterAgent(agent.sessionId);
          this.runtime.removeAgent(id);
        }
      }
    });
  }

  exportDefaultLayout(): void {
    const layout = readLayoutFromFile();
    if (!layout) {
      vscode.window.showWarningMessage('Pixel Agents: No saved layout found.');
      return;
    }
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!workspaceRoot) {
      vscode.window.showErrorMessage('Pixel Agents: No workspace folder found.');
      return;
    }
    const assetsDir = path.join(workspaceRoot, 'webview-ui', 'public', 'assets');

    let maxRevision = 0;
    if (fs.existsSync(assetsDir)) {
      for (const file of fs.readdirSync(assetsDir)) {
        const match = /^default-layout-(\d+)\.json$/.exec(file);
        if (match) {
          maxRevision = Math.max(maxRevision, parseInt(match[1], 10));
        }
      }
    }
    const nextRevision = maxRevision + 1;
    layout[LAYOUT_REVISION_KEY] = nextRevision;

    const targetPath = path.join(assetsDir, `default-layout-${nextRevision}.json`);
    const json = JSON.stringify(layout, null, 2);
    fs.writeFileSync(targetPath, json, 'utf-8');
    vscode.window.showInformationMessage(
      `Pixel Agents: Default layout exported as revision ${nextRevision} to ${targetPath}`,
    );
  }

  private async loadAllFurnitureAssets(): Promise<LoadedAssets | null> {
    if (!this.assetsRoot) return null;
    return loadAllFurniture(this.assetsRoot, readConfig().externalAssetDirectories);
  }

  private async loadAllCharacterSprites(): Promise<LoadedCharacterSprites | null> {
    if (!this.assetsRoot) return null;
    return loadAllCharacters(this.assetsRoot, readConfig().externalAssetDirectories);
  }

  private async loadAllPetSprites(): Promise<LoadedPetSprites | null> {
    if (!this.assetsRoot) return null;
    return loadAllPets(this.assetsRoot, readConfig().externalAssetDirectories);
  }

  private async reloadAndSendFurniture(): Promise<void> {
    if (!this.assetsRoot || !this.webview) return;
    try {
      const assets = await this.loadAllFurnitureAssets();
      if (assets) {
        sendAssetsToWebview(this.webview, assets);
      }
    } catch (err) {
      console.error('[Extension] Error reloading furniture assets:', err);
    }
  }

  private async reloadAndSendCharacters(): Promise<void> {
    if (!this.assetsRoot || !this.webview) return;
    try {
      const chars = await this.loadAllCharacterSprites();
      if (chars) {
        sendCharacterSpritesToWebview(this.webview, chars);
      }
    } catch (err) {
      console.error('[Extension] Error reloading character sprites:', err);
    }
  }

  private async reloadAndSendPets(): Promise<void> {
    if (!this.assetsRoot || !this.webview) return;
    try {
      const pets = await this.loadAllPetSprites();
      if (pets) {
        sendPetSpritesToWebview(this.webview, pets);
      }
    } catch (err) {
      console.error('[Extension] Error reloading pet sprites:', err);
    }
  }

  private startLayoutWatcher(): void {
    if (this.layoutWatcher) return;
    this.layoutWatcher = watchLayoutFile((layout) => {
      console.log('[Pixel Agents] External layout change — pushing to webview');
      this.webview?.postMessage({ type: 'layoutLoaded', layout });
    });
  }

  dispose() {
    this.pixelAgentsServer?.stop();
    this.pixelAgentsServer = null;
    this.runtime.dispose();
    this.layoutWatcher?.dispose();
    this.layoutWatcher = null;
    this.store.dispose();
  }
}

function getWebviewContent(webview: vscode.Webview, extensionUri: vscode.Uri): string {
  const distPath = vscode.Uri.joinPath(extensionUri, 'dist', 'webview');
  const indexPath = vscode.Uri.joinPath(distPath, 'index.html').fsPath;

  let html = fs.readFileSync(indexPath, 'utf-8');

  html = html.replace(/(href|src)="\.\/([^"]+)"/g, (_match, attr, filePath) => {
    const fileUri = vscode.Uri.joinPath(distPath, filePath);
    const webviewUri = webview.asWebviewUri(fileUri);
    return `${attr}="${webviewUri}"`;
  });

  return html;
}
