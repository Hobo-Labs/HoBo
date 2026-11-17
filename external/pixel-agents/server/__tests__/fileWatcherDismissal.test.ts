import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({
  window: {
    activeTerminal: undefined,
    terminals: [],
  },
}));

import { AgentStateStore } from '../src/agentStateStore.js';
import {
  DISMISSED_COOLDOWN_MS,
  EXTERNAL_ACTIVE_THRESHOLD_MS,
  EXTERNAL_SCAN_INTERVAL_MS,
} from '../src/constants.js';
import { DismissalTracker } from '../src/dismissalTracker.js';
import {
  adoptExternalSessionFromHook,
  ensureProjectScan,
  scanExternalDir,
  scanForNewJsonlFiles,
  setDismissalTracker,
  startExternalSessionScanning,
} from '../src/fileWatcher.js';
import { PathSet } from '../src/pathKey.js';
import type { AgentState } from '../src/types.js';


describe('fileWatcher dismissal state', () => {
  let tmpDir: string;
  let projectDir: string;
  let tracker: DismissalTracker;
  let knownJsonlFiles: PathSet;
  let nextAgentIdRef: { current: number };
  let agents: AgentStateStore;
  let fileWatchers: Map<number, fs.FSWatcher>;
  let pollingTimers: Map<number, ReturnType<typeof setInterval>>;
  let waitingTimers: Map<number, ReturnType<typeof setTimeout>>;
  let permissionTimers: Map<number, ReturnType<typeof setTimeout>>;

  function writeJsonlFile(name: string, content: string): string {
    const filePath = path.join(projectDir, name);
    fs.writeFileSync(filePath, content);
    return filePath;
  }

  function runExternalScan(): void {
    scanExternalDir(
      projectDir,
      knownJsonlFiles,
      nextAgentIdRef,
      agents,
      fileWatchers,
      pollingTimers,
      waitingTimers,
      permissionTimers,
      () => {},
    );
  }

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-fw-dismissal-'));
    projectDir = tmpDir;

    tracker = new DismissalTracker();
    setDismissalTracker(tracker);

    knownJsonlFiles = new PathSet();
    nextAgentIdRef = { current: 1 };
    agents = new AgentStateStore();
    fileWatchers = new Map();
    pollingTimers = new Map();
    waitingTimers = new Map();
    permissionTimers = new Map();
  });

  afterEach(() => {
    for (const t of pollingTimers.values()) clearInterval(t);
    for (const t of waitingTimers.values()) clearTimeout(t);
    for (const t of permissionTimers.values()) clearTimeout(t);
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
    }
  });


  describe('dismissedJsonlFiles: user-close cooldown', () => {
    it('blocks external adoption when dismissed < DISMISSED_COOLDOWN_MS ago', () => {
      const file = writeJsonlFile('sess-1.jsonl', '{"type":"assistant"}\n');
      tracker.dismiss(file, Date.now() - 10_000);

      runExternalScan();

      expect(agents.size).toBe(0);
      expect(tracker.isDismissed(file)).toBe(true);
    });

    it('expires dismissal and allows adoption after cooldown', () => {
      const file = writeJsonlFile('sess-1.jsonl', '{"type":"assistant"}\n');
      tracker.dismiss(file, Date.now() - DISMISSED_COOLDOWN_MS - 1_000);

      runExternalScan();

      expect(agents.size).toBe(1);
      expect(tracker.isDismissed(file)).toBe(false);
    });

    it('leaves non-dismissed, recently-modified files adoptable', () => {
      writeJsonlFile('sess-1.jsonl', '{"type":"assistant"}\n');
      runExternalScan();
      expect(agents.size).toBe(1);
    });
  });


  describe('clearDismissedFiles: permanent block', () => {
    it('never re-adopts a file in the permanent-dismiss set', () => {
      const file = writeJsonlFile('sess-1.jsonl', '{"type":"assistant"}\n');
      tracker.permanentlyDismiss(file);

      runExternalScan();

      expect(agents.size).toBe(0);
      expect(tracker.isPermanentlyDismissed(file)).toBe(true);
    });

    it('blocks across multiple scanner invocations', () => {
      const file = writeJsonlFile('sess-1.jsonl', '{"type":"assistant"}\n');
      tracker.permanentlyDismiss(file);

      runExternalScan();
      runExternalScan();
      runExternalScan();

      expect(agents.size).toBe(0);
    });

    it('does NOT prevent adoption of sibling files in the same dir', () => {
      const blocked = writeJsonlFile('old.jsonl', '{"type":"assistant"}\n');
      writeJsonlFile('new.jsonl', '{"type":"assistant"}\n');
      tracker.permanentlyDismiss(blocked);

      runExternalScan();

      expect(agents.size).toBe(1);
      const adopted = [...agents.values()][0];
      expect(adopted.jsonlFile).toContain('new.jsonl');
    });
  });


  describe('seededMtimes: mtime-change detection (--resume signal)', () => {
    it('leaves seeded file in known set when mtime unchanged', () => {
      const file = writeJsonlFile('seeded.jsonl', '{"type":"assistant"}\n');
      const stat = fs.statSync(file);
      tracker.seedMtime(file, stat.mtimeMs);
      knownJsonlFiles.add(file);

      runExternalScan();

      expect(tracker.hasSeededMtime(file)).toBe(true);
      expect(knownJsonlFiles.has(file)).toBe(true);
      expect(agents.size).toBe(0);
    });

    it('removes seeded file from tracking when mtime changed', () => {
      const file = writeJsonlFile('seeded.jsonl', '{"type":"assistant"}\n');
      tracker.seedMtime(file, fs.statSync(file).mtimeMs - 60_000);
      knownJsonlFiles.add(file);

      runExternalScan();

      expect(tracker.hasSeededMtime(file)).toBe(false);
      expect(knownJsonlFiles.has(file)).toBe(false);
      expect(agents.size).toBe(0);
    });

    it('does NOT adopt as external on the mtime-change tick', () => {
      const file = writeJsonlFile('seeded.jsonl', '{"type":"assistant"}\n');
      tracker.seedMtime(file, fs.statSync(file).mtimeMs - 30_000);
      knownJsonlFiles.add(file);

      runExternalScan();

      expect(agents.size).toBe(0);
    });
  });


  describe('pendingClearFiles: two-tick delay for /clear content', () => {
    const clearJsonl = '{"type":"user","content":"/clear</command-name>"}\n';

    it('first tick: /clear file is registered as pending, not adopted', () => {
      const file = writeJsonlFile('sess-clear.jsonl', clearJsonl);

      runExternalScan();

      expect(agents.size).toBe(0);
      expect(tracker.hasPendingClear(file)).toBe(true);
    });

    it('second tick: /clear file is cleared from pending and adopted', () => {
      const file = writeJsonlFile('sess-clear.jsonl', clearJsonl);

      runExternalScan();
      runExternalScan();

      expect(agents.size).toBe(1);
      expect(tracker.hasPendingClear(file)).toBe(false);
    });

    it('non-/clear file adopts on first tick (no pending delay)', () => {
      writeJsonlFile('sess-plain.jsonl', '{"type":"assistant"}\n');

      runExternalScan();

      expect(agents.size).toBe(1);
    });
  });


  describe('scanForNewJsonlFiles: project scanner', () => {
    function runProjectScan(): void {
      scanForNewJsonlFiles(
        projectDir,
        knownJsonlFiles,
        { current: null },
        nextAgentIdRef,
        agents,
        fileWatchers,
        pollingTimers,
        waitingTimers,
        permissionTimers,
        () => {},
      );
    }

    it('skips files already in knownJsonlFiles (seeded at startup)', () => {
      const file = writeJsonlFile('sess-1.jsonl', '{"type":"assistant"}\n');
      knownJsonlFiles.add(file);

      runProjectScan();

      expect(agents.size).toBe(0);
    });

    it('skips files expired in dismissedJsonlFiles during project scan', () => {
      const file = writeJsonlFile('sess-1.jsonl', '{"type":"assistant"}\n');
      tracker.dismiss(file, Date.now() - 5_000);

      runProjectScan();

      expect(tracker.isDismissed(file)).toBe(true);
    });
  });

  describe('startExternalSessionScanning: hooks mode workspace discovery', () => {
    it('adopts workspace JSONL sessions when hooks and Watch All Sessions are both enabled', () => {
      vi.useFakeTimers();
      const projectScanTimerRef: { current: ReturnType<typeof setInterval> | null } = {
        current: null,
      };

      ensureProjectScan(
        projectDir,
        knownJsonlFiles,
        projectScanTimerRef,
        { current: null },
        nextAgentIdRef,
        agents,
        fileWatchers,
        pollingTimers,
        waitingTimers,
        permissionTimers,
        () => {},
        undefined,
        { current: true },
      );
      writeJsonlFile('workspace-session.jsonl', '{"type":"assistant"}\n');

      const externalScanTimer = startExternalSessionScanning(
        projectDir,
        knownJsonlFiles,
        nextAgentIdRef,
        agents,
        fileWatchers,
        pollingTimers,
        waitingTimers,
        permissionTimers,
        new Map(),
        () => {},
        { current: true },
        { current: true },
      );

      vi.advanceTimersByTime(EXTERNAL_SCAN_INTERVAL_MS);

      clearInterval(externalScanTimer);
      if (projectScanTimerRef.current) clearInterval(projectScanTimerRef.current);
      vi.useRealTimers();

      expect(agents.size).toBe(1);
      const adopted = [...agents.values()][0];
      expect(adopted.jsonlFile).toBe(path.join(projectDir, 'workspace-session.jsonl'));
      expect(adopted.isExternal).toBe(true);
    });

    it('does not steal a replacement transcript while an agent awaits reassignment', () => {
      const oldFile = writeJsonlFile('old-session.jsonl', '{"type":"assistant"}\n');
      const replacementFile = writeJsonlFile('replacement-session.jsonl', '{"type":"assistant"}\n');
      knownJsonlFiles.add(oldFile);
      agents.set(1, {
        id: 1,
        isExternal: false,
        projectDir,
        jsonlFile: oldFile,
        pendingClear: true,
      } as AgentState);
      nextAgentIdRef.current = 2;

      runExternalScan();
      expect(agents.size).toBe(1);
      expect(knownJsonlFiles.has(replacementFile)).toBe(false);

      agents.get(1)!.pendingClear = false;
      runExternalScan();
      expect(agents.size).toBe(2);
      expect(knownJsonlFiles.has(replacementFile)).toBe(true);
    });

    it('honors a dismissal recorded under a different path spelling', () => {
      const platformSpy = vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
      try {
        const file = writeJsonlFile('closed-session.jsonl', '{"type":"assistant"}\n');
        tracker.dismiss(file.toUpperCase());

        runExternalScan();

        expect(agents.size).toBe(0);
        expect(tracker.isDismissed(file)).toBe(true);
      } finally {
        platformSpy.mockRestore();
      }
    });

    it('treats a case-varied transcript as already known', () => {
      const platformSpy = vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
      try {
        const file = writeJsonlFile('known-session.jsonl', '{"type":"assistant"}\n');
        knownJsonlFiles.add(file.toUpperCase());

        runExternalScan();

        expect(agents.size).toBe(0);
      } finally {
        platformSpy.mockRestore();
      }
    });

    it('deduplicates case-varied transcript paths across hook and polling adoption', () => {
      const platformSpy = vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
      try {
        const file = writeJsonlFile('workspace-session.jsonl', '{"type":"assistant"}\n');
        agents.set(1, {
          id: 1,
          isExternal: true,
          projectDir,
          jsonlFile: file.toUpperCase(),
        } as AgentState);
        nextAgentIdRef.current = 2;

        adoptExternalSessionFromHook(
          'workspace-session',
          file,
          projectDir,
          knownJsonlFiles,
          nextAgentIdRef,
          agents,
          fileWatchers,
          pollingTimers,
          waitingTimers,
          permissionTimers,
          () => {},
        );
        runExternalScan();

        expect(agents.size).toBe(1);
        expect(nextAgentIdRef.current).toBe(2);
      } finally {
        platformSpy.mockRestore();
      }
    });
  });


  it('constants are within sensible bounds', () => {
    expect(DISMISSED_COOLDOWN_MS).toBeGreaterThan(60_000);
    expect(EXTERNAL_ACTIVE_THRESHOLD_MS).toBeGreaterThan(30_000);
  });
});
