import { HOOK_EVENT_BUFFER_MS } from './constants.js';

export interface PendingExternalSession {
  sessionId: string;
  transcriptPath: string | undefined;
  cwd: string;
}

export interface BufferedEvent {
  providerId: string;
  event: { session_id: string; [key: string]: unknown };
  timestamp: number;
}

export class SessionRouter {
  private sessionToAgentId = new Map<string, number>();
  private pendingSessions = new Map<string, PendingExternalSession>();
  private buffer: BufferedEvent[] = [];
  private bufferTimer: ReturnType<typeof setInterval> | null = null;


  register(sessionId: string, agentId: number): BufferedEvent[] {
    this.sessionToAgentId.set(sessionId, agentId);
    return this.flushBuffered(sessionId);
  }

  unregister(sessionId: string): void {
    this.sessionToAgentId.delete(sessionId);
  }

  resolve(sessionId: string): number | undefined {
    return this.sessionToAgentId.get(sessionId);
  }

  hasSession(sessionId: string): boolean {
    return this.sessionToAgentId.has(sessionId);
  }


  storePending(sessionId: string, info: PendingExternalSession): void {
    this.pendingSessions.set(sessionId, info);
  }

  confirmPending(sessionId: string): PendingExternalSession | undefined {
    const info = this.pendingSessions.get(sessionId);
    if (info) this.pendingSessions.delete(sessionId);
    return info;
  }

  hasPending(sessionId: string): boolean {
    return this.pendingSessions.has(sessionId);
  }

  discardPending(sessionId: string): void {
    this.pendingSessions.delete(sessionId);
  }


  bufferEvent(providerId: string, event: { session_id: string; [key: string]: unknown }): void {
    this.buffer.push({ providerId, event, timestamp: Date.now() });
    if (!this.bufferTimer) {
      this.bufferTimer = setInterval(() => {
        this.pruneExpired();
      }, HOOK_EVENT_BUFFER_MS);
    }
  }

  hasBuffered(sessionId: string): boolean {
    return this.buffer.some((b) => b.event.session_id === sessionId);
  }

  pruneExpired(): void {
    const cutoff = Date.now() - HOOK_EVENT_BUFFER_MS;
    this.buffer = this.buffer.filter((b) => b.timestamp > cutoff);
    this.cleanupBufferTimer();
  }


  dispose(): void {
    if (this.bufferTimer) {
      clearInterval(this.bufferTimer);
      this.bufferTimer = null;
    }
    this.sessionToAgentId.clear();
    this.buffer = [];
    this.pendingSessions.clear();
  }


  private flushBuffered(sessionId: string): BufferedEvent[] {
    const toFlush = this.buffer.filter((b) => b.event.session_id === sessionId);
    this.buffer = this.buffer.filter((b) => b.event.session_id !== sessionId);
    this.cleanupBufferTimer();
    return toFlush;
  }

  private cleanupBufferTimer(): void {
    if (this.buffer.length === 0 && this.bufferTimer) {
      clearInterval(this.bufferTimer);
      this.bufferTimer = null;
    }
  }
}
