import { z } from "zod";
import { createConditionalGithubFetch } from "./conditional-fetch.mts";
import { REPOSITORY } from "./protocol.mts";

const MAX_CONTENT_BYTES = 8 * 1024 * 1024;
const BRANCH = /^ops\/ci-runner-mailbox-5636332-[a-f0-9]{8}$/;
const ID = /^[0-9a-f]{32}$/;
const fileEntry = z.object({
	type: z.literal("file"),
	path: z.string(),
	encoding: z.literal("base64"),
	content: z.string(),
	size: z.number().int().min(0).max(MAX_CONTENT_BYTES),
});
const requestEntries = z
	.array(
		z.object({
			type: z.literal("file"),
			name: z.string().regex(/^([0-9a-f]{32})\.json$/),
			path: z.string(),
		}),
	)
	.max(999);
function encodePath(path: string): string {
	return path.split("/").map(encodeURIComponent).join("/");
}
function pathFor(runId: number, category: string, id?: string): string {
	if (!Number.isSafeInteger(runId) || runId <= 0)
		throw new Error("invalid mailbox identity");
	const root = `controllers/${runId}`;
	if (category === "sealed-key") return `${root}/sealed-key.json`;
	if (category === "metadata") return `${root}/controller-metadata.json`;
	if (category === "request" || category === "response") {
		const messageId = z.string().regex(ID).parse(id);
		return `${root}/${category === "request" ? "requests" : "responses"}/${messageId}.json`;
	}
	throw new Error("invalid mailbox path");
}
async function boundedJson<T extends z.ZodType>(
	response: Response,
	schema: T,
): Promise<z.output<T>> {
	const length = Number(response.headers.get("content-length"));
	if (Number.isFinite(length) && length > MAX_CONTENT_BYTES)
		throw new Error("mailbox response too large");
	if (!response.body) throw new Error("mailbox response invalid");
	const reader = response.body.getReader(),
		parts: Buffer[] = [];
	let size = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			size += value.byteLength;
			if (size > MAX_CONTENT_BYTES) {
				await reader.cancel();
				throw new Error("mailbox response too large");
			}
			parts.push(Buffer.from(value));
		}
	} finally {
		reader.releaseLock();
	}
	return schema.parse(JSON.parse(Buffer.concat(parts).toString("utf8")));
}
/** Only the dedicated branch and a fixed run's immutable files are addressable. */
export function createContentsClient({
	token,
	branch,
	runId,
	fetchImpl = fetch,
}: {
	token: string;
	branch: string;
	runId: number;
	fetchImpl?: typeof fetch;
}) {
	z.object({
		token: z.string().min(1),
		branch: z.string().regex(BRANCH),
		runId: z.number().int().positive(),
	}).parse({ token, branch, runId });
	const base = `https://api.github.com/repos/${REPOSITORY}/contents/`,
		headers = {
			Accept: "application/vnd.github+json",
			Authorization: `Bearer ${token}`,
			"X-GitHub-Api-Version": "2026-03-10",
		};
	const send = createConditionalGithubFetch(fetchImpl);
	async function get(
		category: string,
		id?: string,
	): Promise<string | undefined> {
		const path = pathFor(runId, category, id),
			response = await send(
				`${base}${encodePath(path)}?ref=${encodeURIComponent(branch)}`,
				{
					method: "GET",
					headers,
					redirect: "error",
					signal: AbortSignal.timeout(15000),
				},
			);
		if (response.status === 404) return undefined;
		if (!response.ok) throw new Error("mailbox read failed");
		const entry = await boundedJson(response, fileEntry);
		if (entry.path !== path || entry.size > MAX_CONTENT_BYTES)
			throw new Error("invalid mailbox file");
		const decoded = Buffer.from(entry.content.replace(/\s/g, ""), "base64");
		if (decoded.length !== entry.size) throw new Error("invalid mailbox file");
		return decoded.toString("utf8");
	}
	async function listRequests(): Promise<string[]> {
		const path = `controllers/${runId}/requests`,
			response = await send(
				`${base}${encodePath(path)}?ref=${encodeURIComponent(branch)}`,
				{
					method: "GET",
					headers,
					redirect: "error",
					signal: AbortSignal.timeout(15000),
				},
			);
		if (response.status === 404) return [];
		if (!response.ok) throw new Error("mailbox listing failed");
		let entries: z.output<typeof requestEntries>;
		try {
			entries = await boundedJson(response, requestEntries);
		} catch {
			throw new Error("invalid mailbox entry");
		}
		const ids: string[] = [];
		for (const entry of entries) {
			if (entry.path !== `${path}/${entry.name}`)
				throw new Error("invalid mailbox entry");
			ids.push(entry.name.slice(0, -5));
		}
		return ids;
	}
	async function publish(
		category: string,
		id: string | undefined,
		text: string,
	): Promise<void> {
		if (category !== "response" && category !== "metadata")
			throw new Error("invalid mailbox publication");
		if (
			!z.string().safeParse(text).success ||
			Buffer.byteLength(text) > MAX_CONTENT_BYTES
		)
			throw new Error("invalid mailbox publication");
		const path = pathFor(runId, category, id);
		for (let attempt = 0; attempt < 4; attempt++) {
			const existing = await get(category, id);
			if (existing !== undefined) {
				if (existing !== text) throw new Error("mailbox collision");
				return;
			}
			let response: Response | undefined;
			try {
				response = await send(`${base}${encodePath(path)}`, {
					method: "PUT",
					headers: { ...headers, "Content-Type": "application/json" },
					body: JSON.stringify({
						message: "ci: publish bootstrap controller result",
						branch,
						content: Buffer.from(text).toString("base64"),
					}),
					redirect: "error",
					signal: AbortSignal.timeout(15000),
				});
			} catch {
				response = undefined;
			}
			if (response?.ok) return;
			const after = await get(category, id);
			if (after !== undefined) {
				if (after === text) return;
				throw new Error("mailbox collision");
			}
			if (response && response.status !== 409)
				throw new Error("mailbox publication failed");
		}
		throw new Error("mailbox publication uncertain");
	}

	return { get, listRequests, publish };
}
