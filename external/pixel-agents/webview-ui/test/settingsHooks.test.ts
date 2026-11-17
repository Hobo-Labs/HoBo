import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/transport/index.js', () => ({ transport: { send: vi.fn() } }));

import { SettingsModal } from '../src/components/SettingsModal.js';

describe('hook settings', () => {
  it('shows the hook toggle only when the server supports hooks', () => {
    const props = {
      isOpen: true,
      onClose: () => {},
      isDebugMode: false,
      onToggleDebugMode: () => {},
      alwaysShowOverlay: false,
      onToggleAlwaysShowOverlay: () => {},
      externalAssetDirectories: [],
      watchAllSessions: false,
      onToggleWatchAllSessions: () => {},
      hooksEnabled: false,
      onToggleHooksEnabled: () => {},
      showAreas: false,
      onToggleShowAreas: () => {},
      showAreasAvailable: false,
      onExportLayout: () => {},
      onImportLayout: () => {},
    };
    expect(
      renderToStaticMarkup(createElement(SettingsModal, { ...props, hooksAvailable: false })),
    ).not.toContain('Instant Detection (Hooks)');
    expect(
      renderToStaticMarkup(createElement(SettingsModal, { ...props, hooksAvailable: true })),
    ).toContain('Instant Detection (Hooks)');
  });
});
