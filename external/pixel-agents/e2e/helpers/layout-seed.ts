
export const SEED_LAYOUT_REVISION = 9999;

const FLOOR_1 = 1;

export interface SeedAreaTile {
  col: number;
  row: number;
  label: string;
}

export interface SeedCarpetTile {
  col: number;
  row: number;
  variant: number;
}

export interface SeedLayoutOptions {
  cols?: number;
  rows?: number;
  floorTile?: number;
  areas?: Array<{ label: string; color: string }>;
  areaTiles?: SeedAreaTile[];
  carpetTiles?: SeedCarpetTile[];
}

export function buildSeedLayout(opts: SeedLayoutOptions = {}): Record<string, unknown> {
  const cols = opts.cols ?? 12;
  const rows = opts.rows ?? 12;
  const count = cols * rows;
  const tiles = new Array<number>(count).fill(opts.floorTile ?? FLOOR_1);

  const layout: Record<string, unknown> = {
    version: 1,
    cols,
    rows,
    tiles,
    furniture: [],
    layoutRevision: SEED_LAYOUT_REVISION,
  };

  if (opts.areas) {
    layout.areas = opts.areas;
  }
  if (opts.areaTiles) {
    const areaTiles = new Array<string | null>(count).fill(null);
    for (const t of opts.areaTiles) {
      areaTiles[t.row * cols + t.col] = t.label;
    }
    layout.areaTiles = areaTiles;
  }
  if (opts.carpetTiles) {
    const carpetTiles = new Array<{ variant: number } | null>(count).fill(null);
    for (const t of opts.carpetTiles) {
      carpetTiles[t.row * cols + t.col] = { variant: t.variant };
    }
    layout.carpetTiles = carpetTiles;
  }

  return layout;
}

const DEFAULT_ADAPTER_SETTINGS = {
  soundEnabled: true,
  lastSeenVersion: '',
  alwaysShowLabels: true,
  watchAllSessions: false,
  hooksEnabled: true,
  hooksInfoShown: false,
  showAreas: false,
  areaMappings: {} as Record<string, string[]>,
};

export interface SeedConfigOptions {
  areaMappings?: Record<string, string[]>;
  showAreas?: boolean;
}

export function buildSeedConfig(opts: SeedConfigOptions = {}): Record<string, unknown> {
  return {
    vscode: {
      ...DEFAULT_ADAPTER_SETTINGS,
      showAreas: opts.showAreas ?? false,
      areaMappings: opts.areaMappings ?? {},
    },
    standalone: { ...DEFAULT_ADAPTER_SETTINGS },
    externalAssetDirectories: [],
  };
}
