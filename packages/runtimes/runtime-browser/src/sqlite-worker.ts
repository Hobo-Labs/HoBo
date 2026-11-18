import { dispatch } from "./worker-journal.js";
import type { WorkerMessage, WorkerRequest } from "./worker-rpc.js";

let pending = Promise.resolve();
const send = (message: WorkerMessage) => postMessage(message, { transfer: [] });
globalThis.addEventListener("message", (event: MessageEvent<WorkerRequest>) => {
	pending = pending.then(() => dispatch(event.data, "dedicated", false, send));
});
