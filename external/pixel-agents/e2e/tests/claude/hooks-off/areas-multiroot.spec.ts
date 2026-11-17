import type { Frame, Page } from '@playwright/test';

import { expect, test } from '../../../fixtures/pixel-agents';
import {
  addArea,
  enterEditMode,
  paintTile,
  readAgentSeats,
  readAreas,
  readAreaTiles,
  readSeats,
  saveLayout,
  selectArea,
  selectAreaTool,
  type TestHooksWindow,
} from '../../../helpers/editor';
import { addAgentForFolder } from '../../../helpers/internal-agent';
import { buildSeedConfig } from '../../../helpers/layout-seed';
import { getPixelAgentsFrame, openPixelAgentsPanel } from '../../../helpers/webview';


const ALPHA = 'alpha';
const BETA = 'beta';

async function startArea(frame: Frame, label: string): Promise<void> {
  await enterEditMode(frame);
  await selectAreaTool(frame);
  await addArea(frame, label);
  await selectArea(frame, label);
}

test.describe('Areas (multi-root)', () => {
  test.use({ workspaceFolders: [ALPHA, BETA] });

  test('painting an area labels tiles in the layout @area:areas', async ({ pixelAgents }) => {
    const { frame, narrator } = pixelAgents;
    narrator.step('opening the Areas editor and adding an "Engineering" area');
    await startArea(frame, 'Engineering');

    const seats = await readSeats(frame);
    const targets = seats.slice(0, 2);
    expect(targets.length).toBeGreaterThan(0);
    narrator.step('painting Engineering over two real seat tiles');
    for (const s of targets) {
      await paintTile(frame, s.col, s.row);
    }

    await frame.waitForFunction(
      (n) =>
        ((window as TestHooksWindow).__pixelAgentsTestHooks?.getAreaTiles?.() ?? []).length >= n,
      targets.length,
      { timeout: 10_000 },
    );
    const areaTiles = await readAreaTiles(frame);
    for (const s of targets) {
      expect(areaTiles).toContainEqual({ col: s.col, row: s.row, label: 'Engineering' });
    }
    narrator.check('both painted tiles are labeled "Engineering"');
  });

  test('areas can be added and removed @area:areas', async ({ pixelAgents }) => {
    const { frame, narrator } = pixelAgents;
    narrator.step('opening the layout editor → Areas tool');
    await enterEditMode(frame);
    await selectAreaTool(frame);

    narrator.step('adding a "Design" area');
    await addArea(frame, 'Design');
    await frame.waitForFunction(
      () =>
        ((window as TestHooksWindow).__pixelAgentsTestHooks?.getAreas?.() ?? []).some(
          (a) => a.label === 'Design',
        ),
      undefined,
      { timeout: 10_000 },
    );
    expect(await readAreas(frame)).toContainEqual(expect.objectContaining({ label: 'Design' }));
    narrator.check('"Design" appears in the areas list');

    narrator.step('removing "Design" with its card\'s × button');
    await frame.locator('button[title="Remove area"]').first().click();
    await frame.waitForFunction(
      () =>
        !((window as TestHooksWindow).__pixelAgentsTestHooks?.getAreas?.() ?? []).some(
          (a) => a.label === 'Design',
        ),
      undefined,
      { timeout: 10_000 },
    );
    narrator.check('"Design" is gone from the areas list');
  });

  test('a folder can be mapped to an area and the mapping persists @area:areas', async ({
    pixelAgents,
  }) => {
    const { frame, narrator } = pixelAgents;
    narrator.step('opening the layout editor → Areas tool');
    await enterEditMode(frame);
    await selectAreaTool(frame);
    narrator.step('adding an "Engineering" area');
    await addArea(frame, 'Engineering');

    narrator.step('opening Engineering\'s "Map a folder…" menu and picking alpha');
    await frame.locator('button[title*="Map a folder"]').first().click();
    await frame.getByText(ALPHA, { exact: true }).click();

    await frame.waitForFunction(
      (folder) => {
        const m = (window as TestHooksWindow).__pixelAgentsTestHooks?.getAreaMappings?.() ?? {};
        return (m[folder] ?? []).includes('Engineering');
      },
      ALPHA,
      { timeout: 10_000 },
    );
    narrator.check('the alpha folder now maps to "Engineering"');
  });

  test.describe('seat preference (alpha → Engineering)', () => {
    test.use({ seedConfig: buildSeedConfig({ areaMappings: { [ALPHA]: ['Engineering'] } }) });

    async function paintAndSaveEngineering(frame: Frame): Promise<void> {
      await startArea(frame, 'Engineering');
      const seats = await readSeats(frame);
      const targetSeats = seats.filter((s) => !s.assigned).slice(0, 3);
      expect(targetSeats.length).toBeGreaterThan(0);
      for (const seat of targetSeats) {
        await paintTile(frame, seat.col, seat.row);
      }
      await frame.waitForFunction(
        (n) =>
          ((window as TestHooksWindow).__pixelAgentsTestHooks?.getAreaTiles?.() ?? []).length >= n,
        targetSeats.length,
        { timeout: 10_000 },
      );
      await saveLayout(frame);
    }

    async function reacquireFrame(window: Page): Promise<Frame> {
      await openPixelAgentsPanel(window);
      return getPixelAgentsFrame(window);
    }

    test('an agent for the MAPPED folder takes a seat inside its area @area:areas', async ({
      pixelAgents,
    }) => {
      const { frame, window, tmpHome, mockLogFile, narrator } = pixelAgents;
      narrator.step('painting Engineering over free seats and saving the layout');
      await paintAndSaveEngineering(frame);

      await addAgentForFolder(frame, ALPHA, tmpHome, mockLogFile);
      narrator.step('re-opening the panel — the spawned terminal disposed the webview');
      const fresh = await reacquireFrame(window);

      narrator.step('expecting the restored alpha agent to re-seat inside Engineering');
      await fresh.waitForFunction(
        (folder) =>
          ((window as TestHooksWindow).__pixelAgentsTestHooks?.getAgentSeats?.() ?? []).some(
            (a) => a.folderName === folder && a.seatId !== null,
          ),
        ALPHA,
        { timeout: 20_000 },
      );
      const agentSeats = await readAgentSeats(fresh);
      const alphaAgent = agentSeats.find((a) => a.folderName === ALPHA);
      expect(alphaAgent?.areaLabel).toBe('Engineering');
      narrator.check(
        'the alpha agent\'s seat is labeled "Engineering" — steered into its mapped area',
      );
    });

    test('an agent for an UNMAPPED folder is not forced into the area @area:areas', async ({
      pixelAgents,
    }) => {
      const { frame, window, tmpHome, mockLogFile, narrator } = pixelAgents;
      narrator.step('painting Engineering over free seats and saving the layout');
      await paintAndSaveEngineering(frame);

      await addAgentForFolder(frame, BETA, tmpHome, mockLogFile);
      narrator.step('re-opening the panel after spawning the beta agent');
      const fresh = await reacquireFrame(window);

      narrator.step('expecting the unmapped beta agent to land on an unzoned seat');
      await fresh.waitForFunction(
        (folder) =>
          ((window as TestHooksWindow).__pixelAgentsTestHooks?.getAgentSeats?.() ?? []).some(
            (a) => a.folderName === folder && a.seatId !== null,
          ),
        BETA,
        { timeout: 20_000 },
      );
      const agentSeats = await readAgentSeats(fresh);
      const betaAgent = agentSeats.find((a) => a.folderName === BETA);
      expect(betaAgent?.areaLabel).not.toBe('Engineering');
      narrator.check(
        'the beta agent\'s seat is NOT "Engineering" — an unmapped folder is not forced in',
      );
    });
  });
});
