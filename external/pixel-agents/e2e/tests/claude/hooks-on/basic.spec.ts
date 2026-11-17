import path from 'path';

import { expect, test } from '../../../fixtures/pixel-agents';
import {
  permissionRequest,
  preToolUseBash,
  sessionEndExit,
  sessionStartStartup,
  stop,
  waitForHookServer,
} from '../../../helpers/hooks';
import { spawnInternalAgentAndWait } from '../../../helpers/internal-agent';
import {
  arrangeNextClaudeInvocation,
  claudeScenario,
  spawnExternalClaudeScenario,
  waitForClaudeHookSetup,
} from '../../../helpers/mock-claude';
import { expectOverlayCount, expectOverlayVisible } from '../../../helpers/office';
import { buildAssistantToolUseRecord, buildUserToolResultRecord } from '../../../helpers/team';
import { getPixelAgentsFrame, openPixelAgentsPanel, setSettings } from '../../../helpers/webview';

test.describe('Hooks ON / spawn paths', () => {
  test('internal terminal spawns agent and Task subagent appears then despawns @area:spawn', async ({
    pixelAgents,
  }) => {
    const { frame, window, tmpHome, mockLogFile, narrator } = pixelAgents;

    narrator.step('arming the mock: spawn a Task subtask at t+5s, close it at t+13s');
    await arrangeNextClaudeInvocation(
      tmpHome,
      claudeScenario('internal terminal basic spawn')
        .at(5_000)
        .appendJsonl(
          buildAssistantToolUseRecord('toolu-subagent-spawn', 'Task', {
            description: 'spawned subtask',
          }),
        )
        .at(13_000)
        .appendJsonl(buildUserToolResultRecord('toolu-subagent-spawn'))
        .holdOpenFor(15_000)
        .build(),
    );
    const spawned = await spawnInternalAgentAndWait(frame, tmpHome, mockLogFile);

    await openPixelAgentsPanel(window);
    const panelFrame = await getPixelAgentsFrame(window);
    await expectOverlayCount(panelFrame, 1);
    narrator.check('the lead character is on screen — one agent, no subtask yet');

    expect(spawned.invocationLog).toContain(`session-id=${spawned.sessionId}`);
    expect(path.basename(spawned.jsonlFile)).toBe(`${spawned.sessionId}.jsonl`);

    const terminalTab = window.getByText(/Claude Code #\d+/);
    await expect(terminalTab.first()).toBeVisible({ timeout: 15_000 });
    narrator.check('a real "Claude Code #N" terminal tab is open');

    narrator.step('waiting for the t+5s Task tool_use to spawn a "Subtask" character');
    await expectOverlayCount(panelFrame, 2);
    await expectOverlayVisible(panelFrame, 'Subtask: spawned subtask');
    narrator.check('"Subtask: spawned subtask" overlay up — count 1 → 2');

    narrator.step('waiting for the t+13s tool_result — the subtask should despawn');
    await expectOverlayCount(panelFrame, 1);
    narrator.check('count back to 1 after the tool_result');
  });

  test('external Claude session adopted via hook confirmation lifecycle @area:spawn', async ({
    pixelAgents,
  }) => {
    const { frame, tmpHome, workspaceDir, mockLogFile, narrator } = pixelAgents;

    narrator.step('enabling Watch All Sessions so the hooks-only session gets adopted');
    await setSettings(frame, {
      watchAllSessions: true,
    });

    narrator.step('waiting for the hook install and hook server to be ready');
    await waitForClaudeHookSetup(tmpHome);
    await waitForHookServer(tmpHome);
    const sessionId = 'external-hook-session';

    await spawnExternalClaudeScenario({
      tmpHome,
      workspaceDir,
      mockLogFile,
      sessionId,
      scenario: claudeScenario('external hook-driven session adoption')
        .at(200)
        .emitHook(
          sessionStartStartup(sessionId, '{{cwd}}', '{{transcriptPath}}') as Record<
            string,
            unknown
          >,
        )
        .at(700)
        .emitHook(preToolUseBash(sessionId, 'npm test') as Record<string, unknown>)
        .at(4_500)
        .emitHook(permissionRequest(sessionId) as Record<string, unknown>)
        .at(8_500)
        .emitHook(stop(sessionId) as Record<string, unknown>)
        .at(13_500)
        .emitHook(sessionEndExit(sessionId) as Record<string, unknown>)
        .holdOpenFor(15_500)
        .build(),
    });


    narrator.step('waiting for the t+0.7s PreToolUse(Bash) to confirm the session');
    await expectOverlayCount(frame, 1);
    await expectOverlayVisible(frame, 'Running: npm test');
    narrator.check('the external agent appeared — "Running: npm test"');

    narrator.step('waiting for the t+4.5s PermissionRequest');
    await expectOverlayVisible(frame, 'Needs approval');
    narrator.check('"Needs approval" bubble on the agent');

    narrator.step('waiting for the t+8.5s Stop — checkmark, then "Idle" after the fade');
    await expectOverlayVisible(frame, 'Idle');
    narrator.check('turn finished — "Idle" after the green checkmark fades');

    narrator.step('waiting for the t+13.5s SessionEnd to remove the agent');
    await expectOverlayCount(frame, 0);
    narrator.check('the agent is gone — count back to 0');
  });
});
