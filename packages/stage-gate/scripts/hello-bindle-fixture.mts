import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(
	fileURLToPath(new URL(".", import.meta.url)),
	"../../..",
);

export function resolveSourceDateEpoch(): string {
	const raw = process.env.SOURCE_DATE_EPOCH?.trim();
	if (!raw) {
		return "2024-01-01T00:00:00.000Z";
	}
	if (/^\d+$/.test(raw)) {
		return new Date(Number.parseInt(raw, 10) * 1000).toISOString();
	}
	return raw;
}

export function resolveHelloBindleRoot(): string {
	const production = join(REPO_ROOT, "examples/hello-bindle");
	if (existsSync(join(production, "src/service.ts"))) {
		return production;
	}
	return join(
		REPO_ROOT,
		"src/draft/technical-proofs/hobo-componentize-contract/examples/hello-bindle",
	);
}

export async function buildHelloBindleComponent() {
	const { componentizeHelloBindle } = await import("@hobo/componentize");
	return componentizeHelloBindle({
		sourceRoot: resolveHelloBindleRoot(),
		sourceDateEpoch: resolveSourceDateEpoch(),
	});
}

export function emitEvidence(payload: Record<string, string>): void {
	console.log(JSON.stringify(payload));
}

export { REPO_ROOT };
