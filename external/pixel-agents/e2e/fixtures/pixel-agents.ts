import type { Frame, Page, TestInfo } from '@playwright/test';
import { expect, test as base } from '@playwright/test';
import fs from 'fs';
import path from 'path';

import { applyAllureLabels } from '../helpers/allure-labels';
import { launchVSCode, type VSCodeSession, waitForWorkbench } from '../helpers/launch';
import { killTrackedExternalProcesses } from '../helpers/mock-claude';
import {
  clearNarrationContext,
  finishNarration,
  openMonitorTerminal,
  setNarrationContext,
  type TestNarrator,
} from '../helpers/test-narration';
import { arrangeReviewLayout, getPixelAgentsFrame, openPixelAgentsPanel } from '../helpers/webview';

const ATTACH_VIDEOS_ON_SUCCESS = process.env['PIXEL_AGENTS_E2E_ATTACH_VIDEOS_ON_SUCCESS'] === '1';

export interface PixelAgentsContext {
  session: VSCodeSession;
  window: Page;
  frame: Frame;
  tmpHome: string;
  workspaceDir: string;
  mockLogFile: string;
  narrator: TestNarrator;
}

async function attachTextFileIfExists(
  testInfo: TestInfo,
  name: string,
  filePath: string,
  contentType: string,
): Promise<void> {
  try {
    if (!fs.existsSync(filePath)) return;
    await testInfo.attach(name, {
      body: fs.readFileSync(filePath, 'utf8'),
      contentType,
    });
  } catch {
  }
}

function shouldAttachRunVideo(testInfo: TestInfo): boolean {
  return ATTACH_VIDEOS_ON_SUCCESS || testInfo.status !== 'passed';
}

function removeDirIfExists(dirPath: string | undefined): void {
  try {
    if (!dirPath || !fs.existsSync(dirPath)) return;
    fs.rmSync(dirPath, { recursive: true, force: true });
  } catch {
  }
}

export const test = base.extend<{
  pixelAgents: PixelAgentsContext;
  _allureLabels: void;
  seedConfig: unknown;
  seedLayout: unknown;
  workspaceFolders: string[];
}>({
  seedConfig: [undefined, { option: true }],
  seedLayout: [undefined, { option: true }],
  workspaceFolders: [[], { option: true }],
  _allureLabels: [
    async ({}, use, testInfo) => {
      await applyAllureLabels(testInfo);
      await use();
    },
    { auto: true },
  ],
  pixelAgents: async ({ seedConfig, seedLayout, workspaceFolders }, use, testInfo) => {
    const session = await launchVSCode(testInfo.title, {
      seedConfig,
      seedLayout,
      workspaceFolders,
    });
    const { window, tmpHome, workspaceDir, mockLogFile } = session;
    const runVideo = window.video();

    try {
      await waitForWorkbench(window);
      await openPixelAgentsPanel(window, { autoShown: true });
      await arrangeReviewLayout(window);
      const frame = await getPixelAgentsFrame(window);

      await openMonitorTerminal(window, tmpHome);

      const narrator = setNarrationContext(tmpHome);

      await use({
        session,
        window,
        frame,
        tmpHome,
        workspaceDir,
        mockLogFile,
        narrator,
      });
    } finally {
      await finishNarration(window);

      const keepArtifacts = shouldAttachRunVideo(testInfo);

      if (keepArtifacts) {
        await attachTextFileIfExists(
          testInfo,
          'mock-claude-invocations',
          mockLogFile,
          'text/plain',
        );
        await attachTextFileIfExists(
          testInfo,
          'mock-claude-actions',
          path.join(tmpHome, '.claude-mock', 'actions.log'),
          'text/plain',
        );
        await attachTextFileIfExists(
          testInfo,
          'launch-log',
          path.join(tmpHome, '.claude-mock', 'launch.log'),
          'text/plain',
        );
        await attachTextFileIfExists(
          testInfo,
          'server-json',
          path.join(tmpHome, '.pixel-agents', 'server.json'),
          'application/json',
        );
        await attachTextFileIfExists(
          testInfo,
          'pixel-agents-debug-log',
          path.join(tmpHome, '.pixel-agents', 'debug.log'),
          'text/plain',
        );
        try {
          const wvFrames = window.frames();
          for (const f of wvFrames) {
            if (!f.url().startsWith('vscode-webview://')) continue;
            const log = await f.evaluate(() => window.__pixelAgentsTestHooks?.messageLog ?? null);
            if (log) {
              await testInfo.attach('webview-message-log', {
                body: JSON.stringify(log, null, 2),
                contentType: 'application/json',
              });
              break;
            }
          }
        } catch {
        }

        try {
          const screenshotPath = testInfo.outputPath('final-screenshot.png');
          await window.screenshot({ path: screenshotPath });
          await testInfo.attach('final-screenshot', {
            path: screenshotPath,
            contentType: 'image/png',
          });
        } catch {
        }
      }

      const attachRunVideo = runVideo !== null && shouldAttachRunVideo(testInfo);
      clearNarrationContext();
      await killTrackedExternalProcesses();
      await session.cleanup();

      if (attachRunVideo && runVideo) {
        try {
          const videoPath = testInfo.outputPath('run-video.webm');
          await runVideo.saveAs(videoPath);
          await testInfo.attach('run-video', {
            path: videoPath,
            contentType: 'video/webm',
          });
        } catch {
        }
      } else {
        removeDirIfExists(session.videoDir);
      }
    }
  },
});

export { expect };
