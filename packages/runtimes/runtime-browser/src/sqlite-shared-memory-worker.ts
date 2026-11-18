import { detachOwner, dispatch } from "./worker-journal.js";
import type { WorkerMessage, WorkerRequest } from "./worker-rpc.js";

let pending = Promise.resolve();
let nextOwner = 0;
const leases = new Map<string, string>();

async function pruneOwners(): Promise<void> {
	for (const [owner, name] of leases) {
		const released = await navigator.locks.request(
			name,
			{ ifAvailable: true },
			(lock) => lock !== null,
		);
		if (released) {
			leases.delete(owner);
			detachOwner(owner);
		}
	}
}

globalThis.addEventListener("connect", (event: Event) => {
	if (!(event instanceof MessageEvent)) return;
	const port = event.ports[0];
	if (!port) return;
	const owner = String(++nextOwner);
	const send = (message: WorkerMessage) => port.postMessage(message);
	port.addEventListener("message", (received: MessageEvent<WorkerRequest>) => {
		pending = pending
			.then(async () => {
				await pruneOwners();
				const request = received.data;
				if (request.op === "open") {
					if (!request.input.lease) {
						send({
							id: request.id,
							ok: false,
							error: {
								name: "Error",
								message: "Transient owner lease is required",
							},
						});
						return;
					}
					leases.set(owner, request.input.lease);
				}
				await dispatch(request, owner, true, send);
				if (request.op === "close") leases.delete(owner);
			})
			.catch((error) => {
				send({
					id: received.data.id,
					ok: false,
					error: {
						name: error instanceof Error ? error.name : "Error",
						message: error instanceof Error ? error.message : String(error),
					},
				});
			});
	});
	port.addEventListener("close", () => {
		pending = pending.then(() => {
			leases.delete(owner);
			detachOwner(owner);
		});
	});
	port.start();
});
