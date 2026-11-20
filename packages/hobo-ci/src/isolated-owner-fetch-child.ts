import { isolatedOwnerEgressFetch } from "./egress.js";
import {
	authenticatedOwnerRun,
	OWNER_BODY_LIMIT,
	OWNER_MESSAGE_LIMIT,
	ownerRequest,
	ownerRun,
} from "./isolated-owner-wire.js";
import { parseProxyUrl } from "./parsed-values.js";

async function respond(value: string): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		process.stdout.once("error", reject);
		process.stdout.write(value, (error) => {
			if (error) reject(error);
			else resolve();
		});
	});
}

async function run(): Promise<void> {
	const authorizedRun = ownerRun.parse({
		id: process.env.HOBO_OWNER_RUN_ID,
		secret: process.env.HOBO_OWNER_RUN_SECRET,
	});
	const pieces: Buffer[] = [];
	let length = 0;
	for await (const piece of process.stdin) {
		const bytes = Buffer.isBuffer(piece) ? piece : Buffer.from(piece);
		length += bytes.length;
		if (length > OWNER_MESSAGE_LIMIT) throw new Error("Request too large.");
		pieces.push(bytes);
	}
	const parsed = ownerRequest.parse(
		JSON.parse(Buffer.concat(pieces).toString("utf8")),
	);
	if (!authenticatedOwnerRun(parsed, authorizedRun))
		throw new Error("Private owner run authentication failed.");
	const route = {
		proxy: parsed.egress?.proxy
			? parseProxyUrl("HTTPS_PROXY", parsed.egress.proxy)
			: undefined,
		noProxy: parsed.egress?.noProxy,
		caFile: parsed.egress?.caFile,
	};
	const response = await isolatedOwnerEgressFetch(
		route,
		new URL(parsed.url).origin,
	)(parsed.url, {
		method: parsed.method,
		headers: parsed.headers,
		redirect: parsed.redirect,
		cache: parsed.cache,
		credentials: parsed.credentials,
		integrity: parsed.integrity,
		keepalive: parsed.keepalive,
		mode: parsed.mode,
		referrer: parsed.referrer,
		referrerPolicy: parsed.referrerPolicy,
		...(parsed.body !== null
			? { body: new Uint8Array(Buffer.from(parsed.body, "base64")) }
			: undefined),
	});
	const reader = response.body?.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	if (reader) {
		for (;;) {
			const part = await reader.read();
			if (part.done) break;
			size += part.value.byteLength;
			if (size > OWNER_BODY_LIMIT) {
				await reader.cancel();
				throw new Error("Response too large.");
			}
			chunks.push(part.value);
		}
	}
	const body = Buffer.concat(chunks).toString("base64");
	await respond(
		JSON.stringify({
			ok: true,
			runId: parsed.run.id,
			url: response.url,
			redirected: response.redirected,
			type: response.type,
			status: response.status,
			statusText: response.statusText,
			headers: [...response.headers.entries()],
			body,
		}),
	);
}

run().catch(async () => {
	try {
		await respond('{"ok":false}');
	} catch {}
	process.exitCode = 1;
});
