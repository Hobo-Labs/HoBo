import * as fs from 'fs';
import * as path from 'path';
import type * as vscode from 'vscode';

const debug = process.env.PIXEL_AGENTS_DEBUG !== '0';

import type { FileProvider, HookProvider } from '../../core/src/provider.js';
import type { ITerminalAdapter } from '../../core/src/terminalAdapter.js';
import type { AgentStateStore } from './agentStateStore.js';
import {
  CLEAR_IDLE_THRESHOLD_MS,
  EXTERNAL_ACTIVE_THRESHOLD_MS,
  EXTERNAL_SCAN_INTERVAL_MS,
  EXTERNAL_STALE_CHECK_INTERVAL_MS,
  FILE_WATCHER_POLL_INTERVAL_MS,
  GLOBAL_SCAN_ACTIVE_MAX_AGE_MS,
  GLOBAL_SCAN_ACTIVE_MIN_SIZE,
  PROJECT_SCAN_INTERVAL_MS,
} from './constants.js';
import type { DismissalTracker } from './dismissalTracker.js';
import { pathsMatch } from './pathKey.js';
import { cancelPermissionTimer, cancelWaitingTimer, clearAgentActivity } from './timerManager.js';
import { processTranscriptLine } from './transcriptParser.js';
import type { AgentState } from './types.js';

export interface TranscriptContext {
  agentId: number;
  agents: AgentStateStore;
  waitingTimers: Map<number, ReturnType<typeof setTimeout>>;
  permissionTimers: Map<number, ReturnType<typeof setTimeout>>;
}

type SessionProvider = HookProvider | FileProvider<TranscriptContext>;
const sessionProviders = new WeakMap<AgentStateStore, SessionProvider>();

export function setSessionProvider(agents: AgentStateStore, provider: SessionProvider): void {
  sessionProviders.set(agents, provider);
}

function matchesSessionFile(agents: AgentStateStore, fileName: string): boolean {
  const provider = sessionProviders.get(agents);
  return provider?.kind === 'file'
    ? provider.matchesSessionFile(fileName)
    : fileName.endsWith('.jsonl');
}

function sessionIdFromFile(agents: AgentStateStore, filePath: string): string {
  const provider = sessionProviders.get(agents);
  return provider?.kind === 'file'
    ? provider.sessionIdFromFile(filePath)
    : path.basename(filePath, '.jsonl');
}

function supportsClearDetection(agents: AgentStateStore): boolean {
  const provider = sessionProviders.get(agents);
  return provider?.kind !== 'file' || provider.supportsClearDetection === true;
}

let dismissalTracker: DismissalTracker | null = null;

export function setDismissalTracker(tracker: DismissalTracker): void {
  dismissalTracker = tracker;
}

export function getDismissalTracker(): DismissalTracker | null {
  return dismissalTracker;
}

let terminalAdapter: ITerminalAdapter | null = null;

export function setTerminalAdapter(adapter: ITerminalAdapter): void {
  terminalAdapter = adapter;
}

let agentRemovalCallback: ((id: number) => void) | null = null;

export function setAgentRemovalCallback(cb: typeof agentRemovalCallback): void {
  agentRemovalCallback = cb;
}

let clearDetectionDeps: {
  projectDir: string;
  knownJsonlFiles: Set<string>;
  activeAgentIdRef: { current: number | null };
  fileWatchers: Map<number, fs.FSWatcher>;
  pollingTimers: Map<number, ReturnType<typeof setInterval>>;
  waitingTimers: Map<number, ReturnType<typeof setTimeout>>;
  permissionTimers: Map<number, ReturnType<typeof setTimeout>>;
  persistAgents: () => void;
} | null = null;

export function startFileWatching(
  agentId: number,
  _filePath: string,
  agents: AgentStateStore,
  _fileWatchers: Map<number, fs.FSWatcher>,
  pollingTimers: Map<number, ReturnType<typeof setInterval>>,
  waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
  permissionTimers: Map<number, ReturnType<typeof setTimeout>>,
): void {
  const interval = setInterval(() => {
    if (!agents.has(agentId)) {
      clearInterval(interval);
      return;
    }
    const agent = agents.get(agentId)!;
    const prevOffset = agent.fileOffset;
    readNewLines(agentId, agents, waitingTimers, permissionTimers);

    if (
      supportsClearDetection(agents) &&
      !agent.hookDelivered &&
      clearDetectionDeps &&
      agent.fileOffset === prevOffset &&
      agent.terminalRef &&
      !agent.isExternal &&
      ![...agents.values()].some((a) => a.isExternal) &&
      agent.linesProcessed > 0 &&
      clearDetectionDeps.activeAgentIdRef.current === agentId &&
      Date.now() - agent.lastDataAt > CLEAR_IDLE_THRESHOLD_MS
    ) {
      const deps = clearDetectionDeps;
      try {
        const dirFiles = fs
          .readdirSync(deps.projectDir)
          .filter((f) => matchesSessionFile(agents, f))
          .map((f) => path.join(deps.projectDir, f));
        for (const file of dirFiles) {
          if (deps.knownJsonlFiles.has(file)) continue;
          if (dismissalTracker!.isDismissed(file)) continue;
          let tracked = false;
          for (const a of agents.values()) {
            if (pathsMatch(a.jsonlFile, file)) {
              tracked = true;
              break;
            }
          }
          if (tracked) continue;
          try {
            const buf = Buffer.alloc(8192);
            const fd = fs.openSync(file, 'r');
            const bytesRead = fs.readSync(fd, buf, 0, 8192, 0);
            fs.closeSync(fd);
            if (!buf.toString('utf-8', 0, bytesRead).includes('/clear</command-name>')) continue;
          } catch {
            continue;
          }
          deps.knownJsonlFiles.add(file);
          console.log(
            `[Pixel Agents] Watcher: Agent ${agentId} - /clear detected, reassigning to ${path.basename(file)}`,
          );
          reassignAgentToFile(
            agentId,
            file,
            agents,
            deps.fileWatchers,
            deps.pollingTimers,
            deps.waitingTimers,
            deps.permissionTimers,
            deps.persistAgents,
          );
          break;
        }
      } catch {}
    }
  }, FILE_WATCHER_POLL_INTERVAL_MS);
  pollingTimers.set(agentId, interval);
}

export function readNewLines(
  agentId: number,
  agents: AgentStateStore,
  waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
  permissionTimers: Map<number, ReturnType<typeof setTimeout>>,
): void {
  const agent = agents.get(agentId);
  if (!agent) return;
  try {
    const stat = fs.statSync(agent.jsonlFile);
    if (stat.size <= agent.fileOffset) return;

    const MAX_READ_BYTES = 65536;
    const bytesToRead = Math.min(stat.size - agent.fileOffset, MAX_READ_BYTES);
    const buf = Buffer.alloc(bytesToRead);
    const fd = fs.openSync(agent.jsonlFile, 'r');
    fs.readSync(fd, buf, 0, buf.length, agent.fileOffset);
    fs.closeSync(fd);
    agent.fileOffset += bytesToRead;

    const text = agent.lineBuffer + buf.toString('utf-8');
    const lines = text.split('\n');
    agent.lineBuffer = lines.pop() || '';

    const hasLines = lines.some((l) => l.trim());
    if (hasLines) {
      cancelWaitingTimer(agentId, waitingTimers);
      cancelPermissionTimer(agentId, permissionTimers);
      if (agent.permissionSent && !agent.hookDelivered && !agent.leadAgentId) {
        agent.permissionSent = false;
        agents.broadcast({ type: 'agentToolPermissionClear', id: agentId });
      }
    }

    for (const line of lines) {
      if (!line.trim()) continue;
      agent.lastDataAt = Date.now();
      agent.linesProcessed++;
      const provider = sessionProviders.get(agents);
      if (provider?.kind === 'file') {
        try {
          provider.processTranscriptLine(line, {
            agentId,
            agents,
            waitingTimers,
            permissionTimers,
          });
        } catch (error) {
          console.error(`[Pixel Agents] Watcher: Agent ${agentId} - transcript error: ${error}`);
        }
      } else {
        processTranscriptLine(agentId, line, agents, waitingTimers, permissionTimers);
      }
    }
  } catch (e) {
    if (e instanceof Error && 'code' in e && (e as NodeJS.ErrnoException).code === 'ENOENT') return;
    console.log(`[Pixel Agents] Watcher: Agent ${agentId} - read error: ${e}`);
  }
}

const trackedProjectDirs = new Set<string>();

export function isTrackedProjectDir(dir: string): boolean {
  if (trackedProjectDirs.has(dir)) return true;
  for (const tracked of trackedProjectDirs) {
    if (pathsMatch(tracked, dir)) return true;
  }
  return false;
}

export function ensureProjectScan(
  projectDir: string,
  knownJsonlFiles: Set<string>,
  projectScanTimerRef: { current: ReturnType<typeof setInterval> | null },
  activeAgentIdRef: { current: number | null },
  nextAgentIdRef: { current: number },
  agents: AgentStateStore,
  fileWatchers: Map<number, fs.FSWatcher>,
  pollingTimers: Map<number, ReturnType<typeof setInterval>>,
  waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
  permissionTimers: Map<number, ReturnType<typeof setTimeout>>,

  persistAgents: () => void,
  _onAgentCreated?: (agent: AgentState) => void,
  hooksEnabledRef?: { current: boolean },
): void {
  if (!clearDetectionDeps) {
    clearDetectionDeps = {
      projectDir,
      knownJsonlFiles,
      activeAgentIdRef,
      fileWatchers,
      pollingTimers,
      waitingTimers,
      permissionTimers,
      persistAgents,
    };
  }

  try {
    const files = fs
      .readdirSync(projectDir)
      .filter((f) => matchesSessionFile(agents, f))
      .map((f) => path.join(projectDir, f));
    for (const f of files) {
      knownJsonlFiles.add(f);
      try {
        const stat = fs.statSync(f);
        dismissalTracker!.seedMtime(f, stat.mtimeMs);
      } catch {}
    }
  } catch {}

  trackedProjectDirs.add(projectDir);

  if (projectScanTimerRef.current) return;
  projectScanTimerRef.current = setInterval(() => {
    scanAllTeammateFiles(
      nextAgentIdRef,
      agents,
      fileWatchers,
      pollingTimers,
      waitingTimers,
      permissionTimers,
      persistAgents,
    );

    const toRemove = scanTeamConfigsForRemovals(agents);
    for (const id of toRemove) {
      teammateRemovalCallback?.(id);
    }

    if (hooksEnabledRef?.current) return;

    for (const dir of trackedProjectDirs) {
      scanForNewJsonlFiles(
        dir,
        knownJsonlFiles,
        activeAgentIdRef,
        nextAgentIdRef,
        agents,
        fileWatchers,
        pollingTimers,
        waitingTimers,
        permissionTimers,
        persistAgents,
      );
    }
  }, PROJECT_SCAN_INTERVAL_MS);
}

export function scanForNewJsonlFiles(
  projectDir: string,
  knownJsonlFiles: Set<string>,
  activeAgentIdRef: { current: number | null },
  nextAgentIdRef: { current: number },
  agents: AgentStateStore,
  fileWatchers: Map<number, fs.FSWatcher>,
  pollingTimers: Map<number, ReturnType<typeof setInterval>>,
  waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
  permissionTimers: Map<number, ReturnType<typeof setTimeout>>,

  persistAgents: () => void,
  onAgentCreated?: (agent: AgentState) => void,
): void {
  const terminalNamePrefix = sessionProviders.get(agents)?.terminalNamePrefix;
  let files: string[];
  try {
    files = fs
      .readdirSync(projectDir)
      .filter((f) => matchesSessionFile(agents, f))
      .map((f) => path.join(projectDir, f));
  } catch {
    return;
  }

  for (const file of files) {
    if (knownJsonlFiles.has(file)) continue;

    const activeTerminal = terminalAdapter?.activeTerminal() as vscode.Terminal | undefined;
    if (
      activeTerminal &&
      terminalNamePrefix &&
      activeTerminal.name.startsWith(terminalNamePrefix)
    ) {
      let owned = false;
      for (const agent of agents.values()) {
        if (agent.terminalRef === activeTerminal) {
          owned = true;
          break;
        }
      }
      if (!owned) {
        knownJsonlFiles.add(file);
        adoptTerminalForFile(
          activeTerminal,
          file,
          projectDir,
          nextAgentIdRef,
          agents,
          activeAgentIdRef,
          fileWatchers,
          pollingTimers,
          waitingTimers,
          permissionTimers,
          persistAgents,
        );
      } else {
        for (const terminal of (terminalAdapter?.allTerminals() ?? []) as vscode.Terminal[]) {
          if (!terminalNamePrefix || !terminal.name.startsWith(terminalNamePrefix)) continue;
          let owned = false;
          for (const agent of agents.values()) {
            if (agent.terminalRef === terminal) {
              owned = true;
              break;
            }
          }
          if (!owned) {
            knownJsonlFiles.add(file);
            adoptTerminalForFile(
              terminal,
              file,
              projectDir,
              nextAgentIdRef,
              agents,
              activeAgentIdRef,
              fileWatchers,
              pollingTimers,
              waitingTimers,
              permissionTimers,
              persistAgents,
              onAgentCreated,
            );
            break;
          }
        }
      }
    }
  }

  for (const [id, agent] of agents) {
    if (agent.isExternal) continue;
    if (agent.terminalRef && agent.terminalRef.exitStatus !== undefined) {
      console.log(`[Pixel Agents] Watcher: Agent ${id} - terminal closed, cleaning up orphan`);
      agentRemovalCallback?.(id);
    }
  }
}

function adoptTerminalForFile(
  terminal: vscode.Terminal,
  jsonlFile: string,
  projectDir: string,
  nextAgentIdRef: { current: number },
  agents: AgentStateStore,
  activeAgentIdRef: { current: number | null },
  fileWatchers: Map<number, fs.FSWatcher>,
  pollingTimers: Map<number, ReturnType<typeof setInterval>>,
  waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
  permissionTimers: Map<number, ReturnType<typeof setTimeout>>,

  persistAgents: () => void,
  onAgentCreated?: (agent: AgentState) => void,
): void {
  const id = nextAgentIdRef.current++;
  const sessionId = sessionIdFromFile(agents, jsonlFile);
  let fileOffset = 0;
  try {
    const stat = fs.statSync(jsonlFile);
    fileOffset = stat.size;
  } catch {}
  const agent: AgentState = {
    id,
    sessionId,
    terminalRef: terminal,
    isExternal: false,
    projectDir,
    jsonlFile,
    fileOffset,
    lineBuffer: '',
    activeToolIds: new Set(),
    activeToolStatuses: new Map(),
    activeToolNames: new Map(),
    activeSubagentToolIds: new Map(),
    activeSubagentToolNames: new Map(),
    backgroundAgentToolIds: new Set(),
    isWaiting: false,
    permissionSent: false,
    hadToolsInTurn: false,
    lastDataAt: 0,
    linesProcessed: 0,
    seenUnknownRecordTypes: new Set(),
    hookDelivered: false,
    inputTokens: 0,
    outputTokens: 0,
  };

  agents.set(id, agent);
  activeAgentIdRef.current = id;
  persistAgents();
  onAgentCreated?.(agent);

  console.log(
    `[Pixel Agents] Watcher: Agent ${id} - adopted terminal "${terminal.name}" for ${path.basename(jsonlFile)}`,
  );

  startFileWatching(
    id,
    jsonlFile,
    agents,
    fileWatchers,
    pollingTimers,
    waitingTimers,
    permissionTimers,
  );
  readNewLines(id, agents, waitingTimers, permissionTimers);
}

const knownTeammateFiles = new Set<string>();

let teammateRemovalCallback: ((teammateAgentId: number) => void) | null = null;

export function setTeammateRemovalCallback(cb: (teammateAgentId: number) => void): void {
  teammateRemovalCallback = cb;
}

export type FolderNameResolver = (ctx: { cwd?: string; projectDir?: string }) => string | undefined;

let folderNameResolver: FolderNameResolver | null = null;

export function setFolderNameResolver(resolver: FolderNameResolver): void {
  folderNameResolver = resolver;
}

export function scanForTeammateFiles(
  projectDir: string,
  sessionId: string,
  parentAgentId: number,
  nextAgentIdRef: { current: number },
  agents: AgentStateStore,
  fileWatchers: Map<number, fs.FSWatcher>,
  pollingTimers: Map<number, ReturnType<typeof setInterval>>,
  waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
  permissionTimers: Map<number, ReturnType<typeof setTimeout>>,

  persistAgents: () => void,
  onAgentCreated?: (agent: AgentState) => void,
): void {
  const teamProvider = sessionProviders.get(agents)?.team;
  if (!teamProvider) return;
  const teammates = teamProvider.discoverTeammates(projectDir, sessionId);

  const parentAgent = agents.get(parentAgentId);

  for (const { jsonlPath: file, teammateName } of teammates) {
    if (knownTeammateFiles.has(file)) continue;

    let alreadyTracked = false;
    for (const a of agents.values()) {
      if (pathsMatch(a.jsonlFile, file)) {
        alreadyTracked = true;
        break;
      }
    }
    if (alreadyTracked) continue;

    knownTeammateFiles.add(file);

    let existingTeammate: AgentState | undefined;
    for (const a of agents.values()) {
      if (a.leadAgentId === parentAgentId && a.agentName === teammateName) {
        existingTeammate = a;
        break;
      }
    }
    if (existingTeammate) {
      if (debug)
        console.log(
          `[Pixel Agents] Teammate "${teammateName}" already exists (Agent ${existingTeammate.id}), reassigning to ${path.basename(file)}`,
        );
      const oldTimer = pollingTimers.get(existingTeammate.id);
      if (oldTimer) clearInterval(oldTimer);
      pollingTimers.delete(existingTeammate.id);
      existingTeammate.jsonlFile = file;
      existingTeammate.fileOffset = 0;
      existingTeammate.lineBuffer = '';
      existingTeammate.lastDataAt = Date.now();
      existingTeammate.linesProcessed = 0;
      existingTeammate.isWaiting = false;
      existingTeammate.teamUsesTmux = parentAgent?.teamUsesTmux;
      startFileWatching(
        existingTeammate.id,
        file,
        agents,
        fileWatchers,
        pollingTimers,
        waitingTimers,
        permissionTimers,
      );
      readNewLines(existingTeammate.id, agents, waitingTimers, permissionTimers);
      continue;
    }

    const id = nextAgentIdRef.current++;
    const agent: AgentState = {
      id,
      sessionId,
      terminalRef: undefined,
      isExternal: true,
      projectDir,
      jsonlFile: file,
      fileOffset: 0,
      lineBuffer: '',
      activeToolIds: new Set(),
      activeToolStatuses: new Map(),
      activeToolNames: new Map(),
      activeSubagentToolIds: new Map(),
      activeSubagentToolNames: new Map(),
      backgroundAgentToolIds: new Set(),
      isWaiting: false,
      permissionSent: false,
      hadToolsInTurn: false,
      hookDelivered: false,
      lastDataAt: Date.now(),
      linesProcessed: 0,
      seenUnknownRecordTypes: new Set(),
      inputTokens: 0,
      outputTokens: 0,
      agentName: teammateName,
      leadAgentId: parentAgentId,
      teamName: parentAgent?.teamName,
      teamUsesTmux: parentAgent?.teamUsesTmux,
    };

    agents.set(id, agent);
    persistAgents();

    console.log(
      `[Pixel Agents] Teammate detected: "${teammateName}" (Agent ${id}) for parent Agent ${parentAgentId} (${path.basename(file)})`,
    );

    onAgentCreated?.(agent);

    startFileWatching(
      id,
      file,
      agents,
      fileWatchers,
      pollingTimers,
      waitingTimers,
      permissionTimers,
    );
    readNewLines(id, agents, waitingTimers, permissionTimers);
  }
}

export function scanTeamConfigsForRemovals(agents: AgentStateStore): number[] {
  const toRemove: number[] = [];
  const teamProvider = sessionProviders.get(agents)?.team;
  if (!teamProvider) return toRemove;
  const teammatesByTeam = new Map<string, Array<{ id: number; agent: AgentState }>>();
  for (const [id, agent] of agents) {
    if (agent.leadAgentId === undefined || agent.teamUsesTmux || !agent.teamName) continue;
    let list = teammatesByTeam.get(agent.teamName);
    if (!list) {
      list = [];
      teammatesByTeam.set(agent.teamName, list);
    }
    list.push({ id, agent });
  }

  for (const [teamName, members] of teammatesByTeam) {
    const memberNames = teamProvider.getTeamMembers(teamName);

    for (const { id, agent } of members) {
      if (memberNames === null) {
        toRemove.push(id);
      } else if (agent.agentName && !memberNames.has(agent.agentName)) {
        toRemove.push(id);
      }
    }
  }

  return toRemove;
}

export function scanAllTeammateFiles(
  nextAgentIdRef: { current: number },
  agents: AgentStateStore,
  fileWatchers: Map<number, fs.FSWatcher>,
  pollingTimers: Map<number, ReturnType<typeof setInterval>>,
  waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
  permissionTimers: Map<number, ReturnType<typeof setTimeout>>,

  persistAgents: () => void,
  onAgentCreated?: (agent: AgentState) => void,
): void {
  for (const [agentId, agent] of agents) {
    if (agent.leadAgentId !== undefined) continue;
    if (!agent.sessionId || !agent.projectDir) continue;
    if (!agent.teamName) continue;

    scanForTeammateFiles(
      agent.projectDir,
      agent.sessionId,
      agentId,
      nextAgentIdRef,
      agents,
      fileWatchers,
      pollingTimers,
      waitingTimers,
      permissionTimers,
      persistAgents,
      onAgentCreated,
    );
  }
}

export function adoptExternalSessionFromHook(
  sessionId: string,
  transcriptPath: string | undefined,
  cwd: string,
  knownJsonlFiles: Set<string>,
  nextAgentIdRef: { current: number },
  agents: AgentStateStore,
  fileWatchers: Map<number, fs.FSWatcher>,
  pollingTimers: Map<number, ReturnType<typeof setInterval>>,
  waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
  permissionTimers: Map<number, ReturnType<typeof setTimeout>>,

  persistAgents: () => void,
  onAgentCreated?: (agent: AgentState) => void,
): void {
  if (transcriptPath) {
    for (const agent of agents.values()) {
      if (pathsMatch(agent.jsonlFile, transcriptPath)) return;
    }
    if (dismissalTracker!.isDismissed(transcriptPath)) return;
    if (dismissalTracker!.isPermanentlyDismissed(transcriptPath)) return;

    knownJsonlFiles.add(transcriptPath);
    const projectDir = path.dirname(transcriptPath);
    const folderName =
      folderNameResolver?.({ cwd, projectDir }) ??
      folderNameFromProjectDir(path.basename(projectDir));

    adoptExternalSession(
      transcriptPath,
      projectDir,
      nextAgentIdRef,
      agents,
      fileWatchers,
      pollingTimers,
      waitingTimers,
      permissionTimers,
      persistAgents,
      folderName,
    );

    const adoptedAgent = [...agents.values()].find((a) => pathsMatch(a.jsonlFile, transcriptPath));
    if (adoptedAgent && debug) {
      console.log(
        `[Pixel Agents] Hook: Agent ${adoptedAgent.id} - detected external session ${path.basename(transcriptPath)}${adoptedAgent.folderName ? ` (${adoptedAgent.folderName})` : ''}`,
      );
    }
    if (adoptedAgent) {
      adoptedAgent.sessionId = sessionId;
      adoptedAgent.hookDelivered = true;
      onAgentCreated?.(adoptedAgent);
    }
  } else {
    const id = nextAgentIdRef.current++;
    const folderName = folderNameResolver?.({ cwd }) ?? (cwd ? path.basename(cwd) : undefined);
    const agent: AgentState = {
      id,
      sessionId,
      terminalRef: undefined,
      isExternal: true,
      projectDir: cwd,
      jsonlFile: '',
      fileOffset: 0,
      lineBuffer: '',
      activeToolIds: new Set(),
      activeToolStatuses: new Map(),
      activeToolNames: new Map(),
      activeSubagentToolIds: new Map(),
      activeSubagentToolNames: new Map(),
      backgroundAgentToolIds: new Set(),
      isWaiting: false,
      permissionSent: false,
      hadToolsInTurn: false,
      hookDelivered: true,
      hooksOnly: true,
      lastDataAt: Date.now(),
      linesProcessed: 0,
      seenUnknownRecordTypes: new Set(),
      folderName,
      inputTokens: 0,
      outputTokens: 0,
    };
    agents.set(id, agent);
    persistAgents();
    if (debug) {
      console.log(
        `[Pixel Agents] Hook: Agent ${id} - detected hooks-only external session${folderName ? ` (${folderName})` : ''}`,
      );
    }
    onAgentCreated?.(agent);
  }
}

function adoptExternalSession(
  jsonlFile: string,
  projectDir: string,
  nextAgentIdRef: { current: number },
  agents: AgentStateStore,
  fileWatchers: Map<number, fs.FSWatcher>,
  pollingTimers: Map<number, ReturnType<typeof setInterval>>,
  waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
  permissionTimers: Map<number, ReturnType<typeof setTimeout>>,

  persistAgents: () => void,
  folderName?: string,
): void {
  const id = nextAgentIdRef.current++;
  let fileOffset = 0;
  try {
    const stat = fs.statSync(jsonlFile);
    const ageMs = stat.birthtimeMs > 0 ? Date.now() - stat.birthtimeMs : Number.POSITIVE_INFINITY;
    const freshnessWindowMs = EXTERNAL_SCAN_INTERVAL_MS * 2;
    fileOffset = ageMs <= freshnessWindowMs ? 0 : stat.size;
  } catch {}
  const agent: AgentState = {
    id,
    sessionId: sessionIdFromFile(agents, jsonlFile),
    terminalRef: undefined,
    isExternal: true,
    projectDir,
    jsonlFile,
    fileOffset,
    lineBuffer: '',
    activeToolIds: new Set(),
    activeToolStatuses: new Map(),
    activeToolNames: new Map(),
    activeSubagentToolIds: new Map(),
    activeSubagentToolNames: new Map(),
    backgroundAgentToolIds: new Set(),
    isWaiting: false,
    permissionSent: false,
    hadToolsInTurn: false,
    hookDelivered: false,
    lastDataAt: Date.now(),
    linesProcessed: 0,
    seenUnknownRecordTypes: new Set(),
    folderName,
    inputTokens: 0,
    outputTokens: 0,
  };

  agents.set(id, agent);
  persistAgents();

  startFileWatching(
    id,
    jsonlFile,
    agents,
    fileWatchers,
    pollingTimers,
    waitingTimers,
    permissionTimers,
  );
  readNewLines(id, agents, waitingTimers, permissionTimers);
}

export function startExternalSessionScanning(
  _projectDir: string,
  knownJsonlFiles: Set<string>,
  nextAgentIdRef: { current: number },
  agents: AgentStateStore,
  fileWatchers: Map<number, fs.FSWatcher>,
  pollingTimers: Map<number, ReturnType<typeof setInterval>>,
  waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
  permissionTimers: Map<number, ReturnType<typeof setTimeout>>,
  _jsonlPollTimers: Map<number, ReturnType<typeof setInterval>>,

  persistAgents: () => void,
  watchAllSessionsRef?: { current: boolean },
  _hooksEnabledRef?: { current: boolean },
): ReturnType<typeof setInterval> {
  return setInterval(() => {
    for (const dir of trackedProjectDirs) {
      scanExternalDir(
        dir,
        knownJsonlFiles,
        nextAgentIdRef,
        agents,
        fileWatchers,
        pollingTimers,
        waitingTimers,
        permissionTimers,
        persistAgents,
      );
    }
    if (watchAllSessionsRef?.current) {
      scanGlobalProjectDirs(
        knownJsonlFiles,
        nextAgentIdRef,
        agents,
        fileWatchers,
        pollingTimers,
        waitingTimers,
        permissionTimers,
        persistAgents,
      );
    }
  }, EXTERNAL_SCAN_INTERVAL_MS);
}

export function scanExternalDir(
  projectDir: string,
  knownJsonlFiles: Set<string>,
  nextAgentIdRef: { current: number },
  agents: AgentStateStore,
  fileWatchers: Map<number, fs.FSWatcher>,
  pollingTimers: Map<number, ReturnType<typeof setInterval>>,
  waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
  permissionTimers: Map<number, ReturnType<typeof setTimeout>>,

  persistAgents: () => void,
): void {
  let files: string[];
  try {
    files = fs
      .readdirSync(projectDir)
      .filter((f) => matchesSessionFile(agents, f))
      .map((f) => path.join(projectDir, f));
  } catch {
    return;
  }

  const now = Date.now();

  const hasOrphanedInternal = [...agents.values()].some((a) => {
    if (a.isExternal || !pathsMatch(a.projectDir, projectDir)) return false;
    try {
      fs.statSync(a.jsonlFile);
      return false;
    } catch {
      return true;
    }
  });
  if (hasOrphanedInternal) return;

  const hasPendingReassignment = [...agents.values()].some(
    (agent) => agent.pendingClear && pathsMatch(agent.projectDir, projectDir),
  );
  if (hasPendingReassignment) return;

  for (const file of files) {
    const seededMtime = dismissalTracker!.getSeededMtime(file);
    if (seededMtime !== undefined) {
      try {
        const stat = fs.statSync(file);
        if (stat.mtimeMs > seededMtime) {
          dismissalTracker!.clearSeededMtime(file);
          knownJsonlFiles.delete(file);
        }
      } catch {}
      continue;
    }

    if (knownJsonlFiles.has(file)) continue;

    if (dismissalTracker!.isPermanentlyDismissed(file)) continue;

    if (dismissalTracker!.isDismissed(file)) continue;

    let tracked = false;
    for (const agent of agents.values()) {
      if (pathsMatch(agent.jsonlFile, file)) {
        tracked = true;
        break;
      }
    }
    if (tracked) continue;

    try {
      const stat = fs.statSync(file);
      if (now - stat.mtimeMs > EXTERNAL_ACTIVE_THRESHOLD_MS) continue;
    } catch {
      continue;
    }

    if (supportsClearDetection(agents)) {
      try {
        const buf = Buffer.alloc(8192);
        const fd = fs.openSync(file, 'r');
        const bytesRead = fs.readSync(fd, buf, 0, 8192, 0);
        fs.closeSync(fd);
        if (buf.toString('utf-8', 0, bytesRead).includes('/clear</command-name>')) {
          if (!dismissalTracker!.hasPendingClear(file)) {
            dismissalTracker!.registerPendingClear(file);
            continue;
          }
          dismissalTracker!.clearPendingClear(file);
        }
      } catch {
        continue;
      }
    }

    knownJsonlFiles.add(file);
    console.log(`[Pixel Agents] Watcher: detected external session ${path.basename(file)}`);
    adoptExternalSession(
      file,
      projectDir,
      nextAgentIdRef,
      agents,
      fileWatchers,
      pollingTimers,
      waitingTimers,
      permissionTimers,
      persistAgents,
    );
  }
}

function folderNameFromProjectDir(dirName: string): string {
  const parts = dirName.replace(/^-+/, '').split('-');
  return parts[parts.length - 1] || dirName;
}

function scanGlobalProjectDirs(
  knownJsonlFiles: Set<string>,
  nextAgentIdRef: { current: number },
  agents: AgentStateStore,
  fileWatchers: Map<number, fs.FSWatcher>,
  pollingTimers: Map<number, ReturnType<typeof setInterval>>,
  waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
  permissionTimers: Map<number, ReturnType<typeof setTimeout>>,

  persistAgents: () => void,
): void {
  const roots = sessionProviders.get(agents)?.getAllSessionRoots?.() ?? [];
  if (roots.length === 0) return;

  const projectDirs: string[] = [];
  for (const root of roots) {
    try {
      const entries = fs.readdirSync(root, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) projectDirs.push(path.join(root, entry.name));
      }
    } catch {}
  }

  const now = Date.now();
  for (const dirPath of projectDirs) {
    if (isTrackedProjectDir(dirPath)) continue;

    let files: string[];
    try {
      files = fs
        .readdirSync(dirPath)
        .filter((f) => matchesSessionFile(agents, f))
        .map((f) => path.join(dirPath, f));
    } catch {
      continue;
    }

    for (const file of files) {
      if (knownJsonlFiles.has(file)) continue;
      let tracked = false;
      for (const agent of agents.values()) {
        if (pathsMatch(agent.jsonlFile, file)) {
          tracked = true;
          break;
        }
      }
      if (tracked) continue;
      try {
        const stat = fs.statSync(file);
        if (stat.size < GLOBAL_SCAN_ACTIVE_MIN_SIZE) continue;
        if (now - stat.mtimeMs > GLOBAL_SCAN_ACTIVE_MAX_AGE_MS) continue;
      } catch {
        continue;
      }

      const folderName =
        folderNameResolver?.({ projectDir: dirPath }) ??
        folderNameFromProjectDir(path.basename(dirPath));
      knownJsonlFiles.add(file);
      console.log(
        `[Pixel Agents] Watcher: detected global session ${path.basename(file)} (${folderName})`,
      );
      adoptExternalSession(
        file,
        dirPath,
        nextAgentIdRef,
        agents,
        fileWatchers,
        pollingTimers,
        waitingTimers,
        permissionTimers,
        persistAgents,
        folderName,
      );
    }
  }
}

export function startStaleExternalAgentCheck(
  agents: AgentStateStore,
  knownJsonlFiles: Set<string>,
  hooksEnabledRef?: { current: boolean },
): ReturnType<typeof setInterval> {
  return setInterval(() => {
    if (hooksEnabledRef?.current) return;
    const toRemove: number[] = [];

    for (const [id, agent] of agents) {
      if (!agent.isExternal) continue;

      try {
        fs.statSync(agent.jsonlFile);
      } catch {
        toRemove.push(id);
      }
    }

    for (const id of toRemove) {
      const agent = agents.get(id);
      if (agent) {
        knownJsonlFiles.delete(agent.jsonlFile);
      }
      console.log(`[Pixel Agents] Watcher: Agent ${id} - removing stale external agent`);
      agentRemovalCallback?.(id);
    }
  }, EXTERNAL_STALE_CHECK_INTERVAL_MS);
}

export function reassignAgentToFile(
  agentId: number,
  newFilePath: string,
  agents: AgentStateStore,
  fileWatchers: Map<number, fs.FSWatcher>,
  pollingTimers: Map<number, ReturnType<typeof setInterval>>,
  waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
  permissionTimers: Map<number, ReturnType<typeof setTimeout>>,

  persistAgents: () => void,
): void {
  const agent = agents.get(agentId);
  if (!agent) return;

  fileWatchers.get(agentId)?.close();
  fileWatchers.delete(agentId);
  const pt = pollingTimers.get(agentId);
  if (pt) {
    clearInterval(pt);
  }
  pollingTimers.delete(agentId);

  cancelWaitingTimer(agentId, waitingTimers);
  cancelPermissionTimer(agentId, permissionTimers);
  clearAgentActivity(agent, agentId, agents, permissionTimers);

  dismissalTracker!.permanentlyDismiss(agent.jsonlFile);

  agent.sessionId = sessionIdFromFile(agents, newFilePath);
  agent.jsonlFile = newFilePath;
  agent.fileOffset = 0;
  agent.lineBuffer = '';
  persistAgents();

  startFileWatching(
    agentId,
    newFilePath,
    agents,
    fileWatchers,
    pollingTimers,
    waitingTimers,
    permissionTimers,
  );
  readNewLines(agentId, agents, waitingTimers, permissionTimers);
}
