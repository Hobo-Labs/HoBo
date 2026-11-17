
export const CLAUDE_HOOK_SCRIPT_NAME = 'claude-hook.js';

export const CLAUDE_HOOK_EVENTS = [
  'SessionStart',
  'SessionEnd',
  'Stop',
  'PermissionRequest',
  'Notification',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'SubagentStart',
  'SubagentStop',
  'TeammateIdle',
  'TaskCreated',
  'TaskCompleted',
] as const;

export const CLAUDE_TERMINAL_NAME_PREFIX = 'Claude Code';
