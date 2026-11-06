import { type SignedRequest, SignedRequestSchema } from "./protocol.mts";
/** Retries mailbox publication using the identical cached sealed response only. */
export function createRequestPump({
	contents,
	controller,
}: {
	contents: {
		listRequests(): Promise<string[]>;
		get(category: string, id?: string): Promise<string | undefined>;
		publish(
			category: string,
			id: string | undefined,
			text: string,
		): Promise<void>;
	};
	controller: {
		handle(envelope: SignedRequest): Promise<object>;
	};
}) {
	const done = new Set<string>(),
		ignored = new Set<string>(),
		pending = new Map<string, string>();
	async function step() {
		for (const [id, text] of pending) {
			try {
				await contents.publish("response", id, text);
				pending.delete(id);
				done.add(id);
			} catch {}
		}
		const ids = await contents.listRequests();
		for (const id of ids) {
			if (done.has(id) || ignored.has(id) || pending.has(id)) continue;
			let value: string | undefined;
			try {
				value = await contents.get("request", id);
			} catch {
				continue;
			}
			if (value === undefined) continue;
			let envelope: SignedRequest;
			try {
				envelope = SignedRequestSchema.parse(JSON.parse(value));
				if (envelope.request.id !== id)
					throw new Error("request identity mismatch");
			} catch {
				ignored.add(id);
				continue;
			}
			let sealed: object;
			try {
				sealed = await controller.handle(envelope);
			} catch {
				continue;
			}
			const text = JSON.stringify(sealed);
			pending.set(id, text);
			try {
				await contents.publish("response", id, text);
				pending.delete(id);
				done.add(id);
			} catch {}
		}
	}
	return { step, pendingCount: () => pending.size };
}
