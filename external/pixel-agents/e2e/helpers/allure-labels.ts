import type { TestInfo } from '@playwright/test';
import { allure } from 'allure-playwright';

const AREA_TO_EPIC: Record<string, string> = {
  spawn: 'Spawn paths',
  lifecycle: 'Lifecycle regressions',
  'cross-cutting': 'Cross-cutting checks',
  teams: 'Teams routing',
  matrix: 'Hooks-off matrix',
  standalone: 'Standalone server',
  pets: 'Pet system',
  carpet: 'Carpet system',
  areas: 'Areas (zoning) system',
};

export async function applyAllureLabels(testInfo: TestInfo): Promise<void> {
  const areaTag = testInfo.tags.find((t) => /^@?area:/.test(t));
  if (!areaTag) return;
  const area = areaTag.replace(/^@?area:/, '');
  const epic = AREA_TO_EPIC[area] ?? `area:${area}`;
  await allure.epic(epic);
}
