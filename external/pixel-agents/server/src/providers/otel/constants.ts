
export const OTEL_ATTR_CAMP = 'hobo.camp';
export const OTEL_ATTR_BINDLE = 'hobo.bindle';
export const OTEL_ATTR_SERVICE_NAME = 'service.name';

export const OTEL_READING_ATTR_PREFIXES = ['db.', 'messaging.'];

export const OTEL_SPAN_KIND = {
  INTERNAL: 1,
  SERVER: 2,
  CLIENT: 3,
  PRODUCER: 4,
  CONSUMER: 5,
} as const;

export const OTEL_STATUS_CODE_ERROR = 2;

export const TILE_WALL = 0;
export const TILE_FLOOR_1 = 1;
export const TILE_VOID = 255;
export const MAX_COLS = 64;
export const MAX_ROWS = 64;

export const WORKSTATION_CELL_W = 4;
export const WORKSTATION_CELL_H = 5;

export const GRID_GROW_ROWS = WORKSTATION_CELL_H + 1;
export const GRID_GROW_COLS = WORKSTATION_CELL_W + 1;

export const GROWN_TILE_COLOR = { h: 35, s: 30, b: 15, c: 0 };
