import { LAYOUT_EXPORT_FILENAME, LAYOUT_EXPORT_MIME } from '../../constants.js';
import type { OfficeLayout } from '../types.js';

export function exportLayoutToFile(layout: OfficeLayout): void {
  const json = JSON.stringify(layout, null, 2);
  const blob = new Blob([json], { type: LAYOUT_EXPORT_MIME });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = LAYOUT_EXPORT_FILENAME;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
