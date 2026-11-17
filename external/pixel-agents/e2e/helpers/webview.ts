import type { Frame, Locator, Page } from '@playwright/test';
import { expect } from '@playwright/test';

type WebviewSurface = Frame | Page;

const WEBVIEW_TIMEOUT_MS = 30_000;
const PANEL_OPEN_TIMEOUT_MS = 15_000;
const MIN_PANEL_HEIGHT_PX = 320;

export interface WebviewSettings {
  watchAllSessions?: boolean;
  hooksEnabled?: boolean;
  alwaysShowLabels?: boolean;
  debugView?: boolean;
}

export async function runCommand(window: Page, command: string, attempts = 3): Promise<void> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    await window.keyboard.press('Escape');
    await window.waitForTimeout(300);

    let phase = 'open';
    try {
      phase = 'open';
      await window.keyboard.press('F1');
      await window.waitForSelector('.quick-input-widget .quick-input-filter input', {
        state: 'visible',
        timeout: 5_000,
      });
      phase = 'type';
      await window.keyboard.type(command);
      phase = 'list';
      await window.waitForSelector(`.quick-input-list .monaco-list-row[aria-label*="${command}"]`, {
        timeout: 5_000,
      });
      if (attempt > 1) {
        console.warn(`[e2e] runCommand("${command}") succeeded on attempt ${attempt}`);
      }
      lastError = undefined;
      break;
    } catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message : String(error);
      console.warn(
        `[e2e] runCommand("${command}") attempt ${attempt} failed at phase=${phase}: ${message}`,
      );
      if (attempt === attempts) {
        throw new Error(
          `Command palette failed after ${attempts} attempts for "${command}" (last phase=${phase}): ${message}`,
        );
      }
    }
  }
  if (lastError) throw lastError;

  await window.keyboard.press('Enter');
  await window
    .waitForSelector('.quick-input-widget', {
      state: 'hidden',
      timeout: PANEL_OPEN_TIMEOUT_MS,
    })
    .catch(() => {
    });
}

async function getPanelHeight(window: Page): Promise<number> {
  return window.evaluate(() => {
    const panel =
      document.querySelector<HTMLElement>('[id="workbench.panel.bottom"]') ??
      document.querySelector<HTMLElement>('.part.panel');

    return Math.round(panel?.getBoundingClientRect().height ?? 0);
  });
}

async function ensurePanelIsLarge(window: Page): Promise<void> {
  if ((await getPanelHeight(window)) > MIN_PANEL_HEIGHT_PX) {
    return;
  }

  await runCommand(window, 'View: Toggle Maximized Panel');

  await expect
    .poll(() => getPanelHeight(window), {
      message: 'Expected the bottom panel to be resized for the Pixel Agents webview',
      timeout: PANEL_OPEN_TIMEOUT_MS,
      intervals: [250, 500, 1000],
    })
    .toBeGreaterThan(MIN_PANEL_HEIGHT_PX);
}

export async function closeBottomPanel(window: Page): Promise<void> {
  const statusBox = await window
    .locator('.part.statusbar')
    .boundingBox()
    .catch(() => null);
  if (statusBox) {
    await window.mouse.click(statusBox.x + statusBox.width / 2, statusBox.y + statusBox.height / 2);
  }
  await window.keyboard.press(process.platform === 'darwin' ? 'Meta+J' : 'Control+J');
  await expect
    .poll(
      async () => {
        for (const frame of window.frames()) {
          if (!frame.url().startsWith('vscode-webview://')) continue;
          try {
            if ((await frame.locator('button', { hasText: '+ Agent' }).count()) > 0) return true;
          } catch {
          }
        }
        return false;
      },
      {
        message: 'Expected the Pixel Agents webview to be disposed after closing the panel',
        timeout: 15_000,
      },
    )
    .toBe(false);
}

export async function reopenBottomPanel(window: Page): Promise<void> {
  const statusBox = await window
    .locator('.part.statusbar')
    .boundingBox()
    .catch(() => null);
  if (statusBox) {
    await window.mouse.click(statusBox.x + statusBox.width / 2, statusBox.y + statusBox.height / 2);
  }
  await window.keyboard.press(process.platform === 'darwin' ? 'Meta+J' : 'Control+J');
}

async function findPixelAgentsFrameOnce(window: Page): Promise<Frame | null> {
  for (const frame of window.frames()) {
    if (!frame.url().startsWith('vscode-webview://')) continue;
    try {
      const buttonCount = await frame.locator('button', { hasText: '+ Agent' }).count();
      if (buttonCount === 0) continue;
      const frameElement = await frame.frameElement();
      const box = await frameElement.boundingBox();
      await frameElement.dispose();
      if (!box || box.width < 10 || box.height < 10) continue;
      return frame;
    } catch {
      continue;
    }
  }
  return null;
}

export async function openPixelAgentsPanel(
  window: Page,
  opts: { autoShown?: boolean } = {},
): Promise<void> {
  let shown = (await findPixelAgentsFrameOnce(window)) !== null;
  if (!shown && opts.autoShown) {
    const deadline = Date.now() + PANEL_OPEN_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (await findPixelAgentsFrameOnce(window)) {
        shown = true;
        break;
      }
      await window.waitForTimeout(250);
    }
    if (!shown) {
      console.warn(
        '[e2e] autoShowPanel did not surface the webview in time; falling back to the command palette',
      );
    }
  }
  if (!shown) {
    await runCommand(window, 'Pixel Agents: Show Panel');
  }

  await window
    .waitForSelector('[id="workbench.panel.bottom"], .part.panel', {
      timeout: PANEL_OPEN_TIMEOUT_MS,
    })
    .catch(() => {
    });

  await ensurePanelIsLarge(window);
}

const PANEL_WIDTH_FRACTION = 2 / 3;
const PANEL_WIDTH_TOLERANCE_PX = 48;

interface PanelRect {
  x: number;
  y: number;
  width: number;
  height: number;
  winW: number;
}

async function getPanelRect(window: Page): Promise<PanelRect | null> {
  return window.evaluate(() => {
    const panel =
      document.querySelector<HTMLElement>('[id="workbench.parts.panel"]') ??
      document.querySelector<HTMLElement>('.part.panel');
    if (!panel) return null;
    const r = panel.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height, winW: globalThis.innerWidth };
  });
}

export async function arrangeReviewLayout(window: Page): Promise<void> {
  const isDarwin = process.platform === 'darwin';

  const isPartVisible = (selector: string): Promise<boolean> =>
    window.evaluate((sel) => {
      const el = document.querySelector<HTMLElement>(sel);
      return el !== null && el.offsetWidth > 0;
    }, selector);

  const hidePartIfVisible = async (selector: string, chord: string): Promise<boolean> => {
    if (!(await isPartVisible(selector))) return false;
    await window.keyboard.press(chord);
    await window.waitForTimeout(200);
    return true;
  };

  await window.evaluate(() => {
    const style = document.createElement('style');
    style.textContent = '.notifications-toasts { display: none !important; }';
    document.head.appendChild(style);
  });

  const dragPanelToTarget = async (): Promise<boolean> => {
    const rect = await getPanelRect(window);
    if (!rect) return true;
    const targetWidth = Math.round(rect.winW * PANEL_WIDTH_FRACTION);
    if (Math.abs(rect.width - targetWidth) <= PANEL_WIDTH_TOLERANCE_PX) return true;
    const y = rect.y + Math.min(200, rect.height / 2);
    for (const offset of [0, -2, 2, -4, 4]) {
      const start = await getPanelRect(window);
      if (!start) return true;
      await window.mouse.move(start.x + start.width + offset, y);
      await window.mouse.down();
      await window.mouse.move(start.x + targetWidth, y, { steps: 8 });
      await window.mouse.up();
      await window.waitForTimeout(150);
      const after = await getPanelRect(window);
      if (after && Math.abs(after.width - targetWidth) <= PANEL_WIDTH_TOLERANCE_PX) return true;
    }
    return false;
  };

  let arranged = false;
  for (let round = 0; round < 5; round++) {
    await window.waitForTimeout(round === 0 ? 400 : 250);
    let touched = false;
    const statusBox = await window
      .locator('.part.statusbar')
      .boundingBox()
      .catch(() => null);
    if (statusBox) {
      await window.mouse.click(
        statusBox.x + statusBox.width / 2,
        statusBox.y + statusBox.height / 2,
      );
    }
    if (await hidePartIfVisible('.part.sidebar', isDarwin ? 'Meta+B' : 'Control+B')) {
      touched = true;
    }
    if (await hidePartIfVisible('.part.auxiliarybar', isDarwin ? 'Alt+Meta+B' : 'Control+Alt+B')) {
      touched = true;
    }
    if (!(await dragPanelToTarget())) touched = true;
    if (!touched) {
      arranged = true;
      break;
    }
  }
  if (!arranged) {
    console.warn('[e2e] arrangeReviewLayout: layout did not settle after repair rounds');
  }
}

export async function getPixelAgentsFrame(window: Page): Promise<Frame> {
  let foundFrame: Frame | null = null;

  await expect
    .poll(
      async () => {
        foundFrame = await findPixelAgentsFrameOnce(window);
        return foundFrame !== null;
      },
      {
        message: 'Pixel Agents webview frame with "+ Agent" button not found',
        timeout: WEBVIEW_TIMEOUT_MS,
        intervals: [250, 500, 1000],
      },
    )
    .toBe(true);

  if (!foundFrame) {
    throw new Error('Internal error: poll succeeded but foundFrame is null');
  }
  return foundFrame;
}

export async function clickAddAgent(frame: Frame): Promise<void> {
  const btn = frame.locator('button', { hasText: '+ Agent' });
  await expect(btn).toBeVisible({ timeout: WEBVIEW_TIMEOUT_MS });
  await btn.click();
}

async function setCheckbox(modal: Locator, label: string, checked: boolean): Promise<void> {
  const button = modal.locator('button', { hasText: label });
  await expect(button).toBeVisible({ timeout: WEBVIEW_TIMEOUT_MS });

  const indicator = button.locator('span').last();
  const isChecked = ((await indicator.textContent()) ?? '').trim().toLowerCase() === 'x';
  if (isChecked !== checked) {
    await button.click();
  }
}

export async function openSettingsModal(frame: WebviewSurface): Promise<Locator> {
  const settingsButton = frame.locator('button', { hasText: 'Settings' });
  await expect(settingsButton).toBeVisible({ timeout: WEBVIEW_TIMEOUT_MS });
  await settingsButton.click();

  const settingsModal = frame
    .locator('div.fixed')
    .filter({ has: frame.getByText('Settings', { exact: true }) });
  await expect(settingsModal).toBeVisible({ timeout: WEBVIEW_TIMEOUT_MS });
  return settingsModal;
}

async function closeSettingsModal(settingsModal: Locator): Promise<void> {
  const closeButton = settingsModal.getByRole('button', { name: 'x', exact: true });
  await expect(closeButton).toBeVisible({ timeout: WEBVIEW_TIMEOUT_MS });
  await closeButton.click();
  await expect(settingsModal).toBeHidden({ timeout: WEBVIEW_TIMEOUT_MS });
}

export async function getSettingChecked(frame: WebviewSurface, label: string): Promise<boolean> {
  const settingsModal = await openSettingsModal(frame);
  const button = settingsModal.locator('button', { hasText: label });
  await expect(button).toBeVisible({ timeout: WEBVIEW_TIMEOUT_MS });
  const indicator = button.locator('span').last();
  const checked = ((await indicator.textContent()) ?? '').trim().toLowerCase() === 'x';
  await closeSettingsModal(settingsModal);
  return checked;
}

export async function setSettings(frame: WebviewSurface, settings: WebviewSettings): Promise<void> {
  const settingsModal = await openSettingsModal(frame);

  if (settings.watchAllSessions !== undefined) {
    await setCheckbox(settingsModal, 'Watch All Sessions', settings.watchAllSessions);
  }
  if (settings.hooksEnabled !== undefined) {
    await setCheckbox(settingsModal, 'Instant Detection (Hooks)', settings.hooksEnabled);
  }
  if (settings.alwaysShowLabels !== undefined) {
    await setCheckbox(settingsModal, 'Always Show Labels', settings.alwaysShowLabels);
  }
  if (settings.debugView !== undefined) {
    await setCheckbox(settingsModal, 'Debug View', settings.debugView);
  }

  await closeSettingsModal(settingsModal);

  await frame.waitForTimeout(500);
}

export async function configureHookServerTestSettings(frame: WebviewSurface): Promise<void> {
  await setSettings(frame, {
    watchAllSessions: true,
  });
}
