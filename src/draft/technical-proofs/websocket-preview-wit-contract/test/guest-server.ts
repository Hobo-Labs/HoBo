import type {
  AcceptRequest,
  AcceptResponse
} from "../generated/wasi-websocket/guest/interfaces/wasi-websocket-incoming-handler.js";
import type { Message } from "../generated/wasi-websocket/guest/interfaces/wasi-websocket-types.js";
import type {
  ConnId,
  PrincipalRef
} from "../generated/hobo-websocket/guest/interfaces/hobo-websocket-extension.js";

export function handle(request: AcceptRequest): AcceptResponse {
  throw new Error(`test stub only: ${request.path}`);
}

export function sendTo(conn: ConnId, principal: PrincipalRef | undefined, message: Message): void {
  void conn;
  void principal;
  void message;
}
