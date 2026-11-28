import { execFileSync } from "node:child_process";
import type {
	CrossplaneClaim,
	CrossplaneClusterLike,
	CrossplaneComposition,
} from "./crossplane-adapter.js";
import { CrossplaneProgramError } from "./crossplane-adapter.js";
import { isJsonObject, type JsonObject, type JsonValue } from "./json.js";

// public-contract: error code for a missing/broken kubectl binary or cluster.
export const KUBECTL_UNAVAILABLE = "kubectl-unavailable";

// public-contract: the annotation carrying the apply-time outputs snapshot.
export const APPLIED_OUTPUTS_ANNOTATION = "hobo.dev/applied-outputs";

export class CrossplaneClusterUnavailableError extends Error {
	code: string;

	constructor(code: string, message: string) {
		super(message);
		this.name = "CrossplaneClusterUnavailableError";
		this.code = code;
	}
}

export interface KubectlCrossplaneClusterOptions {
	readonly claimApiVersion?: string;
	readonly claimKind?: string;
	readonly namespace?: string;
	readonly kubectlBin?: string;
	readonly context?: string;
	readonly env?: Record<string, string | undefined>;
	readonly pollIntervalMs?: number;
}

export function createKubectlCrossplaneCluster(
	options: KubectlCrossplaneClusterOptions = {},
): CrossplaneClusterLike & { verifyReachable(): void } {
	const bin = options.kubectlBin ?? "kubectl";
	const namespace = options.namespace ?? "default";
	const claimApiVersion = options.claimApiVersion ?? "hobo.dev/v1alpha1";
	const claimKind = options.claimKind ?? "HoboResourceClaim";
	const claimResource = `${claimKind.toLowerCase()}s.${claimApiVersion.split("/")[0]}`;
	const env = options.env ?? process.env;
	const pollIntervalMs = options.pollIntervalMs ?? 2000;
	let verified = false;

	function kubectlEnv(): Record<string, string> {
		return Object.fromEntries(
			Object.entries(env).filter(
				(entry): entry is [string, string] => entry[1] !== undefined,
			),
		);
	}

	function run(args: readonly string[]): string {
		const contextArgs = options.context ? ["--context", options.context] : [];
		try {
			return execFileSync(bin, [...contextArgs, ...args], {
				env: kubectlEnv(),
				encoding: "utf8",
				stdio: ["pipe", "pipe", "pipe"],
			});
		} catch (error) {
			throw new CrossplaneClusterUnavailableError(
				KUBECTL_UNAVAILABLE,
				// SAFETY: ``kubectl (${bin}) failed for [${args.join(" ")}]: ${(error as Error).message}`,` is required at this I/O or test boundary.
				`kubectl (${bin}) failed for [${args.join(" ")}]: ${(error as Error).message}`,
			);
		}
	}

	function runWithInput(args: readonly string[], input: string): string {
		const contextArgs = options.context ? ["--context", options.context] : [];
		try {
			return execFileSync(bin, [...contextArgs, ...args], {
				env: kubectlEnv(),
				encoding: "utf8",
				input,
				stdio: ["pipe", "pipe", "pipe"],
			});
		} catch (error) {
			throw new CrossplaneClusterUnavailableError(
				KUBECTL_UNAVAILABLE,
				// SAFETY: ``kubectl (${bin}) failed for [${args.join(" ")}]: ${(error as Error).message}`,` is required at this I/O or test boundary.
				`kubectl (${bin}) failed for [${args.join(" ")}]: ${(error as Error).message}`,
			);
		}
	}

	function ensureAvailable(): void {
		if (verified) return;
		run(["version", "--client=true", "-o", "json"]);
		run(["get", "namespace", namespace, "-o", "name"]);
		verified = true;
	}

	function sleep(ms: number): void {
		const shared = new SharedArrayBuffer(4);
		Atomics.wait(new Int32Array(shared), 0, 0, ms);
	}

	interface KubectlCondition {
		readonly type?: string;
		readonly status?: string;
		readonly reason?: string;
	}

	interface KubectlClaimDocument {
		readonly metadata?: {
			readonly name?: string;
			readonly uid?: string;
			readonly annotations?: Record<string, string>;
		};
		readonly spec?: JsonObject;
		readonly status?: {
			readonly conditions?: readonly KubectlCondition[];
			readonly outputs?: JsonObject;
		};
	}

	function toClusterDocument(claim: CrossplaneClaim): string {
		return JSON.stringify({
			apiVersion: claimApiVersion,
			kind: claimKind,
			metadata: {
				name: claim.name,
				namespace,
				annotations: {
					[APPLIED_OUTPUTS_ANNOTATION]: JSON.stringify(
						claim.status?.outputs ?? {},
					),
				},
			},
			spec: claim.spec,
		});
	}

	function fromClusterDocument(
		document: KubectlClaimDocument,
	): CrossplaneClaim {
		const spec = document.spec ?? {};
		const conditions: readonly KubectlCondition[] =
			document.status?.conditions ?? [];
		const ready = conditions.some(
			(condition) => condition.type === "Ready" && condition.status === "True",
		);
		let appliedOutputs: JsonObject | undefined;
		try {
			const raw = document.metadata?.annotations?.[APPLIED_OUTPUTS_ANNOTATION];
			appliedOutputs = raw ? JSON.parse(raw) : undefined;
		} catch {
			appliedOutputs = undefined;
		}
		return {
			id: `crossplane:claim:${document.metadata?.name}`,
			name: document.metadata?.name,
			spec,
			specHash: stableJson(spec),
			status: {
				phase: ready ? "Ready" : "Pending",
				outputs: document.status?.outputs ?? {},
			},
			...(appliedOutputs !== undefined ? { appliedOutputs } : undefined),
		};
	}

	return {
		verifyReachable() {
			ensureAvailable();
		},
		hasCrd(name: string): boolean {
			ensureAvailable();
			const raw = run(["get", "crd", "-o", "json"]);
			// SAFETY: `const parsed = JSON.parse(raw) as {` is required at this I/O or test boundary.
			const parsed = JSON.parse(raw) as {
				items?: Array<{ spec?: { names?: { kind?: string } } }>;
			};
			const kinds = new Set(
				(parsed.items ?? []).map((item) => item.spec?.names?.kind ?? ""),
			);
			if (name === "CompositeResourceClaim") {
				return kinds.has(claimKind) || kinds.has("CompositeResourceDefinition");
			}
			return kinds.has(name);
		},
		compositions(): CrossplaneComposition[] {
			ensureAvailable();
			const raw = run([
				"get",
				"compositions.apiextensions.crossplane.io",
				"-o",
				"json",
			]);
			// SAFETY: `const parsed = JSON.parse(raw) as {` is required at this I/O or test boundary.
			const parsed = JSON.parse(raw) as {
				items?: Array<{
					metadata?: { name?: string; labels?: Record<string, string> };
				}>;
			};
			return (parsed.items ?? []).map((item) => ({
				name: item.metadata?.name ?? "",
				labels: item.metadata?.labels ?? {},
			}));
		},
		applyClaim(claim: CrossplaneClaim): void {
			ensureAvailable();
			runWithInput(
				["apply", "-n", namespace, "-f", "-"],
				toClusterDocument(claim),
			);
		},
		waitForReady(name: string, pollLimit: number): boolean {
			ensureAvailable();
			for (let attempt = 0; attempt < pollLimit; attempt += 1) {
				const claim = this.getClaim(name);
				if (claim?.status.phase === "Ready") return true;
				if (attempt < pollLimit - 1) sleep(pollIntervalMs);
			}
			return false;
		},
		getClaim(name: string): CrossplaneClaim | undefined {
			ensureAvailable();
			try {
				const raw = run([
					"get",
					claimResource,
					name,
					"-n",
					namespace,
					"-o",
					"json",
				]);
				return fromClusterDocument(JSON.parse(raw));
			} catch (error) {
				if (
					error instanceof CrossplaneClusterUnavailableError &&
					/NotFound|not found/i.test(error.message)
				) {
					return undefined;
				}
				throw error;
			}
		},
		claimNames(): string[] {
			ensureAvailable();
			const raw = run(["get", claimResource, "-n", namespace, "-o", "json"]);
			// SAFETY: `const parsed = JSON.parse(raw) as {` is required at this I/O or test boundary.
			const parsed = JSON.parse(raw) as {
				items?: Array<{ metadata?: { name?: string } }>;
			};
			return (parsed.items ?? [])
				.map((item) => item.metadata?.name ?? "")
				.filter((name) => name.length > 0)
				.sort();
		},
		deleteClaim(name: string): void {
			ensureAvailable();
			run([
				"delete",
				claimResource,
				name,
				"-n",
				namespace,
				"--ignore-not-found=true",
			]);
		},
	};
}

export { CrossplaneProgramError };

function stableJson(value: JsonValue): string {
	if (Array.isArray(value)) {
		return `[${value.map((item) => stableJson(item)).join(",")}]`;
	}
	if (value && isJsonObject(value)) {
		// SAFETY: `return `{${Object.keys(value as JsonObject)` is required at this I/O or test boundary.
		return `{${Object.keys(value as JsonObject)
			.sort()
			.map(
				(key) =>
					// SAFETY: ``${JSON.stringify(key)}:${stableJson((value as JsonObject)[key])}`,` is required at this I/O or test boundary.
					`${JSON.stringify(key)}:${stableJson((value as JsonObject)[key])}`,
			)
			.join(",")}}`;
	}
	return JSON.stringify(value);
}
