import {
  TRANSPORT_STATE_CONNECTED,
  TRANSPORT_STATE_CONNECTING,
  TRANSPORT_STATE_DISCONNECTED,
  TRANSPORT_STATE_RECONNECTING,
} from './constants.js';
import type { ClientMessage, ServerMessage } from './messages.js';

export type TransportState =
  | typeof TRANSPORT_STATE_CONNECTING
  | typeof TRANSPORT_STATE_CONNECTED
  | typeof TRANSPORT_STATE_RECONNECTING
  | typeof TRANSPORT_STATE_DISCONNECTED;

export interface MessageTransport {
  send(message: ClientMessage): void;
  onMessage(handler: (message: ServerMessage) => void): () => void;
  readonly ready: Promise<void>;
  readonly state: TransportState;
  onStateChange(handler: (state: TransportState) => void): () => void;
  dispose(): void;
}
