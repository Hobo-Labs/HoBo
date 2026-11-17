import path from 'path';

export function getExternalNarrationLogPath(tmpHome: string): string {
  return path.join(tmpHome, '.claude-mock', 'external-narration.log');
}
