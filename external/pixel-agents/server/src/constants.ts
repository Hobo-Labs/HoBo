export const JSONL_POLL_INTERVAL_MS = 1000;
export const FILE_WATCHER_POLL_INTERVAL_MS = 500;
export const PROJECT_SCAN_INTERVAL_MS = 1000;

export const TOOL_DONE_DELAY_MS = 300;
export const PERMISSION_TIMER_DELAY_MS = 7000;
export const TEXT_IDLE_DELAY_MS = 5000;
export const CLEAR_IDLE_THRESHOLD_MS = 2000;

export const EXTERNAL_SCAN_INTERVAL_MS = 3000;
export const EXTERNAL_ACTIVE_THRESHOLD_MS = 120_000;
export const EXTERNAL_STALE_CHECK_INTERVAL_MS = 30_000;
export const DISMISSED_COOLDOWN_MS = 180_000;

export const GLOBAL_SCAN_ACTIVE_MIN_SIZE = 3_072;
export const GLOBAL_SCAN_ACTIVE_MAX_AGE_MS = 600_000;

export {
  BASH_COMMAND_DISPLAY_MAX_LENGTH,
  HOOK_API_PREFIX,
  HOOK_SCRIPTS_DIR,
  SERVER_JSON_DIR,
  SERVER_JSON_NAME,
  TASK_DESCRIPTION_DISPLAY_MAX_LENGTH,
} from '../../core/src/constants.js';

export const SERVERS_DIR = 'servers';
export const MIN_PORT = 1;
export const MAX_PORT = 65_535;
export const SERVER_REGISTRY_PROTOCOL_VERSION = 1;

export const HOOK_EVENT_BUFFER_MS = 5_000;
export const SESSION_END_GRACE_MS = 2000;
export const MAX_HOOK_BODY_SIZE = 65_536;

export const LAYOUT_FILE_DIR = '.pixel-agents';
export const LAYOUT_FILE_NAME = 'layout.json';
export const LAYOUT_FILE_POLL_INTERVAL_MS = 2000;
export const LAYOUT_REVISION_KEY = 'layoutRevision';
export const CONFIG_FILE_NAME = 'config.json';
