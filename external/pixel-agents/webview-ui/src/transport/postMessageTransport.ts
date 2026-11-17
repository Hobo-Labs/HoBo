import { TRANSPORT_STATE_CONNECTED } from '../../../core/src/constants.js';
import type { ClientMessage, ServerMessage } from '../../../core/src/messages.js';
import type { MessageTransport, TransportState } from './types.js';

declare function acquireVsCodeApi(): { postMessage(msg: unknown): void };

export class PostMessageTransport implements MessageTransport {
  private readonly vscodeApi: { postMessage(msg: unknown): void };
  readonly state: TransportState = TRANSPORT_STATE_CONNECTED;
  readonly ready: Promise<void> = Promise.resolve();

  constructor() {
    this.vscodeApi = acquireVsCodeApi();
  }

  send(message: ClientMessage): void {
    this.vscodeApi.postMessage(message);
  }

  onMessage(handler: (message: ServerMessage) => void): () => void {
    const listener = (e: MessageEvent) => handler(e.data as ServerMessage);
    window.addEventListener('message', listener);
    return () => window.removeEventListener('message', listener);
  }

  onStateChange(): () => void {
    return () => {};
  }

  dispose(): void {
  }
}
