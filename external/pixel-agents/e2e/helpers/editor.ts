import type { Frame } from '@playwright/test';
import { expect } from '@playwright/test';

export interface TestHooksWindow extends Window {
  __pixelAgentsTestHooks?: {
    getCarpetTiles?: () => Array<{
      col: number;
      row: number;
      variant: number;
      color?: unknown;
      accentColor?: unknown;
      order?: number;
    }>;
    getCarpetJunctionCase?: (jx: number, jy: number, variant: number) => number;
    getAreas?: () => Array<{ label: string; color: string }>;
    getAreaTiles?: () => Array<{ col: number; row: number; label: string }>;
    getAreaMappings?: () => Record<string, string[]>;
    getShowAreas?: () => boolean;
    getAgentSeats?: () => Array<{
      id: number;
      seatId: string | null;
      areaLabel: string | null;
      folderName?: string;
    }>;
    getSeats?: () => Array<{
      uid: string;
      col: number;
      row: number;
      areaLabel: string | null;
      assigned: boolean;
    }>;
    editorTileAction?: (col: number, row: number) => void;
    editorEraseAction?: (col: number, row: number) => void;
    messageLog?: Array<{ type: string }>;
  };
}

export async function dismissFirstRunTooltips(frame: Frame): Promise<void> {
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

export async function enterEditMode(frame: Frame): Promise<void> {
  await dismissFirstRunTooltips(frame);
  await frame.locator('button[title="Edit office layout"]').click();
}

export async function selectCarpetTool(frame: Frame): Promise<void> {
  await frame.locator('button[title="Place furniture"]').click();
  await frame.locator('button[title="Paint carpets"]').click();
}

export async function selectCarpetVariant(frame: Frame, variant: number): Promise<void> {
  await frame.locator(`[title="Carpet ${variant + 1}"]`).click();
}

export async function selectCarpetPickTool(frame: Frame): Promise<void> {
  await frame.locator('button[title*="Pick carpet"]').click();
}

export async function selectAreaTool(frame: Frame): Promise<void> {
  await frame.locator('button[title*="Define folder-bound areas"]').click();
}

export async function addArea(frame: Frame, name: string): Promise<void> {
  await frame.locator('input[placeholder="Area name…"]').fill(name);
  await frame.locator('button[title="Add a new Area"]').click();
}

export async function selectArea(frame: Frame, label: string): Promise<void> {
  await frame.locator(`span[title^="${label} —"]`).click();
}

export async function paintTile(frame: Frame, col: number, row: number): Promise<void> {
  await frame.evaluate(
    ([c, r]) => (window as TestHooksWindow).__pixelAgentsTestHooks?.editorTileAction?.(c, r),
    [col, row] as const,
  );
}

export async function eraseTile(frame: Frame, col: number, row: number): Promise<void> {
  await frame.evaluate(
    ([c, r]) => (window as TestHooksWindow).__pixelAgentsTestHooks?.editorEraseAction?.(c, r),
    [col, row] as const,
  );
}

export async function saveLayout(frame: Frame): Promise<void> {
  const saveBtn = frame.locator('button', { hasText: 'Save' });
  await expect(saveBtn).toBeVisible({ timeout: 5_000 });
  await saveBtn.click();
}

export async function readCarpetTiles(
  frame: Frame,
): Promise<Array<{ col: number; row: number; variant: number }>> {
  return frame.evaluate(
    () =>
      (window as TestHooksWindow).__pixelAgentsTestHooks?.getCarpetTiles?.().map((t) => ({
        col: t.col,
        row: t.row,
        variant: t.variant,
      })) ?? [],
  );
}

export async function readCarpetJunctionCase(
  frame: Frame,
  jx: number,
  jy: number,
  variant: number,
): Promise<number> {
  return frame.evaluate(
    ([x, y, v]) =>
      (window as TestHooksWindow).__pixelAgentsTestHooks?.getCarpetJunctionCase?.(x, y, v) ?? 0,
    [jx, jy, variant] as const,
  );
}

export async function readAreaTiles(
  frame: Frame,
): Promise<Array<{ col: number; row: number; label: string }>> {
  return frame.evaluate(
    () => (window as TestHooksWindow).__pixelAgentsTestHooks?.getAreaTiles?.() ?? [],
  );
}

export async function readAreas(frame: Frame): Promise<Array<{ label: string; color: string }>> {
  return frame.evaluate(
    () => (window as TestHooksWindow).__pixelAgentsTestHooks?.getAreas?.() ?? [],
  );
}

export async function readSeats(
  frame: Frame,
): Promise<
  Array<{ uid: string; col: number; row: number; areaLabel: string | null; assigned: boolean }>
> {
  return frame.evaluate(
    () => (window as TestHooksWindow).__pixelAgentsTestHooks?.getSeats?.() ?? [],
  );
}

export async function readAgentSeats(
  frame: Frame,
): Promise<
  Array<{ id: number; seatId: string | null; areaLabel: string | null; folderName?: string }>
> {
  return frame.evaluate(
    () => (window as TestHooksWindow).__pixelAgentsTestHooks?.getAgentSeats?.() ?? [],
  );
}
