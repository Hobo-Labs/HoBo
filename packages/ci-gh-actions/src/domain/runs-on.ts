import {
	GH_AUTO_SIZES,
	GH_HOSTED_PROVIDERS,
	GH_STEP_KEYS,
	type GhAutoSize,
	type GhHostedProviderKey,
	GhRunnerLabel,
	type GhStepCandidate,
	type GhStepKey,
} from "./ids.js";

export const GH_RELAY_CHECK_LABELS = ["hobo-relay", "relayrunner"] as const;
export const GH_FLEET_SHORTHAND_LABELS = [
	"hobo",
	"hobo-trunk",
	"hobo-box",
] as const;

const GITHUB_HOSTED_LABELS: ReadonlySet<string> = new Set([
	"ubuntu-latest",
	"ubuntu-24.04",
	"ubuntu-22.04",
	"ubuntu-24.04-arm",
	"ubuntu-22.04-arm",
	"windows-latest",
	"windows-2025",
	"windows-2022",
	"windows-11-arm",
	"macos-latest",
	"macos-15",
	"macos-15-intel",
	"macos-14",
	"macos-13",
]);

const PROVIDER_PREFIXES = {
	blacksmith: ["blacksmith-"],
	depot: ["depot-"],
	namespace: ["nscloud-", "namespace-profile-"],
	warpbuild: ["warp-"],
	ubicloud: ["ubicloud-"],
	boat: ["boat-", "boat"],
	"runs-on": ["runs-on=", "runs-on/"],
} as const satisfies Readonly<Record<GhHostedProviderKey, readonly string[]>>;

const PROVIDER_AUTO_LABELS = {
	blacksmith: (vcpus: GhAutoSize) => `blacksmith-${vcpus}vcpu-ubuntu-2404`,
	depot: (vcpus: GhAutoSize) =>
		vcpus === 2 ? "depot-ubuntu-24.04" : `depot-ubuntu-24.04-${vcpus}`,
	namespace: (vcpus: GhAutoSize) =>
		`nscloud-ubuntu-24.04-amd64-${vcpus}x${vcpus * 2}`,
	warpbuild: (vcpus: GhAutoSize) => `warp-ubuntu-2404-x64-${vcpus}x`,
	ubicloud: (vcpus: GhAutoSize) =>
		vcpus === 32 ? "ubicloud-standard-30" : `ubicloud-standard-${vcpus}`,
	boat: () => "boat",
	"runs-on": (vcpus: GhAutoSize, runId: number) =>
		`runs-on=${runId}/runner=${vcpus}cpu-linux-x64`,
} satisfies Readonly<
	Record<GhHostedProviderKey, (vcpus: GhAutoSize, runId: number) => string>
>;

export function isGhHostedProviderKey(
	key: GhStepKey,
): key is GhHostedProviderKey {
	return GH_HOSTED_PROVIDERS.some((provider) => provider === key);
}

export function parseGhStepKey(text: string): GhStepKey | undefined {
	const lowered = text.trim().toLowerCase();
	return GH_STEP_KEYS.find((key) => key === lowered);
}

export function parseGhAutoSize(
	value: string | number,
): GhAutoSize | undefined {
	const numeric = Number(value);
	return GH_AUTO_SIZES.find((size) => size === numeric);
}

export function isGhGithubHostedLabel(label: string): boolean {
	return GITHUB_HOSTED_LABELS.has(label.trim().toLowerCase());
}

export function isGhProviderLabel(
	provider: GhHostedProviderKey,
	label: string,
): boolean {
	const lower = label.trim().toLowerCase();
	return PROVIDER_PREFIXES[provider].some((prefix) =>
		prefix.endsWith("-")
			? lower.startsWith(prefix) || lower === prefix.slice(0, -1)
			: lower === prefix || lower.startsWith(prefix),
	);
}

export function resolveGhAutoLabel(
	step: GhStepKey,
	vcpus: GhAutoSize,
	runId: number,
): GhRunnerLabel | undefined {
	if (step === "github") return GhRunnerLabel.make("ubuntu-24.04");
	if (step === "fleet" || step === "machine") return undefined;
	return GhRunnerLabel.make(PROVIDER_AUTO_LABELS[step](vcpus, runId));
}

export type ParsedGhRunsOn =
	| Readonly<{
			ok: true;
			kind: "relay-check";
			label: GhRunnerLabel;
	  }>
	| Readonly<{
			ok: true;
			kind: "fleet";
			label: GhRunnerLabel;
			candidates: readonly GhStepCandidate[];
	  }>
	| Readonly<{
			ok: true;
			kind: "route";
			first: GhStepKey | null;
			size: GhAutoSize | null;
			candidates: readonly GhStepCandidate[];
	  }>
	| Readonly<{
			ok: false;
			reason: string;
	  }>;

function splitStructuredSegments(spec: string): readonly string[] {
	const raw = spec.split("/");
	const merged: string[] = [];
	for (const part of raw) {
		const trimmed = part.trim();
		if (trimmed === "") continue;
		const previous = merged.at(-1);
		if (
			previous !== undefined &&
			previous.toLowerCase().startsWith("runs-on=runs-on=") &&
			!parseLeadingKey(trimmed)
		) {
			merged[merged.length - 1] = `${previous}/${trimmed}`;
			continue;
		}
		merged.push(trimmed);
	}
	return merged;
}

function parseLeadingKey(segment: string): string | undefined {
	const eq = segment.indexOf("=");
	if (eq <= 0) return undefined;
	const key = segment.slice(0, eq).trim().toLowerCase();
	if (key === "first" || key === "size") return key;
	return parseGhStepKey(key);
}

function splitLabelList(raw: string): readonly GhRunnerLabel[] {
	return raw
		.split(",")
		.map((part) => part.trim())
		.filter((part) => part.length > 0)
		.map((part) => GhRunnerLabel.make(part));
}

export function parseGhRelayInputs(
	inputs: Readonly<Record<string, string>>,
): ParsedGhRunsOn {
	let first: GhStepKey | null = null;
	let size: GhAutoSize | null = null;
	const candidates: GhStepCandidate[] = [];
	const seenSteps = new Set<GhStepKey>();

	for (const [rawKey, rawValue] of Object.entries(inputs)) {
		const key = rawKey.trim().toLowerCase();
		const value = rawValue.trim();
		if (value === "") continue;
		if (value.includes("${{")) {
			return {
				ok: false,
				reason: `Relay input "${key}" contains an unevaluated expression.`,
			};
		}
		if (key === "first") {
			const step = parseGhStepKey(value);
			if (!step) {
				return {
					ok: false,
					reason: `Unknown runner type "${value}" in "first".`,
				};
			}
			first = step;
			continue;
		}
		if (key === "size") {
			const parsedSize = parseGhAutoSize(value);
			if (parsedSize === undefined) {
				return {
					ok: false,
					reason: `Unsupported runner size "${value}"; use one of ${GH_AUTO_SIZES.join(", ")}.`,
				};
			}
			size = parsedSize;
			continue;
		}
		const step = parseGhStepKey(key);
		if (!step) {
			return {
				ok: false,
				reason: `Unknown relay runner key "${rawKey}".`,
			};
		}
		if (seenSteps.has(step)) {
			return {
				ok: false,
				reason: `Duplicate runner key "${step}" in route specification.`,
			};
		}
		seenSteps.add(step);
		const labels = splitLabelList(value);
		if (labels.length === 0) {
			return {
				ok: false,
				reason: `Runner key "${step}" must declare at least one label.`,
			};
		}
		candidates.push({ step, labels });
	}

	if (candidates.length === 0) {
		return {
			ok: false,
			reason: "Route specification must declare at least one runner candidate.",
		};
	}

	return {
		ok: true,
		kind: "route",
		first,
		size,
		candidates,
	};
}

export function parseGhRunsOn(raw: string | readonly string[]): ParsedGhRunsOn {
	const items = (Array.isArray(raw) ? raw : [raw])
		.map((entry) => entry.trim())
		.filter((entry) => entry.length > 0);

	if (items.length === 0) {
		return { ok: false, reason: "runs-on must contain at least one label." };
	}

	if (items.length === 1) {
		const single = items[0] ?? "";
		const lower = single.toLowerCase();
		if (GH_RELAY_CHECK_LABELS.some((label) => label === lower)) {
			return {
				ok: true,
				kind: "relay-check",
				label: GhRunnerLabel.make(single),
			};
		}
		if (GH_FLEET_SHORTHAND_LABELS.some((label) => label === lower)) {
			const label = GhRunnerLabel.make(single);
			return {
				ok: true,
				kind: "fleet",
				label,
				candidates: [{ step: "fleet", labels: [label] }],
			};
		}
		if (lower.startsWith("hobo/") || lower.startsWith("relay/")) {
			const rest = single.slice(single.indexOf("/") + 1);
			return parseStructuredTokens(splitStructuredSegments(rest));
		}
		return {
			ok: false,
			reason: `Label "${single}" is not a HoBo relay or structured runs-on specification.`,
		};
	}

	const firstItem = (items[0] ?? "").toLowerCase();
	if (
		firstItem === "hobo" ||
		firstItem === "hobo-relay" ||
		firstItem === "relay" ||
		firstItem.startsWith("hobo/") ||
		firstItem.startsWith("relay/")
	) {
		const tokens: string[] = [];
		for (const item of items) {
			const lower = item.toLowerCase();
			if (lower === "hobo" || lower === "hobo-relay" || lower === "relay") {
				continue;
			}
			if (lower.startsWith("hobo/") || lower.startsWith("relay/")) {
				tokens.push(
					...splitStructuredSegments(item.slice(item.indexOf("/") + 1)),
				);
				continue;
			}
			tokens.push(item);
		}
		return parseStructuredTokens(tokens);
	}

	return {
		ok: false,
		reason: `runs-on labels [${items.join(", ")}] do not start with a HoBo relay prefix.`,
	};
}

function parseStructuredTokens(tokens: readonly string[]): ParsedGhRunsOn {
	if (tokens.length === 0) {
		return {
			ok: false,
			reason: "Structured runs-on specification has no runner clauses.",
		};
	}
	const record: Record<string, string> = {};
	for (const token of tokens) {
		const eq = token.indexOf("=");
		if (eq <= 0 || eq === token.length - 1) {
			return {
				ok: false,
				reason: `Invalid structured runs-on clause "${token}"; expected key=value.`,
			};
		}
		const key = token.slice(0, eq).trim().toLowerCase();
		const value = token.slice(eq + 1).trim();
		if (Object.hasOwn(record, key)) {
			return {
				ok: false,
				reason: `Duplicate runner key "${key}" in runs-on specification.`,
			};
		}
		record[key] = value;
	}
	return parseGhRelayInputs(record);
}

export function formatGhRunsOn(spec: {
	readonly first?: GhStepKey | null;
	readonly size?: GhAutoSize | null;
	readonly candidates: readonly GhStepCandidate[];
}): GhRunnerLabel {
	const clauses: string[] = ["hobo"];
	if (spec.first !== undefined && spec.first !== null) {
		clauses.push(`first=${spec.first}`);
	}
	if (spec.size !== undefined && spec.size !== null) {
		clauses.push(`size=${spec.size}`);
	}
	for (const candidate of spec.candidates) {
		clauses.push(`${candidate.step}=${candidate.labels.join(",")}`);
	}
	return GhRunnerLabel.make(clauses.join("/"));
}
