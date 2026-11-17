import fs from 'fs';
import path from 'path';

import type { Page } from '@playwright/test';

import { getExternalNarrationLogPath } from './external-monitor';


const YELLOW = '\u001b[33m';
const GREEN = '\u001b[32m';
const DIM = '\u001b[2m';
const RESET = '\u001b[0m';
const NARRATION_COMPLETE = '[test] ■ narration complete';

export interface TestNarrator {
  step(message: string): void;
  check(message: string): void;
}

let context: { logPath: string; startedAt: number } | null = null;

export function getTestNarrationLogPath(tmpHome: string): string {
  return path.join(tmpHome, '.claude-mock', 'test-narration.log');
}

function write(line: string): void {
  if (!context) return;
  try {
    fs.appendFileSync(context.logPath, line);
  } catch {
  }
}

function stamp(): string {
  if (!context) return '';
  return `${DIM}[+${((Date.now() - context.startedAt) / 1000).toFixed(1)}s]${RESET}`;
}

export const narrate: TestNarrator = {
  step: (message) => write(`${stamp()} ${YELLOW}[test]${RESET} ▸ ${message}\n`),
  check: (message) => write(`${stamp()} ${YELLOW}[test]${RESET} ${GREEN}✓${RESET} ${message}\n`),
};

export function setNarrationContext(tmpHome: string): TestNarrator {
  const logPath = getTestNarrationLogPath(tmpHome);
  try {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    if (!fs.existsSync(logPath)) fs.writeFileSync(logPath, '');
  } catch {
  }
  context = { logPath, startedAt: Date.now() };
  return narrate;
}

export function clearNarrationContext(): void {
  context = null;
}

export async function finishNarration(window: Page): Promise<void> {
  if (!context) return;

  try {
    const visibleRows = window.locator('.xterm:visible .xterm-rows');
    if ((await visibleRows.count()) === 0) return;

    write(`${stamp()} ${DIM}${NARRATION_COMPLETE}${RESET}\n`);
    await visibleRows
      .filter({ hasText: NARRATION_COMPLETE })
      .last()
      .waitFor({ state: 'visible', timeout: 1_500 });

    await window.evaluate(
      () =>
        new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    );
  } catch (error) {
    console.warn(
      `[e2e] final narration did not render before cleanup (cosmetic, continuing): ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

export async function openMonitorTerminal(window: Page, tmpHome: string): Promise<void> {
  try {
    const testLog = getTestNarrationLogPath(tmpHome);
    const externalLog = getExternalNarrationLogPath(tmpHome);
    fs.mkdirSync(path.dirname(testLog), { recursive: true });
    if (!fs.existsSync(testLog)) fs.writeFileSync(testLog, '');
    if (!fs.existsSync(externalLog)) fs.writeFileSync(externalLog, '');

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
    const terminalRows = window.locator('.xterm:visible .xterm-rows').last();
    await window.keyboard.press('F8');
    await terminalRows.waitFor({ state: 'visible', timeout: 5_000 });
    await terminalRows.filter({ hasText: /\S/ }).waitFor({ state: 'visible', timeout: 5_000 });

    const tailScript = path.join(__dirname, '..', 'fixtures', 'tail-follow.cjs');
    const invoke = `"${process.execPath}" "${tailScript}" monitor "${testLog}" "${externalLog}"`;
    const terminalInput = window.locator('.xterm:visible textarea.xterm-helper-textarea').last();
    await terminalInput.focus();
    await window.keyboard.insertText(process.platform === 'win32' ? `& ${invoke}` : invoke);
    await window.keyboard.press('Enter');
  } catch (error) {
    console.warn(
      `[e2e] monitor terminal failed to open (cosmetic, continuing): ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}
