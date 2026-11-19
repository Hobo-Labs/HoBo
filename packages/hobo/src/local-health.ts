import { setTimeout as delay } from "node:timers/promises";
import type { BindleResourceRecord } from "@hobo/bindles";
import { isJsonNumber, isJsonString } from "./json.js";

type LocalHttpHealthCheck = Readonly<{
	path: string;
	intervalMs: number;
	timeoutMs: number;
}>;

export function localHttpHealthCheck(
	resource: BindleResourceRecord,
): LocalHttpHealthCheck | undefined {
	const annotations = resource.annotations.filter(
		(annotation) => annotation.option === "health",
	);
	if (annotations.length === 0) return undefined;
	const annotation = annotations[0];
	if (annotations.length !== 1 || !annotation) {
		throw new TypeError(
			`local component ${resource.name} has multiple health checks`,
		);
	}
	const {
		type,
		path,
		intervalMs = 250,
		timeoutMs = 30_000,
	} = annotation.config;
	if (
		Object.keys(annotation.config).some(
			(key) => !["type", "path", "intervalMs", "timeoutMs"].includes(key),
		) ||
		type !== "http" ||
		!isJsonString(path) ||
		!path.startsWith("/") ||
		path.startsWith("//") ||
		/[\r\n]/u.test(path) ||
		!isJsonNumber(intervalMs) ||
		!Number.isSafeInteger(intervalMs) ||
		intervalMs < 1 ||
		!isJsonNumber(timeoutMs) ||
		!Number.isSafeInteger(timeoutMs) ||
		timeoutMs < 1 ||
		timeoutMs > 300_000 ||
		intervalMs > timeoutMs
	) {
		throw new TypeError(
			`local component ${resource.name} has an invalid HTTP health check`,
		);
	}
	return { path, intervalMs, timeoutMs };
}

async function probe(url: string, timeoutMs: number): Promise<boolean> {
	const abort = new AbortController();
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			fetch(url, { signal: abort.signal }).then(async (response) => {
				await response.body?.cancel();
				return response.ok;
			}),
			new Promise<boolean>((resolve) => {
				timer = setTimeout(() => {
					abort.abort();
					resolve(false);
				}, timeoutMs);
			}),
		]);
	} catch {
		return false;
	} finally {
		if (timer) clearTimeout(timer);
		abort.abort();
	}
}

export async function waitForLocalHttpHealth(
	resourceName: string,
	baseUrl: string,
	check: LocalHttpHealthCheck,
): Promise<void> {
	const deadline = performance.now() + check.timeoutMs;
	while (true) {
		const remaining = deadline - performance.now();
		if (remaining <= 0) {
			throw new Error(
				`local component ${resourceName} HTTP health check timed out`,
			);
		}
		if (await probe(`${baseUrl}${check.path}`, remaining)) return;
		const next = deadline - performance.now();
		if (next > 0) await delay(Math.min(check.intervalMs, next));
	}
}
