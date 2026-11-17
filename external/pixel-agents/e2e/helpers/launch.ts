import type { ElectronApplication, Page } from '@playwright/test';
import { _electron as electron } from '@playwright/test';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { namespaceE2EPath } from '../run-config';
import { applyMockHomeEnv } from './mock-claude';

const REPO_ROOT = path.join(__dirname, '../..');
const VSCODE_PATH_FILE = path.join(REPO_ROOT, '.vscode-test/vscode-executable.txt');
const MOCK_CLAUDE_PATH = path.join(REPO_ROOT, 'e2e/fixtures/mock-claude');
const MOCK_CLAUDE_CMD_PATH = path.join(REPO_ROOT, 'e2e/fixtures/mock-claude.cmd');
const MOCK_CLAUDE_RUNNER_PATH = path.join(REPO_ROOT, 'e2e/fixtures/mock-claude-runner.cjs');
const TAIL_FOLLOW_PATH = path.join(REPO_ROOT, 'e2e/fixtures/tail-follow.cjs');
const ARTIFACTS_DIR = namespaceE2EPath(path.join(REPO_ROOT, 'test-results/e2e'));
const IS_WINDOWS = process.platform === 'win32';
const PATH_SEP = IS_WINDOWS ? ';' : ':';

export interface VSCodeSession {
  app: ElectronApplication;
  window: Page;
  tmpHome: string;
  workspaceDir: string;
  mockLogFile: string;
  videoDir?: string;
  cleanup: () => Promise<void>;
}

export interface LaunchOptions {
  workspaceFolders?: string[];
  seedConfig?: unknown;
  seedLayout?: unknown;
}

export async function launchVSCode(
  testTitle: string,
  opts: LaunchOptions = {},
): Promise<VSCodeSession> {
  const vscodePath = fs.readFileSync(VSCODE_PATH_FILE, 'utf8').trim();

  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'pixel-e2e-'));
  const tmpHome = path.join(tmpBase, 'home');
  const workspaceDir = path.join(tmpBase, 'workspace');
  const userDataDir = path.join(tmpBase, 'userdata');
  const mockBinDir = path.join(tmpBase, 'bin');

  fs.mkdirSync(tmpHome, { recursive: true });
  fs.mkdirSync(workspaceDir, { recursive: true });
  fs.mkdirSync(userDataDir, { recursive: true });
  fs.mkdirSync(mockBinDir, { recursive: true });

  const paDir = path.join(tmpHome, '.pixel-agents');
  fs.mkdirSync(paDir, { recursive: true });
  const seedConfig = opts.seedConfig ?? {
    vscode: { alwaysShowLabels: true },
    standalone: { alwaysShowLabels: true },
  };
  fs.writeFileSync(path.join(paDir, 'config.json'), JSON.stringify(seedConfig, null, 2));
  if (opts.seedLayout !== undefined) {
    fs.writeFileSync(path.join(paDir, 'layout.json'), JSON.stringify(opts.seedLayout, null, 2));
  }

  const claudeWorkspaceSettingsDir = path.join(workspaceDir, '.claude');
  fs.mkdirSync(claudeWorkspaceSettingsDir, { recursive: true });
  fs.writeFileSync(
    path.join(claudeWorkspaceSettingsDir, 'settings.local.json'),
    JSON.stringify(
      {
        env: {
          CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
        },
      },
      null,
      2,
    ),
  );

  const resolvedWorkspaceDir =
    IS_WINDOWS || process.platform === 'darwin'
      ? fs.realpathSync.native(workspaceDir)
      : workspaceDir;

  const multiRootFolders = opts.workspaceFolders ?? [];
  let openTarget = resolvedWorkspaceDir;
  if (multiRootFolders.length > 1) {
    const folderEntries = multiRootFolders.map((name) => {
      const folderDir = path.join(workspaceDir, name);
      fs.mkdirSync(folderDir, { recursive: true });
      const resolved =
        IS_WINDOWS || process.platform === 'darwin' ? fs.realpathSync.native(folderDir) : folderDir;
      return { path: resolved };
    });
    const workspaceFile = path.join(tmpBase, 'pa.code-workspace');
    fs.writeFileSync(workspaceFile, JSON.stringify({ folders: folderEntries }, null, 2));
    openTarget =
      IS_WINDOWS || process.platform === 'darwin'
        ? fs.realpathSync.native(workspaceFile)
        : workspaceFile;
  }

  if (process.platform === 'darwin') {
    const keychainDir = path.join(tmpHome, 'Library', 'Keychains');
    fs.mkdirSync(keychainDir, { recursive: true });
    const keychainPath = path.join(keychainDir, 'login.keychain-db');
    try {
      const { execSync } = require('child_process');
      execSync(`security create-keychain -p "" "${keychainPath}"`, { stdio: 'ignore' });
      execSync(`security default-keychain -s "${keychainPath}"`, {
        stdio: 'ignore',
        env: { ...process.env, HOME: tmpHome },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[e2e] Keychain creation failed for ${keychainPath}: ${message}`);
      try {
        const launchLog = path.join(tmpHome, '.claude-mock', 'launch.log');
        fs.mkdirSync(path.dirname(launchLog), { recursive: true });
        fs.appendFileSync(launchLog, `${new Date().toISOString()} keychain-error: ${message}\n`);
      } catch {
      }
    }
  }

  const mockClaudeBinaryPath = path.join(mockBinDir, IS_WINDOWS ? 'claude.cmd' : 'claude');
  if (IS_WINDOWS) {
    fs.copyFileSync(MOCK_CLAUDE_CMD_PATH, mockClaudeBinaryPath);
    fs.copyFileSync(MOCK_CLAUDE_RUNNER_PATH, path.join(mockBinDir, 'mock-claude-runner.cjs'));
    fs.copyFileSync(TAIL_FOLLOW_PATH, path.join(mockBinDir, 'tail-follow.cjs'));
  } else {
    fs.copyFileSync(MOCK_CLAUDE_PATH, mockClaudeBinaryPath);
    fs.chmodSync(mockClaudeBinaryPath, 0o755);
    fs.copyFileSync(MOCK_CLAUDE_RUNNER_PATH, path.join(mockBinDir, 'mock-claude-runner.cjs'));
    fs.copyFileSync(TAIL_FOLLOW_PATH, path.join(mockBinDir, 'tail-follow.cjs'));
  }

  const userSettingsDir = path.join(userDataDir, 'User');
  fs.mkdirSync(userSettingsDir, { recursive: true });
  const userSettings: Record<string, unknown> = {
    'workbench.panel.defaultLocation': 'left',
    'pixel-agents.autoShowPanel': true,
    'terminal.integrated.defaultLocation': 'editor',
    'workbench.activityBar.location': 'hidden',
    'workbench.startupEditor': 'none',
    'workbench.editor.empty.hint': 'hidden',
    'workbench.secondarySideBar.defaultVisibility': 'hidden',
    'chat.commandCenter.enabled': false,
  };
  if (process.platform === 'darwin') {
    userSettings['terminal.integrated.profiles.osx'] = {
      e2e: {
        path: '/bin/zsh',
        args: ['--no-globalrcs'],
        env: {
          PATH: `${mockBinDir}:/usr/local/bin:/usr/bin:/bin`,
          HOME: tmpHome,
          PIXEL_AGENTS_E2E_CLAUDE_BIN: mockClaudeBinaryPath,
          PIXEL_AGENTS_NODE_BIN: process.execPath,
          ZDOTDIR: tmpHome,
          CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
          PIXEL_AGENTS_DEBUG_LOG: path.join(tmpHome, '.pixel-agents', 'debug.log'),
          PIXEL_AGENTS_TEST_NARRATION_LOG: path.join(tmpHome, '.claude-mock', 'test-narration.log'),
          PIXEL_AGENTS_EXTERNAL_NARRATION_LOG: path.join(
            tmpHome,
            '.claude-mock',
            'external-narration.log',
          ),
        },
      },
    };
    userSettings['terminal.integrated.defaultProfile.osx'] = 'e2e';
    userSettings['terminal.integrated.inheritEnv'] = false;
  }
  fs.writeFileSync(
    path.join(userSettingsDir, 'settings.json'),
    JSON.stringify(userSettings, null, 2),
  );
  fs.writeFileSync(
    path.join(userSettingsDir, 'keybindings.json'),
    JSON.stringify(
      [{ key: 'f8', command: 'workbench.action.terminal.newInActiveWorkspace' }],
      null,
      2,
    ),
  );

  const mockLogFile = path.join(tmpHome, '.claude-mock', 'invocations.log');
  const launchLogFile = path.join(tmpHome, '.claude-mock', 'launch.log');

  const safeTitle = testTitle.replace(/[^a-z0-9]+/gi, '-').toLowerCase();
  const videoDir = IS_WINDOWS ? undefined : path.join(ARTIFACTS_DIR, 'videos', safeTitle);
  if (videoDir) {
    fs.mkdirSync(videoDir, { recursive: true });
  }

  const debugLogFile = path.join(tmpHome, '.pixel-agents', 'debug.log');
  fs.mkdirSync(path.dirname(debugLogFile), { recursive: true });

  const env: Record<string, string> = {
    ...(applyMockHomeEnv(process.env, tmpHome) as Record<string, string>),
    PATH: `${mockBinDir}${PATH_SEP}${process.env['PATH'] ?? '/usr/local/bin:/usr/bin:/bin'}`,
    PIXEL_AGENTS_E2E_CLAUDE_BIN: mockClaudeBinaryPath,
    PIXEL_AGENTS_E2E_LAUNCH_LOG: launchLogFile,
    PIXEL_AGENTS_NODE_BIN: process.execPath,
    PIXEL_AGENTS_DEBUG_LOG: debugLogFile,
    PIXEL_AGENTS_TEST_NARRATION_LOG: path.join(tmpHome, '.claude-mock', 'test-narration.log'),
    PIXEL_AGENTS_EXTERNAL_NARRATION_LOG: path.join(
      tmpHome,
      '.claude-mock',
      'external-narration.log',
    ),
    VSCODE_TELEMETRY_DISABLED: '1',
    CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
  };

  const args = [
    `--extensionDevelopmentPath=${REPO_ROOT}`,
    '--disable-extensions',
    `--user-data-dir=${userDataDir}`,
    '--disable-workspace-trust',
    '--skip-release-notes',
    '--skip-welcome',
    '--no-sandbox',
    '--disable-updates',
    '--disable-gpu',
    ...(process.platform === 'linux' ? ['--ozone-platform=headless'] : []),
    openTarget,
  ];

  const cleanup = async (): Promise<void> => {
    try {
      if (app) {
        await app.close();
      }
    } catch {
    }
    if (process.platform === 'darwin') {
      try {
        const keychainPath = path.join(tmpHome, 'Library', 'Keychains', 'login.keychain-db');
        const { execSync } = require('child_process');
        execSync(`security delete-keychain "${keychainPath}"`, { stdio: 'ignore' });
      } catch {
      }
    }
    try {
      fs.rmSync(tmpBase, { recursive: true, force: true });
    } catch {
    }
  };

  let app: ElectronApplication | undefined;

  try {
    const launchOptions: Parameters<typeof electron.launch>[0] = {
      executablePath: vscodePath,
      args,
      env,
      cwd: resolvedWorkspaceDir,
      timeout: 60_000,
    };
    if (!IS_WINDOWS && process.env['PIXEL_AGENTS_E2E_NO_VIDEO'] !== '1') {
      launchOptions.recordVideo = {
        dir: videoDir!,
        size: { width: 1280, height: 800 },
      };
    }

    app = await electron.launch(launchOptions);

    const window = await app.firstWindow();

    await window.addInitScript(() => {
      (window as unknown as { __PIXEL_AGENTS_E2E?: boolean }).__PIXEL_AGENTS_E2E = true;
    });

    if (process.platform === 'linux') {
      await app.evaluate(({ BrowserWindow }) => {
        BrowserWindow.getAllWindows()[0]?.setSize(1280, 800);
      });
      await window.waitForTimeout(500);
    }

    return {
      app,
      window,
      tmpHome,
      workspaceDir: resolvedWorkspaceDir,
      mockLogFile,
      videoDir,
      cleanup,
    };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

export async function waitForWorkbench(window: Page): Promise<void> {
  await window.waitForSelector('.monaco-workbench', { timeout: 60_000 });
}
