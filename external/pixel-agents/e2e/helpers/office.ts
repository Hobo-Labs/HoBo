import type { Frame, Locator, Page } from '@playwright/test';
import { expect } from '@playwright/test';

import { narrate } from './test-narration';

type OverlaySurface = Frame | Page;

const OVERLAY_TIMEOUT_MS = 15_000;


export function getAgentOverlays(frame: OverlaySurface): Locator {
  return frame.locator('[data-testid="agent-overlay"]');
}

export function getOverlayByText(frame: OverlaySurface, text: string): Locator {
  return getAgentOverlays(frame).filter({ hasText: text });
}

export function getOverlayByTexts(frame: OverlaySurface, texts: string[]): Locator {
  return texts.reduce<Locator>(
    (locator, text) => locator.filter({ hasText: text }),
    getAgentOverlays(frame),
  );
}

export function getOverlayByAgentId(frame: OverlaySurface, agentId: number): Locator {
  return frame.locator(`[data-testid="agent-overlay"][data-agent-id="${agentId}"]`);
}

export async function expectOverlayCount(
  frame: OverlaySurface,
  count: number,
  timeout = OVERLAY_TIMEOUT_MS,
): Promise<void> {
  await expect(getAgentOverlays(frame)).toHaveCount(count, { timeout });
}

export async function expectOverlayVisible(
  frame: OverlaySurface,
  text: string,
  timeout = OVERLAY_TIMEOUT_MS,
): Promise<void> {
  await expect(getOverlayByText(frame, text).first()).toBeVisible({ timeout });
}

export async function expectOverlayVisibleWithTexts(
  frame: OverlaySurface,
  texts: string[],
  timeout = OVERLAY_TIMEOUT_MS,
): Promise<void> {
  await expect(getOverlayByTexts(frame, texts).first()).toBeVisible({ timeout });
}

export async function expectOverlayVisibleForAgent(
  frame: OverlaySurface,
  agentId: number,
  text: string,
  timeout = OVERLAY_TIMEOUT_MS,
): Promise<void> {
  await expect(getOverlayByAgentId(frame, agentId).filter({ hasText: text })).toBeVisible({
    timeout,
  });
}

export async function expectNoOverlay(
  frame: OverlaySurface,
  text: string,
  timeout = 1_000,
): Promise<void> {
  await expect(getOverlayByText(frame, text)).toHaveCount(0, { timeout });
}

export async function expectNoOverlayWithTexts(
  frame: OverlaySurface,
  texts: string[],
  timeout = 1_000,
): Promise<void> {
  await expect(getOverlayByTexts(frame, texts)).toHaveCount(0, { timeout });
}

export async function readAgentOverlayIds(frame: OverlaySurface): Promise<number[]> {
  const rawIds = await getAgentOverlays(frame).evaluateAll((elements) =>
    elements.map((element) => element.getAttribute('data-agent-id')),
  );

  return rawIds.flatMap((value) => {
    const id = Number(value);
    return Number.isFinite(id) ? [id] : [];
  });
}

export async function readAgentOverlayTexts(
  frame: OverlaySurface,
): Promise<Array<{ id: number; text: string }>> {
  return getAgentOverlays(frame).evaluateAll((elements) =>
    elements.flatMap((element) => {
      const rawId = element.getAttribute('data-agent-id');
      const id = Number(rawId);
      if (!Number.isFinite(id)) {
        return [];
      }
      return [
        {
          id,
          text: element.textContent ?? '',
        },
      ];
    }),
  );
}

export async function expectSingleAgentOverlay(frame: OverlaySurface): Promise<number> {
  await expectOverlayCount(frame, 1);
  const ids = await readAgentOverlayIds(frame);
  if (ids.length !== 1) {
    throw new Error(`Expected exactly one agent overlay id, got ${JSON.stringify(ids)}`);
  }
  return ids[0]!;
}

export async function closeAgentFromOverlay(
  frame: OverlaySurface,
  options: { agentId?: number; text?: string },
  timeout = OVERLAY_TIMEOUT_MS,
): Promise<void> {
  const overlay =
    options.agentId !== undefined
      ? getOverlayByAgentId(frame, options.agentId).first()
      : getOverlayByText(frame, options.text ?? '').first();
  await expect(overlay).toBeVisible({ timeout });

  const agentId = options.agentId ?? Number(await overlay.getAttribute('data-agent-id'));
  await frame.evaluate((id) => {
    window.__pixelAgentsTestHooks?.selectAgent?.(id);
  }, agentId);

  const closeButton = overlay.locator('button[title="Close agent"]');
  await expect(closeButton).toBeVisible({ timeout });
  narrate.step('closing the agent via its "×" overlay button');
  await closeButton.click();
}
