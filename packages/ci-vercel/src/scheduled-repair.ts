import { createHash, timingSafeEqual } from "node:crypto";

/** Cron only wakes the private queue; the consumer performs and records repair. */
export function createScheduledRepairHandler(options: {
	secret: string;
	enqueue(): Promise<void>;
}): (request: Request) => Promise<Response> {
	if (Buffer.byteLength(options.secret, "utf8") < 32)
		throw new Error("cron secret too short");
	const expected = createHash("sha256")
		.update(`Bearer ${options.secret}`)
		.digest();
	return async (request) => {
		const actual = createHash("sha256")
			.update(request.headers.get("authorization") ?? "")
			.digest();
		if (request.method !== "GET" || !timingSafeEqual(actual, expected))
			return new Response(null, { status: 403 });
		try {
			await options.enqueue();
			return new Response(null, { status: 204 });
		} catch {
			return new Response(null, { status: 503 });
		}
	};
}
