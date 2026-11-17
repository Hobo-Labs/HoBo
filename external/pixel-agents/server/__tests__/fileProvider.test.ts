import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { FileProvider } from '../../core/src/provider.js';
import { AgentRuntime } from '../src/agentRuntime.js';
import { AgentStateStore } from '../src/agentStateStore.js';
import { parseArgs } from '../src/cli.js';
import { handleClientMessage } from '../src/clientMessageHandler.js';
import type { TranscriptContext } from '../src/fileWatcher.js';
import { readNewLines, scanExternalDir } from '../src/fileWatcher.js';
import { claudeFileProvider } from '../src/providers/file/claudeFileProvider.js';
import { claudeProvider } from '../src/providers/hook/claude/claude.js';

const directories: string[] = [];
const runtimes: AgentRuntime[] = [];

afterEach(() => {
  for (const runtime of runtimes.splice(0)) runtime.dispose();
  for (const directory of directories.splice(0))
    fs.rmSync(directory, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function temporaryDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pixel-file-provider-'));
  directories.push(directory);
  return directory;
}

function scan(directory: string, runtime: AgentRuntime, store: AgentStateStore): void {
  scanExternalDir(
    directory,
    runtime.knownJsonlFiles,
    store.nextAgentId,
    store,
    runtime.fileWatchers,
    runtime.pollingTimers,
    runtime.waitingTimers,
    runtime.permissionTimers,
    () => {},
  );
}

describe('file providers', () => {
  it('polls provider-specific files, buffers partial lines, and continues after a bad record', () => {
    const directory = temporaryDirectory();
    const observed: string[] = [];
    const provider: FileProvider<TranscriptContext> = {
      kind: 'file',
      id: 'test-file',
      displayName: 'Test File',
      protocolVersion: 1,
      formatToolStatus: (name) => name,
      permissionExemptTools: new Set(),
      subagentToolNames: new Set(),
      readingTools: new Set(),
      matchesSessionFile: (fileName) => fileName.endsWith('.ndjson'),
      sessionIdFromFile: (filePath) => path.basename(filePath, '.ndjson'),
      processTranscriptLine: (line, context) => {
        if (line === 'bad') throw new Error('bad record');
        observed.push(line);
        context.agents.broadcast({ type: 'agentStatus', id: context.agentId, status: 'active' });
      },
    };
    const store = new AgentStateStore();
    const runtime = new AgentRuntime(store, provider);
    runtimes.push(runtime);
    const otherRuntime = new AgentRuntime(new AgentStateStore(), claudeFileProvider);
    runtimes.push(otherRuntime);
    const broadcasts: Record<string, unknown>[] = [];
    store.on('broadcast', (message) => broadcasts.push(message));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const transcript = path.join(directory, 'session.ndjson');
    fs.writeFileSync(transcript, 'one\nbad\npartial');
    fs.writeFileSync(path.join(directory, 'ignored.jsonl'), 'ignored\n');

    scan(directory, runtime, store);
    expect(store.size).toBe(1);
    expect(store.get(1)?.sessionId).toBe('session');
    expect(observed).toEqual(['one']);

    fs.appendFileSync(transcript, '-two\nthree\n');
    readNewLines(1, store, runtime.waitingTimers, runtime.permissionTimers);
    readNewLines(1, store, runtime.waitingTimers, runtime.permissionTimers);
    expect(observed).toEqual(['one', 'partial-two', 'three']);
    expect(store.get(1)?.linesProcessed).toBe(4);
    expect(broadcasts.filter((message) => message.type === 'agentStatus')).toHaveLength(3);
  });

  it('runs the real Claude transcript parser with hooks disabled', () => {
    const directory = temporaryDirectory();
    const store = new AgentStateStore();
    const runtime = new AgentRuntime(store, claudeFileProvider);
    runtimes.push(runtime);
    const broadcasts: Record<string, unknown>[] = [];
    store.on('broadcast', (message) => broadcasts.push(message));
    const record = {
      type: 'assistant',
      message: {
        content: [
          { type: 'tool_use', id: 'read-1', name: 'Read', input: { file_path: '/src/example.ts' } },
        ],
      },
    };
    fs.writeFileSync(path.join(directory, 'claude-session.jsonl'), `${JSON.stringify(record)}\n`);

    scan(directory, runtime, store);
    expect(store.get(1)?.sessionId).toBe('claude-session');
    expect(broadcasts).toContainEqual(
      expect.objectContaining({
        type: 'agentToolStart',
        id: 1,
        toolId: 'read-1',
        status: 'Reading example.ts',
      }),
    );
    expect(runtime.supportsHooks).toBe(false);
    runtime.hooksEnabled.current = true;
    expect(runtime.hooksEnabled.current).toBe(false);
    runtime.handleHookEvent('claude', { hook_event_name: 'SessionStart', session_id: 'other' });
    expect(store.size).toBe(1);
  });

  it('does not install hooks when a file-only runtime receives a UI toggle', () => {
    const store = new AgentStateStore();
    const runtime = new AgentRuntime(store, claudeFileProvider);
    runtimes.push(runtime);
    const onSetHooksEnabled = vi.fn(async () => {});
    handleClientMessage({ type: 'setHooksEnabled', enabled: true }, () => {}, {
      store,
      runtime,
      cache: null,
      onSetHooksEnabled,
    });
    expect(runtime.hooksEnabled.current).toBe(false);
    expect(onSetHooksEnabled).not.toHaveBeenCalled();
    expect(parseArgs(['--file-only']).fileOnly).toBe(true);
  });

  it('rejects an unsupported file provider protocol version', () => {
    expect(
      () =>
        new AgentRuntime(new AgentStateStore(), {
          ...claudeFileProvider,
          protocolVersion: 2,
        }),
    ).toThrow('unsupported file provider protocol version: 2');
  });

  it('drops events from an unsupported hook provider protocol version', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const store = new AgentStateStore();
    const runtime = new AgentRuntime(store, { ...claudeProvider, protocolVersion: 2 });
    runtimes.push(runtime);
    runtime.watchAllSessions.current = true;
    runtime.handleHookEvent('claude', {
      hook_event_name: 'SessionStart',
      session_id: 'unsupported',
      cwd: temporaryDirectory(),
    });
    expect(store.size).toBe(0);
  });
});
