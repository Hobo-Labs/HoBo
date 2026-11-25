import { createSign } from "node:crypto";
import { z } from "zod";

/** Must claim atomically across all worker instances before attempting redelivery. */
export interface WebhookRepairClaims {
	claim(appId: string, guid: string, now: number): Promise<boolean>;
	/** Serialize an incremental scan across all workers. */
	startScan(appId: string): Promise<
		| {
				cursor: string | undefined;
				checkpoint(cursor: string | undefined): Promise<void>;
				close(): Promise<void>;
		  }
		| undefined
	>;
	limited(appId: string, now: number): Promise<boolean>;
	recordSuccesses(appId: string, guids: string[], now: number): Promise<void>;
	wasSuccessful(appId: string, guid: string): Promise<boolean>;
}

const DeliveryId = z
	.union([
		z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
		z
			.string()
			.refine(
				(value) =>
					/^[1-9]\d{0,18}$/.test(value) &&
					BigInt(value) <= 9223372036854775807n,
			),
	])
	.transform((value) => String(value));

/** GitHub specifies a signed int64. Node 22+ exposes each original numeric
 * lexeme to the JSON reviver; a rounded fraction can otherwise look like a
 * safe integer. Never use the parsed number when the source is unavailable. */
function parseDeliveryJson(body: string) {
	return JSON.parse(body, (key, value, context?: { source?: string }) => {
		if (key !== "id") return value;
		const number = z.number().safeParse(value);
		if (!number.success) return value;
		const source = z.string().safeParse(context?.source);
		if (!source.success) throw new Error("lossless JSON parsing unavailable");
		return source.data;
	});
}

const Delivery = z.object({
	id: DeliveryId,
	guid: z.string().regex(/^[A-Za-z0-9-]{1,128}$/),
	event: z.string(),
	status_code: z.number().int().min(0).max(599),
	delivered_at: z.string().datetime({ offset: true }),
});

type WebhookRepairPhase =
	| "start-scan"
	| "cursor"
	| "deliveries-request"
	| "deliveries-json"
	| "deliveries-shape"
	| "pagination"
	| "record-successes"
	| "claim"
	| "redelivery"
	| "checkpoint"
	| "close";
interface WebhookRepairFailureEvent {
	event: "hobo_ci_webhook_repair_failure";
	phase: WebhookRepairPhase;
	fields?: string[];
	null_status?: boolean;
	id_kinds?: string[];
}
const DeliveryField = z.enum([
	"id",
	"guid",
	"event",
	"status_code",
	"delivered_at",
]);
const DeliveryStatusProbe = z
	.array(
		z
			.object({
				id: z.unknown().optional(),
				status_code: z.unknown().optional(),
			})
			.passthrough(),
	)
	.max(100);

/** Classify invalid IDs without logging their values. */
function idKind(
	id: z.infer<typeof DeliveryStatusProbe>[number]["id"],
): string | undefined {
	if (id === undefined) return "missing";
	if (id === null) return "null";
	const numeric = z.number().safeParse(id);
	if (numeric.success) {
		if (!Number.isSafeInteger(numeric.data))
			return "unsafe-or-noninteger-number";
		if (numeric.data <= 0) return "nonpositive-number";
		return undefined;
	}
	const string = z.string().safeParse(id);
	if (string.success)
		return /^\d+$/.test(string.data) ? "decimal-string" : "other-string";
	return "other-type";
}

/** Field names and fixed phases aid operations without recording webhook data,
 * provider responses, exception messages, tokens, or database URLs. */
function reportRepairFailure(
	phase: WebhookRepairPhase,
	error: Error | undefined,
	nullStatus = false,
	idKinds: string[] = [],
) {
	const event: WebhookRepairFailureEvent = {
		event: "hobo_ci_webhook_repair_failure",
		phase,
	};
	if (phase === "deliveries-shape" && error instanceof z.ZodError) {
		if (nullStatus) event.null_status = true;
		event.fields = [
			...new Set(
				error.issues.flatMap((issue) =>
					issue.path.flatMap((part) => {
						const result = DeliveryField.safeParse(part);
						return result.success ? [result.data] : [];
					}),
				),
			),
		].sort();
		if (event.fields.includes("id") && idKinds.length) event.id_kinds = idKinds;
	}
	try {
		console.error(JSON.stringify(event));
	} catch {
		// Diagnostic output must not alter retry, lock release, or cleanup.
	}
}

async function closeRepairScan(close: () => Promise<void>) {
	try {
		await close();
	} catch (error) {
		reportRepairFailure("close", error instanceof Error ? error : undefined);
		throw error;
	}
}

/** App-level JWT only; installation tokens cannot access the App deliveries API. */
export function createWebhookRepair(options: {
	appId: string;
	privateKey: string;
	claims: WebhookRepairClaims;
	/** True when the verified delivery has already been durably admitted. */
	isAccepted?: (deliveryId: string) => Promise<boolean>;
	fetch?: typeof fetch;
	now?: () => number;
}) {
	if (!/^[1-9]\d*$/.test(options.appId))
		throw new Error("invalid GitHub App id");
	const send = options.fetch ?? fetch;
	const now = options.now ?? Date.now;
	function headers() {
		const issued = Math.floor(now() / 1000) - 60;
		const header = Buffer.from(
			JSON.stringify({ alg: "RS256", typ: "JWT" }),
		).toString("base64url");
		const payload = Buffer.from(
			JSON.stringify({ iat: issued, exp: issued + 600, iss: options.appId }),
		).toString("base64url");
		const input = `${header}.${payload}`;
		const signature = createSign("RSA-SHA256")
			.update(input)
			.sign(options.privateKey)
			.toString("base64url");
		return {
			Accept: "application/vnd.github+json",
			"X-GitHub-Api-Version": "2026-03-10",
			Authorization: `Bearer ${input}.${signature}`,
		};
	}
	function nextPage(link: string | null): string | undefined {
		if (!link) return undefined;
		const next = link
			.split(",")
			.map((part) => part.trim())
			.find((part) => /;\s*rel="next"(?:\s*;|$)/.test(part));
		if (!next) return undefined;
		const match = /^<([^>]+)>;/.exec(next);
		if (!match?.[1]) throw new Error("invalid GitHub pagination link");
		const url = new URL(match[1]);
		if (
			url.origin !== "https://api.github.com" ||
			url.pathname !== "/app/hook/deliveries" ||
			url.hash ||
			url.username ||
			url.password
		)
			throw new Error("invalid GitHub pagination link");
		const keys = new Set<string>();
		for (const [key, value] of url.searchParams) {
			if (
				keys.has(key) ||
				!["cursor", "per_page", "page"].includes(key) ||
				!/^[A-Za-z0-9_=-]{1,200}$/.test(value)
			)
				throw new Error("invalid GitHub pagination query");
			keys.add(key);
		}
		return url.href;
	}
	return async function repair(): Promise<{
		scanned: number;
		requested: number;
		truncated: boolean;
		more: boolean;
		skipped?: boolean;
	}> {
		let scan: Awaited<ReturnType<WebhookRepairClaims["startScan"]>>;
		try {
			scan = await options.claims.startScan(options.appId);
		} catch (error) {
			reportRepairFailure(
				"start-scan",
				error instanceof Error ? error : undefined,
			);
			throw error;
		}
		if (!scan)
			return {
				scanned: 0,
				requested: 0,
				truncated: false,
				more: true,
				skipped: true,
			};
		let phase: WebhookRepairPhase = "cursor";
		let nullStatus = false;
		let idKinds: string[] = [];
		try {
			const current = now();
			const initial = "https://api.github.com/app/hook/deliveries?per_page=100";
			let url: string | undefined = scan.cursor ?? initial;
			// Validate even persisted cursors. Never send an App token to another host.
			if (url !== initial) url = nextPage(`<${url}>; rel="next"`);
			const seenUrls = new Set<string>();
			const pages: {
				url: string;
				next: string | undefined;
				deliveries: z.infer<typeof Delivery>[];
			}[] = [];
			for (let page = 0; url && page < 5; page++) {
				if (seenUrls.has(url)) throw new Error("cyclic GitHub pagination");
				seenUrls.add(url);
				phase = "deliveries-request";
				const response = await send(url, {
					headers: headers(),
					redirect: "error",
					signal: AbortSignal.timeout(10000),
				});
				if (!response.ok)
					throw new Error(
						`GitHub deliveries lookup failed (${response.status})`,
					);
				phase = "deliveries-json";
				const json = parseDeliveryJson(await response.text());
				const statusProbe = DeliveryStatusProbe.safeParse(json);
				nullStatus =
					statusProbe.success &&
					statusProbe.data.some((delivery) => delivery.status_code === null);
				idKinds = statusProbe.success
					? [
							...new Set(
								statusProbe.data.flatMap((delivery) => {
									const kind = idKind(delivery.id);
									return kind ? [kind] : [];
								}),
							),
						].sort()
					: [];
				phase = "deliveries-shape";
				const deliveries = z.array(Delivery).max(100).parse(json);
				phase = "pagination";
				const next = nextPage(response.headers.get("link"));
				pages.push({ url, next, deliveries });
				url = next;
			}
			const scanned = pages.reduce(
				(total, page) => total + page.deliveries.length,
				0,
			);
			const succeeded = new Set(
				pages
					.flatMap((page) => page.deliveries)
					.filter((item) => item.status_code >= 200 && item.status_code < 300)
					.map((item) => item.guid),
			);
			phase = "record-successes";
			await options.claims.recordSuccesses(
				options.appId,
				[...succeeded],
				current,
			);
			let requested = 0;
			for (const page of pages) {
				for (const item of page.deliveries) {
					phase = "claim";
					const age = current - Date.parse(item.delivered_at);
					if (
						!["workflow_job", "workflow_run"].includes(item.event) ||
						(item.status_code >= 200 && item.status_code < 300) ||
						succeeded.has(item.guid) ||
						age < 60_000
					)
						continue;
					if (
						(await options.isAccepted?.(item.guid)) ||
						(await options.claims.wasSuccessful(options.appId, item.guid))
					)
						continue;
					if (
						!(await options.claims.claim(options.appId, item.guid, current))
					) {
						if (await options.claims.limited(options.appId, current)) {
							phase = "checkpoint";
							await scan.checkpoint(page.url);
							return { scanned, requested, truncated: false, more: true };
						}
						continue;
					}
					phase = "redelivery";
					const posted = await send(
						`https://api.github.com/app/hook/deliveries/${item.id}/attempts`,
						{
							method: "POST",
							headers: headers(),
							redirect: "error",
							signal: AbortSignal.timeout(10000),
						},
					);
					if (posted.status !== 202)
						throw new Error(
							`GitHub redelivery request failed (${posted.status})`,
						);
					requested++;
					if (requested === 20) {
						phase = "checkpoint";
						await scan.checkpoint(page.url);
						return { scanned, requested, truncated: false, more: true };
					}
				}
				phase = "checkpoint";
				await scan.checkpoint(page.next);
			}
			return { scanned, requested, truncated: false, more: url !== undefined };
		} catch (error) {
			reportRepairFailure(
				phase,
				error instanceof Error ? error : undefined,
				nullStatus,
				idKinds,
			);
			throw error;
		} finally {
			await closeRepairScan(() => scan.close());
		}
	};
}
