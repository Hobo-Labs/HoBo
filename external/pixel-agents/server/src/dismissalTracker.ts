import { DISMISSED_COOLDOWN_MS } from './constants.js';
import { toPathKey } from './pathKey.js';

export class DismissalTracker {
  private dismissed = new Map<string, number>();

  private permanent = new Set<string>();

  private seeded = new Map<string, number>();

  private pending = new Map<string, number>();


  dismiss(path: string, timestamp = Date.now()): void {
    this.dismissed.set(toPathKey(path), timestamp);
  }

  clearDismissal(path: string): void {
    this.dismissed.delete(toPathKey(path));
  }

  isDismissed(path: string): boolean {
    const key = toPathKey(path);
    const timestamp = this.dismissed.get(key);
    if (timestamp === undefined) return false;
    if (Date.now() - timestamp < DISMISSED_COOLDOWN_MS) return true;
    this.dismissed.delete(key);
    return false;
  }


  permanentlyDismiss(path: string): void {
    this.permanent.add(toPathKey(path));
  }

  isPermanentlyDismissed(path: string): boolean {
    return this.permanent.has(toPathKey(path));
  }


  seedMtime(path: string, mtime: number): void {
    this.seeded.set(toPathKey(path), mtime);
  }

  getSeededMtime(path: string): number | undefined {
    return this.seeded.get(toPathKey(path));
  }

  clearSeededMtime(path: string): void {
    this.seeded.delete(toPathKey(path));
  }

  hasSeededMtime(path: string): boolean {
    return this.seeded.has(toPathKey(path));
  }


  registerPendingClear(path: string, timestamp = Date.now()): void {
    this.pending.set(toPathKey(path), timestamp);
  }

  hasPendingClear(path: string): boolean {
    return this.pending.has(toPathKey(path));
  }

  clearPendingClear(path: string): void {
    this.pending.delete(toPathKey(path));
  }


  resetAll(): void {
    this.dismissed.clear();
    this.permanent.clear();
    this.seeded.clear();
    this.pending.clear();
  }
}
