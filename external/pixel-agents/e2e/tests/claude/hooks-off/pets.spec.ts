import type { Frame, Locator } from '@playwright/test';
import fs from 'fs';
import path from 'path';

import { expect, test } from '../../../fixtures/pixel-agents';
import { closeBottomPanel, getPixelAgentsFrame, reopenBottomPanel } from '../../../helpers/webview';


interface PetSnapshot {
  id: string;
  name: string;
  petType: number;
  state: 'idle' | 'walk' | 'follow';
  x: number;
  y: number;
  bubbleType: 'heart' | null;
}

interface PetTestHooks {
  getPets?: () => PetSnapshot[];
  petClick?: (petId: string) => void;
  messageLog?: Array<{ type: string }>;
}

type PetWindow = Window & { __pixelAgentsTestHooks?: PetTestHooks };

const PETS_CAROUSEL = '[data-testid="pets-carousel"]';

async function dismissFirstRunTooltips(frame: Frame): Promise<void> {
  for (const tooltipText of ['Instant Detection Active', 'Updated to v']) {
    const tooltip = frame.locator('div', { hasText: tooltipText }).first();
    if (await tooltip.isVisible().catch(() => false)) {
      const closeBtn = tooltip.locator('button', { hasText: 'x' }).first();
      if (await closeBtn.isVisible().catch(() => false)) {
        await closeBtn.click().catch(() => {});
      }
    }
  }
}

async function openPetsTab(frame: Frame): Promise<Locator> {
  await dismissFirstRunTooltips(frame);
  await frame.locator('button[title="Edit office layout"]').click();
  await frame.locator('button[title="Place pets"]').click();
  const carousel = frame.locator(PETS_CAROUSEL);
  await expect(carousel).toBeVisible({ timeout: 15_000 });
  return carousel;
}

async function readPets(frame: Frame): Promise<PetSnapshot[]> {
  return frame.evaluate(() => {
    const w = window as PetWindow;
    return w.__pixelAgentsTestHooks?.getPets?.() ?? [];
  });
}

async function petClick(frame: Frame, petId: string): Promise<void> {
  await frame.evaluate((id) => {
    (window as PetWindow).__pixelAgentsTestHooks?.petClick?.(id);
  }, petId);
}

test.describe('Pets', () => {
  test('pet sprites load, broadcast, and expose manifest names in the editor @area:pets', async ({
    pixelAgents,
  }) => {
    const { frame, narrator } = pixelAgents;

    narrator.step('waiting for the pet sprites to broadcast to the webview');
    await frame.waitForFunction(() => {
      const w = window as PetWindow;
      const log = w.__pixelAgentsTestHooks?.messageLog ?? [];
      return log.some((m) => m.type === 'petSpritesLoaded');
    });
    narrator.check('petSpritesLoaded reached the client — pet assets delivered');

    narrator.step('opening the layout editor → Pets tab');
    const carousel = await openPetsTab(frame);
    await expect(carousel.locator('button')).toHaveCount(2);
    narrator.check('carousel has exactly 2 pet thumbnails');
    await expect(carousel.locator('button[title="Claudio"]')).toBeVisible();
    await expect(carousel.locator('button[title="Gitcat"]')).toBeVisible();
    narrator.check('thumbnails titled "Claudio" and "Gitcat" — manifest names surfaced');
  });

  test('placing a pet toggles it on/off and persists across a panel reload @area:pets', async ({
    pixelAgents,
  }) => {
    const { frame, window, tmpHome, narrator } = pixelAgents;

    narrator.step('opening the layout editor → Pets tab');
    const carousel = await openPetsTab(frame);
    const claudio = carousel.locator('button[title="Claudio"]');
    const gitcat = carousel.locator('button[title="Gitcat"]');

    narrator.step('clicking Claudio — placing the pet');
    await claudio.click();
    await frame.waitForFunction(() => {
      const pets = (window as PetWindow).__pixelAgentsTestHooks?.getPets?.() ?? [];
      return pets.length === 1 && pets[0]?.petType === 0;
    });
    narrator.check('one pet on the canvas (getPets → 1, petType claudio)');

    narrator.step('clicking Claudio again — removing the pet');
    await claudio.click();
    await frame.waitForFunction(
      () => ((window as PetWindow).__pixelAgentsTestHooks?.getPets?.() ?? []).length === 0,
    );
    narrator.check('canvas empty again (getPets → 0)');

    narrator.step('placing both pets — Claudio, then Gitcat');
    await claudio.click();
    await frame.waitForFunction(
      () =>
        ((globalThis as unknown as PetWindow).__pixelAgentsTestHooks?.getPets?.() ?? []).length ===
        1,
    );
    await gitcat.click();
    await frame.waitForFunction(
      () => ((window as PetWindow).__pixelAgentsTestHooks?.getPets?.() ?? []).length === 2,
    );
    narrator.check('two pets on the canvas (getPets → 2)');

    narrator.step('clicking Save — persisting the layout to disk');
    const saveBtn = frame.locator('button', { hasText: 'Save' });
    await expect(saveBtn).toBeVisible({ timeout: 5_000 });
    await saveBtn.click();

    const layoutPath = path.join(tmpHome, '.pixel-agents', 'layout.json');
    await expect
      .poll(
        () => {
          if (!fs.existsSync(layoutPath)) return -1;
          try {
            const parsed = JSON.parse(fs.readFileSync(layoutPath, 'utf8')) as {
              pets?: unknown[];
            };
            return Array.isArray(parsed.pets) ? parsed.pets.length : -1;
          } catch {
            return -1;
          }
        },
        { timeout: 10_000 },
      )
      .toBe(2);
    narrator.check('~/.pixel-agents/layout.json contains 2 pets');

    narrator.step('closing the bottom panel — the webview is disposed');
    await closeBottomPanel(window);
    narrator.step('reopening the panel — pets must rehydrate from disk');
    await reopenBottomPanel(window);
    const freshFrame = await getPixelAgentsFrame(window);
    await freshFrame.waitForFunction(
      () => ((window as PetWindow).__pixelAgentsTestHooks?.getPets?.() ?? []).length === 2,
      undefined,
      { timeout: 15_000 },
    );
    narrator.check('fresh webview shows 2 pets again — persisted across the reload');
  });

  test('clicking a pet shows a heart bubble that auto-dismisses and dismisses on re-click @area:pets', async ({
    pixelAgents,
  }) => {
    const { frame, narrator } = pixelAgents;

    narrator.step('placing one pet (Claudio) via the editor');
    const carousel = await openPetsTab(frame);
    await carousel.locator('button[title="Claudio"]').click();
    await frame.waitForFunction(
      () => ((window as PetWindow).__pixelAgentsTestHooks?.getPets?.() ?? []).length === 1,
    );
    const pets = await readPets(frame);
    const petId = pets[0]!.id;
    narrator.check('pet placed (getPets → 1)');

    narrator.step('clicking the pet — heart bubble should appear');
    await petClick(frame, petId);
    await frame.waitForFunction((id) => {
      const p = ((window as PetWindow).__pixelAgentsTestHooks?.getPets?.() ?? []).find(
        (x) => x.id === id,
      );
      return p?.bubbleType === 'heart';
    }, petId);
    narrator.check('heart bubble showing (bubbleType = heart)');

    narrator.step('waiting for the 2s auto-dismiss timer, no clicks');
    await frame.waitForFunction(
      (id) => {
        const p = ((window as PetWindow).__pixelAgentsTestHooks?.getPets?.() ?? []).find(
          (x) => x.id === id,
        );
        return p?.bubbleType === null;
      },
      petId,
      { timeout: 6_000 },
    );
    narrator.check('bubble auto-dismissed on its own (bubbleType = null)');

    narrator.step('clicking again — heart bubble re-appears');
    await petClick(frame, petId);
    await frame.waitForFunction((id) => {
      const p = ((window as PetWindow).__pixelAgentsTestHooks?.getPets?.() ?? []).find(
        (x) => x.id === id,
      );
      return p?.bubbleType === 'heart';
    }, petId);
    narrator.check('heart bubble showing again');

    narrator.step('clicking while showing — must dismiss fast, not wait out the 2s timer');
    await petClick(frame, petId);
    await frame.waitForFunction(
      (id) => {
        const p = ((window as PetWindow).__pixelAgentsTestHooks?.getPets?.() ?? []).find(
          (x) => x.id === id,
        );
        return p?.bubbleType === null;
      },
      petId,
      { timeout: 1_000 },
    );
    narrator.check('bubble cleared within 1s of the click — fast-dismiss path confirmed');
  });
});
