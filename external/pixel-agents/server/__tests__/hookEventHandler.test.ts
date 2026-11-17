import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AgentStateStore } from '../src/agentStateStore.js';
import { HookEventHandler } from '../src/hookEventHandler.js';
import { claudeProvider } from '../src/providers/hook/claude/claude.js';
import { SessionRouter } from '../src/sessionRouter.js';
import type { AgentState } from '../src/types.js';

function createTestAgent(overrides: Partial<AgentState> = {}): AgentState {
  return {
    id: 1,
    sessionId: '',
    terminalRef: undefined,
    isExternal: true,
    projectDir: '/test',
    jsonlFile: '/test/session.jsonl',
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
    lastDataAt: 0,
    linesProcessed: 0,
    seenUnknownRecordTypes: new Set(),
    hookDelivered: false,
    ...overrides,
  } as AgentState;
}

function createMockWebview() {
  const messages: Array<Record<string, unknown>> = [];
  return {
    postMessage: vi.fn((msg: Record<string, unknown>) => {
      messages.push(msg);
      return Promise.resolve(true);
    }),
    messages,
  };
}

describe('HookEventHandler', () => {
  let agents: AgentStateStore;
  let waitingTimers: Map<number, ReturnType<typeof setTimeout>>;
  let permissionTimers: Map<number, ReturnType<typeof setTimeout>>;
  let mockWebview: ReturnType<typeof createMockWebview>;
  let handler: HookEventHandler;

  beforeEach(() => {
    agents = new AgentStateStore();
    waitingTimers = new Map();
    permissionTimers = new Map();
    mockWebview = createMockWebview();
    agents.on('broadcast', (msg) => {
      mockWebview.postMessage(msg);
    });
    handler = new HookEventHandler(
      agents,
      waitingTimers,
      permissionTimers,
      claudeProvider,
      new SessionRouter(),
    );
  });


  it('PermissionRequest sends agentToolPermission', () => {
    const agent = createTestAgent({ id: 1 });
    agents.set(1, agent);
    handler.registerAgent('sess-1', 1);

    handler.handleEvent('claude', {
      hook_event_name: 'PermissionRequest',
      session_id: 'sess-1',
    });

    const msg = mockWebview.messages.find((m) => m.type === 'agentToolPermission');
    expect(msg).toBeTruthy();
    expect(msg?.id).toBe(1);
  });

  it('PermissionRequest cancels permission timer', () => {
    const agent = createTestAgent({ id: 1 });
    agents.set(1, agent);
    handler.registerAgent('sess-1', 1);

    const timer = setTimeout(() => {}, 10000);
    permissionTimers.set(1, timer);

    handler.handleEvent('claude', {
      hook_event_name: 'PermissionRequest',
      session_id: 'sess-1',
    });

    expect(permissionTimers.has(1)).toBe(false);
  });

  it('PermissionRequest notifies sub-agents', () => {
    const agent = createTestAgent({ id: 1 });
    agent.activeSubagentToolNames.set('tool-parent', new Map([['sub-1', 'Read']]));
    agents.set(1, agent);
    handler.registerAgent('sess-1', 1);

    handler.handleEvent('claude', {
      hook_event_name: 'PermissionRequest',
      session_id: 'sess-1',
    });

    const subMsg = mockWebview.messages.find((m) => m.type === 'subagentToolPermission');
    expect(subMsg).toBeTruthy();
    expect(subMsg?.parentToolId).toBe('tool-parent');
  });


  it('Notification permission_prompt sends agentToolPermission', () => {
    const agent = createTestAgent({ id: 1 });
    agents.set(1, agent);
    handler.registerAgent('sess-1', 1);

    handler.handleEvent('claude', {
      hook_event_name: 'Notification',
      session_id: 'sess-1',
      notification_type: 'permission_prompt',
    });

    const msg = mockWebview.messages.find((m) => m.type === 'agentToolPermission');
    expect(msg).toBeTruthy();
    expect(agent.permissionSent).toBe(true);
  });

  it('Notification idle_prompt marks agent waiting', () => {
    const agent = createTestAgent({ id: 1 });
    agents.set(1, agent);
    handler.registerAgent('sess-1', 1);

    handler.handleEvent('claude', {
      hook_event_name: 'Notification',
      session_id: 'sess-1',
      notification_type: 'idle_prompt',
    });

    expect(agent.isWaiting).toBe(true);
    const msg = mockWebview.messages.find(
      (m) => m.type === 'agentStatus' && m.status === 'waiting',
    );
    expect(msg).toBeTruthy();
    expect(msg?.awaitingInput).toBe(true);
  });


  it('Stop marks agent waiting without awaitingInput (Done)', () => {
    const agent = createTestAgent({ id: 1 });
    agents.set(1, agent);
    handler.registerAgent('sess-1', 1);

    handler.handleEvent('claude', {
      hook_event_name: 'Stop',
      session_id: 'sess-1',
    });

    expect(agent.isWaiting).toBe(true);
    const waitMsg = mockWebview.messages.find(
      (m) => m.type === 'agentStatus' && m.status === 'waiting',
    );
    expect(waitMsg).toBeTruthy();
    expect(waitMsg?.awaitingInput).toBeFalsy();
  });

  it('Stop clears foreground tools but preserves background agents', () => {
    const agent = createTestAgent({ id: 1 });
    agent.activeToolIds.add('fg-tool');
    agent.activeToolStatuses.set('fg-tool', 'Running');
    agent.activeToolNames.set('fg-tool', 'Bash');
    agent.activeToolIds.add('bg-tool');
    agent.activeToolStatuses.set('bg-tool', 'Background task');
    agent.activeToolNames.set('bg-tool', 'Agent');
    agent.backgroundAgentToolIds.add('bg-tool');
    agents.set(1, agent);
    handler.registerAgent('sess-1', 1);

    handler.handleEvent('claude', {
      hook_event_name: 'Stop',
      session_id: 'sess-1',
    });

    expect(agent.activeToolIds.has('fg-tool')).toBe(false);
    expect(agent.activeToolIds.has('bg-tool')).toBe(true);
    const clearMsg = mockWebview.messages.find((m) => m.type === 'agentToolsClear');
    expect(clearMsg).toBeTruthy();
    const reSent = mockWebview.messages.find(
      (m) => m.type === 'agentToolStart' && m.toolId === 'bg-tool',
    );
    expect(reSent).toBeTruthy();
  });


  it('sets hookDelivered flag on agent', () => {
    const agent = createTestAgent({ id: 1, hookDelivered: false } as Partial<AgentState>);
    agents.set(1, agent);
    handler.registerAgent('sess-1', 1);

    handler.handleEvent('claude', {
      hook_event_name: 'Stop',
      session_id: 'sess-1',
    });

    expect(agent.hookDelivered).toBe(true);
  });


  it('silently drops events for untracked sessions', () => {
    handler.handleEvent('claude', {
      hook_event_name: 'Stop',
      session_id: 'unknown-sess',
    });

    expect(mockWebview.messages).toHaveLength(0);
  });

  it('buffers events when unregistered agents exist (internal agent race)', () => {
    const agent = createTestAgent({ id: 1, sessionId: 'sess-1' } as Partial<AgentState>);
    agents.set(1, agent);

    handler.handleEvent('claude', {
      hook_event_name: 'Stop',
      session_id: 'sess-1',
    });

    expect(agent.isWaiting).toBe(true);
  });

  it('flushes buffered events on registerAgent', () => {
    const agent = createTestAgent({ id: 1, sessionId: 'sess-1' } as Partial<AgentState>);
    agents.set(1, agent);

    handler.handleEvent('claude', {
      hook_event_name: 'Stop',
      session_id: 'sess-1',
    });

    const waitMsg = mockWebview.messages.find(
      (m) => m.type === 'agentStatus' && m.status === 'waiting',
    );
    expect(waitMsg).toBeTruthy();
  });

  it('prunes expired buffered events', async () => {
    const agent = createTestAgent({ id: 1, sessionId: 'other-sess' } as Partial<AgentState>);
    agents.set(1, agent);

    handler.handleEvent('claude', {
      hook_event_name: 'Stop',
      session_id: 'expired-sess',
    });

    await new Promise((r) => setTimeout(r, 7000));

    const agent2 = createTestAgent({ id: 2 });
    agents.set(2, agent2);
    handler.registerAgent('expired-sess', 2);

    expect(mockWebview.messages).toHaveLength(0);

    handler.dispose();
  });


  it('auto-discovers agent by sessionId field', () => {
    const agent = createTestAgent({ id: 1, sessionId: 'auto-sess' } as Partial<AgentState>);
    agents.set(1, agent);

    handler.handleEvent('claude', {
      hook_event_name: 'Stop',
      session_id: 'auto-sess',
    });

    expect(agent.isWaiting).toBe(true);
  });


  it('dispose cleans up timers and maps', () => {
    handler.registerAgent('sess-1', 1);
    handler.dispose();
    expect(() => handler.dispose()).not.toThrow();
  });


  it('SessionStart for known agent sets hookDelivered', () => {
    const agent = createTestAgent({ id: 1, hookDelivered: false } as Partial<AgentState>);
    agents.set(1, agent);
    handler.registerAgent('sess-1', 1);

    handler.handleEvent('claude', {
      hook_event_name: 'SessionStart',
      session_id: 'sess-1',
      source: 'startup',
    });

    expect(agent.hookDelivered).toBe(true);
  });

  it('SessionStart auto-discovers agent by sessionId', () => {
    const agent = createTestAgent({
      id: 1,
      sessionId: 'auto-sess',
      hookDelivered: false,
    } as Partial<AgentState>);
    agents.set(1, agent);

    handler.handleEvent('claude', {
      hook_event_name: 'SessionStart',
      session_id: 'auto-sess',
      source: 'startup',
    });

    expect(agent.hookDelivered).toBe(true);
  });

  it('SessionStart(source=clear) reassigns agent with pendingClear', () => {
    const agent = createTestAgent({
      id: 1,
      projectDir: '/projects/test',
      pendingClear: true,
    } as Partial<AgentState>);
    agents.set(1, agent);
    handler.registerAgent('old-sess', 1);

    const onSessionClear = vi.fn();
    handler.setLifecycleCallbacks({ onSessionClear });

    handler.handleEvent('claude', {
      hook_event_name: 'SessionStart',
      session_id: 'new-sess',
      source: 'clear',
      transcript_path: '/projects/test/new-sess.jsonl',
    });

    expect(onSessionClear).toHaveBeenCalledWith(1, 'new-sess', '/projects/test/new-sess.jsonl');
    expect(agent.pendingClear).toBe(false);
  });

  it('SessionStart for unknown session stores as pending', () => {
    handler.handleEvent('claude', {
      hook_event_name: 'SessionStart',
      session_id: 'ext-sess',
      source: 'startup',
      transcript_path: '/projects/test/ext-sess.jsonl',
      cwd: '/projects/test',
    });

    expect(mockWebview.messages).toHaveLength(0);
  });


  it('SessionEnd(reason=clear) sets pendingClear and marks waiting', () => {
    const agent = createTestAgent({ id: 1 });
    agents.set(1, agent);
    handler.registerAgent('sess-1', 1);

    handler.handleEvent('claude', {
      hook_event_name: 'SessionEnd',
      session_id: 'sess-1',
      reason: 'clear',
    });

    expect(agent.pendingClear).toBe(true);
    expect(agent.isWaiting).toBe(true);
  });

  it('SessionEnd(reason=exit) calls onSessionEnd immediately', () => {
    const agent = createTestAgent({ id: 1 });
    agents.set(1, agent);
    handler.registerAgent('sess-1', 1);

    const onSessionEnd = vi.fn();
    handler.setLifecycleCallbacks({ onSessionEnd });

    handler.handleEvent('claude', {
      hook_event_name: 'SessionEnd',
      session_id: 'sess-1',
      reason: 'exit',
    });

    expect(agent.isWaiting).toBe(true);
    expect(onSessionEnd).toHaveBeenCalledWith(1, 'exit');
  });

  it('SessionEnd(reason=resume) delays onSessionEnd for SESSION_END_GRACE_MS', async () => {
    const agent = createTestAgent({ id: 1 });
    agents.set(1, agent);
    handler.registerAgent('sess-1', 1);

    const onSessionEnd = vi.fn();
    handler.setLifecycleCallbacks({ onSessionEnd });

    handler.handleEvent('claude', {
      hook_event_name: 'SessionEnd',
      session_id: 'sess-1',
      reason: 'resume',
    });

    expect(agent.pendingClear).toBe(true);
    expect(agent.isWaiting).toBe(true);
    expect(onSessionEnd).not.toHaveBeenCalled();

    await new Promise((r) => setTimeout(r, 2500));
    expect(onSessionEnd).toHaveBeenCalledWith(1, 'resume');
    expect(agent.pendingClear).toBe(false);
  });

  it('SessionEnd discards pending external session (transient filtering)', () => {
    handler.handleEvent('claude', {
      hook_event_name: 'SessionStart',
      session_id: 'transient-sess',
      source: 'startup',
      transcript_path: '/projects/test/transient.jsonl',
      cwd: '/projects/test',
    });

    handler.handleEvent('claude', {
      hook_event_name: 'SessionEnd',
      session_id: 'transient-sess',
      reason: 'other',
    });

    expect(mockWebview.messages).toHaveLength(0);
  });


  it('PreToolUse sends agentToolStart with formatted status', () => {
    const agent = createTestAgent({ id: 1, isWaiting: true });
    agents.set(1, agent);
    handler.registerAgent('sess-1', 1);

    handler.handleEvent('claude', {
      hook_event_name: 'PreToolUse',
      session_id: 'sess-1',
      tool_name: 'Read',
      tool_input: { file_path: '/src/server.ts' },
    });

    const toolMsg = mockWebview.messages.find((m) => m.type === 'agentToolStart');
    expect(toolMsg).toBeTruthy();
    expect(toolMsg?.toolName).toBe('Read');
    expect(toolMsg?.status).toBe('Reading server.ts');
    expect(agent.currentHookToolId).toBeTruthy();
  });

  it('PreToolUse marks agent active and cancels waiting', () => {
    const agent = createTestAgent({ id: 1, isWaiting: true });
    agents.set(1, agent);
    handler.registerAgent('sess-1', 1);

    handler.handleEvent('claude', {
      hook_event_name: 'PreToolUse',
      session_id: 'sess-1',
      tool_name: 'Bash',
      tool_input: { command: 'npm test' },
    });

    expect(agent.isWaiting).toBe(false);
    expect(agent.hadToolsInTurn).toBe(true);
    const activeMsg = mockWebview.messages.find(
      (m) => m.type === 'agentStatus' && m.status === 'active',
    );
    expect(activeMsg).toBeTruthy();
  });

  it('PostToolUse sends agentToolDone and clears currentHookToolId', () => {
    const agent = createTestAgent({ id: 1 });
    agent.currentHookToolId = 'hook-123';
    agents.set(1, agent);
    handler.registerAgent('sess-1', 1);

    handler.handleEvent('claude', {
      hook_event_name: 'PostToolUse',
      session_id: 'sess-1',
    });

    const doneMsg = mockWebview.messages.find((m) => m.type === 'agentToolDone');
    expect(doneMsg).toBeTruthy();
    expect(doneMsg?.toolId).toBe('hook-123');
    expect(agent.currentHookToolId).toBeUndefined();
  });

  it('PostToolUseFailure sends agentToolDone', () => {
    const agent = createTestAgent({ id: 1 });
    agent.currentHookToolId = 'hook-456';
    agents.set(1, agent);
    handler.registerAgent('sess-1', 1);

    handler.handleEvent('claude', {
      hook_event_name: 'PostToolUseFailure',
      session_id: 'sess-1',
    });

    const doneMsg = mockWebview.messages.find((m) => m.type === 'agentToolDone');
    expect(doneMsg).toBeTruthy();
    expect(doneMsg?.toolId).toBe('hook-456');
    expect(agent.currentHookToolId).toBeUndefined();
  });


  it('confirmation event creates pending external session and delivers event', () => {
    const onExternalSessionDetected = vi.fn();
    handler.setLifecycleCallbacks({ onExternalSessionDetected });

    handler.handleEvent('claude', {
      hook_event_name: 'SessionStart',
      session_id: 'ext-sess',
      source: 'startup',
      transcript_path: '/projects/test/ext-sess.jsonl',
      cwd: '/projects/test',
    });

    expect(onExternalSessionDetected).not.toHaveBeenCalled();

    onExternalSessionDetected.mockImplementation((sessionId: string) => {
      const agent = createTestAgent({
        id: 2,
        sessionId,
        projectDir: '/projects/test',
      } as Partial<AgentState>);
      agents.set(2, agent);
      handler.registerAgent(sessionId, 2);
    });

    handler.handleEvent('claude', {
      hook_event_name: 'Stop',
      session_id: 'ext-sess',
    });

    expect(onExternalSessionDetected).toHaveBeenCalledWith(
      'ext-sess',
      '/projects/test/ext-sess.jsonl',
      '/projects/test',
    );
    const agent = agents.get(2);
    expect(agent?.isWaiting).toBe(true);
  });


  it('SessionStart(source=resume) calls onSessionResume', () => {
    const onSessionResume = vi.fn();
    handler.setLifecycleCallbacks({ onSessionResume });

    handler.handleEvent('claude', {
      hook_event_name: 'SessionStart',
      session_id: 'resume-sess',
      source: 'resume',
      transcript_path: '/projects/test/resume-sess.jsonl',
      cwd: '/projects/test',
    });

    expect(onSessionResume).toHaveBeenCalledWith('/projects/test/resume-sess.jsonl');
  });

  it('SessionEnd(resume) + SessionStart(resume) reassigns agent within grace period', async () => {
    const agent = createTestAgent({
      id: 1,
      sessionId: 'old-sess',
      projectDir: '/projects/test',
    });
    agents.set(1, agent);
    handler.registerAgent('old-sess', 1);

    const onSessionClear = vi.fn();
    const onSessionEnd = vi.fn();
    handler.setLifecycleCallbacks({ onSessionClear, onSessionEnd });

    handler.handleEvent('claude', {
      hook_event_name: 'SessionEnd',
      session_id: 'old-sess',
      reason: 'resume',
    });
    expect(agent.pendingClear).toBe(true);

    handler.handleEvent('claude', {
      hook_event_name: 'SessionStart',
      session_id: 'new-resume-sess',
      source: 'resume',
      transcript_path: '/projects/test/new-resume-sess.jsonl',
      cwd: '/projects/test',
    });
    expect(agent.pendingClear).toBe(false);
    expect(onSessionClear).toHaveBeenCalledWith(
      1,
      'new-resume-sess',
      '/projects/test/new-resume-sess.jsonl',
    );

    await new Promise((r) => setTimeout(r, 2500));
    expect(onSessionEnd).not.toHaveBeenCalled();
  });

  it('SessionStart(source=resume) reassigns agent with pendingClear, not other agents in same projectDir', () => {
    const onSessionClear = vi.fn();
    handler.setLifecycleCallbacks({ onSessionClear });

    const resumingAgent = createTestAgent({
      id: 1,
      sessionId: 'old-sess-1',
      projectDir: '/projects/test',
      pendingClear: true,
    });
    agents.set(1, resumingAgent);
    handler.registerAgent('old-sess-1', 1);

    const externalAgent = createTestAgent({
      id: 2,
      sessionId: 'ext-sess-2',
      projectDir: '/projects/test',
      pendingClear: false,
    });
    agents.set(2, externalAgent);
    handler.registerAgent('ext-sess-2', 2);

    handler.handleEvent('claude', {
      hook_event_name: 'SessionStart',
      session_id: 'new-resume-sess',
      source: 'resume',
      transcript_path: '/projects/test/new-resume-sess.jsonl',
      cwd: '/projects/test',
    });

    expect(onSessionClear).toHaveBeenCalledWith(
      1,
      'new-resume-sess',
      '/projects/test/new-resume-sess.jsonl',
    );
    expect(resumingAgent.pendingClear).toBe(false);
    expect(externalAgent.pendingClear).toBe(false);
    expect(externalAgent.sessionId).toBe('ext-sess-2');
  });


  it('SessionStart stores pending with cwd only (no transcript_path)', () => {
    const onExternalSessionDetected = vi.fn();
    handler.setLifecycleCallbacks({ onExternalSessionDetected });

    handler.handleEvent('claude', {
      hook_event_name: 'SessionStart',
      session_id: 'no-transcript-sess',
      source: 'startup',
      cwd: '/projects/test',
    });

    expect(onExternalSessionDetected).not.toHaveBeenCalled();

    onExternalSessionDetected.mockImplementation((sessionId: string) => {
      const agent = createTestAgent({
        id: 2,
        sessionId,
        projectDir: '/projects/test',
      } as Partial<AgentState>);
      agents.set(2, agent);
      handler.registerAgent(sessionId, 2);
    });

    handler.handleEvent('claude', {
      hook_event_name: 'Stop',
      session_id: 'no-transcript-sess',
    });

    expect(onExternalSessionDetected).toHaveBeenCalledWith(
      'no-transcript-sess',
      undefined,
      '/projects/test',
    );
  });

  it('SessionStart(source=resume) uses cwd for matching when no transcript_path', () => {
    const onSessionClear = vi.fn();
    handler.setLifecycleCallbacks({ onSessionClear });

    const agent = createTestAgent({
      id: 1,
      sessionId: 'old-sess',
      projectDir: '/projects/test',
      pendingClear: true,
    });
    agents.set(1, agent);
    handler.registerAgent('old-sess', 1);

    handler.handleEvent('claude', {
      hook_event_name: 'SessionStart',
      session_id: 'resumed-sess',
      source: 'resume',
      cwd: '/projects/test',
    });

    expect(onSessionClear).toHaveBeenCalledWith(1, 'resumed-sess', undefined);
    expect(agent.pendingClear).toBe(false);
  });

  it('SessionStart(source=resume) without transcript_path does not call onSessionResume', () => {
    const onSessionResume = vi.fn();
    handler.setLifecycleCallbacks({ onSessionResume });

    handler.handleEvent('claude', {
      hook_event_name: 'SessionStart',
      session_id: 'resume-no-path',
      source: 'resume',
      cwd: '/projects/test',
    });

    expect(onSessionResume).not.toHaveBeenCalled();
  });


  describe.each([
    { label: 'run_in_background=true', toolInput: { run_in_background: true }, expected: true },
    { label: 'run_in_background=false', toolInput: { run_in_background: false }, expected: false },
  ])('PreToolUse(Agent, $label)', ({ toolInput, expected }) => {
    it(`sets currentHookIsTeammateSpawn=${expected}`, () => {
      const agent = createTestAgent({ id: 1 });
      agents.set(1, agent);
      handler.registerAgent('sess-1', 1);

      handler.handleEvent('claude', {
        hook_event_name: 'PreToolUse',
        session_id: 'sess-1',
        tool_name: 'Agent',
        tool_input: { description: 'Code review', ...toolInput },
      });

      expect(agent.currentHookIsTeammateSpawn).toBe(expected);
    });
  });

  describe.each([
    {
      label: 'teammate (spawn flag + teamName)',
      spawn: true,
      teamName: 'research',
      seedActiveTool: false,
      expectTeammateDetected: true,
    },
    {
      label: 'false-positive guard (spawn flag, no teamName)',
      spawn: true,
      teamName: undefined,
      seedActiveTool: true,
      expectTeammateDetected: false,
    },
    {
      label: 'basic subagent from hook before JSONL (no activeToolNames parent)',
      spawn: false,
      teamName: undefined,
      seedActiveTool: false,
      expectTeammateDetected: false,
    },
  ])('SubagentStart: $label', ({ spawn, teamName, seedActiveTool, expectTeammateDetected }) => {
    it(`onTeammateDetected called=${expectTeammateDetected}`, () => {
      const agent = createTestAgent({
        id: 1,
        currentHookIsTeammateSpawn: spawn,
        ...(teamName ? { teamName } : {}),
      });
      if (seedActiveTool) {
        agent.activeToolNames.set('toolu_real', 'Agent');
      } else if (!spawn) {
        agent.currentHookToolId = 'hook-XXX';
        agent.currentHookToolName = 'Agent';
      }
      agents.set(1, agent);
      handler.registerAgent('sess-1', 1);

      const onTeammateDetected = vi.fn();
      handler.setLifecycleCallbacks({ onTeammateDetected });

      handler.handleEvent('claude', {
        hook_event_name: 'SubagentStart',
        session_id: 'sess-1',
        agent_type: expectTeammateDetected ? 'web-researcher' : 'general-purpose',
      });

      if (expectTeammateDetected) {
        expect(onTeammateDetected).toHaveBeenCalledWith(1, 'sess-1', 'web-researcher');
        expect(mockWebview.messages.find((m) => m.type === 'subagentToolStart')).toBeUndefined();
      } else {
        expect(onTeammateDetected).not.toHaveBeenCalled();
        const msg = mockWebview.messages.find((m) => m.type === 'subagentToolStart');
        if (seedActiveTool) {
          expect(msg).toBeTruthy();
          expect(msg?.parentToolId).toBe('toolu_real');
        } else {
          expect(msg).toBeUndefined();
        }
      }
    });
  });
});
