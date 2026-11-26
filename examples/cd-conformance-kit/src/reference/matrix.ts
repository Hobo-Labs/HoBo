// Reference bindings for the toolset and platform matrices and the WP20 §10
// rows (air gap, journal replay). They model each ingress path and delivery
// cell at the port level so the matrix harness itself is proven; the real
// composition binds the same harness interfaces at merge.
import {
	type AirgapHarness,
	CD_RECONCILE_STATUS,
	CD_REFUSAL,
	type CdIngressPath,
	type CdOutcomeLike,
	cdCanonicalText,
	type JournalReplayHarness,
	type PlatformCell,
	type PlatformDelivery,
	type PlatformMatrixHarness,
	type ToolsetMatrixHarness,
} from "@hobo/conformance";
import type { HttpTransport } from "@hobo/core";
import { ok, refuse, sha256 } from "./common.js";

// ── Toolset ──────────────────────────────────────────────────────────────────

/** The one build every ingress path carries. */
export const REFERENCE_BUILD = Object.freeze({
	bindle: "shop",
	declarationHash: sha256("hobo.bindle.ts of shop@1.4.0"),
	commit: "4f2c9a1d0b7e",
	artifacts: [
		{ name: "app", kind: 1, digest: sha256("shop app.wasm 1.4.0") },
		{ name: "assets", kind: 3, digest: sha256("shop assets 1.4.0") },
	],
});

type Manifest = Readonly<{
	bindle: string;
	declarationHash: string;
	commit: string;
	artifacts: readonly Readonly<{ name: string; kind: number; digest: string }>[];
}>;

/** What each path's boundary hands the ledger, before canonicalisation. */
function arrive(path: CdIngressPath): Manifest {
	const { bindle, declarationHash, commit, artifacts } = REFERENCE_BUILD;
	switch (path) {
		case "oci-poll":
		case "git-poll":
		case "hobo-ci":
			return { bindle, declarationHash, commit, artifacts };
		case "github-oidc-push":
		case "gitlab-oidc-push":
			// A push manifest may list artifacts in any order; the boundary sorts them.
			return { bindle, declarationHash, commit, artifacts: [...artifacts].reverse() };
		case "in-toto-attestation":
			return { declarationHash, commit, artifacts, bindle };
		case "cdevent-nudge":
			// The nudge schedules a poll; the verified read produces the manifest.
			return { bindle, declarationHash, commit, artifacts };
	}
}

export type ToolsetMutant = "path-in-id" | "trusts-payload" | "unordered-artifacts";

export function refToolsetHarness(mutant?: ToolsetMutant): ToolsetMatrixHarness {
	const freightId = (manifest: Manifest, path: CdIngressPath) => {
		const artifacts = mutant === "unordered-artifacts" ? manifest.artifacts : [...manifest.artifacts].sort((a, b) => a.name.localeCompare(b.name));
		const identity: Manifest & { origin?: string } = {
			bindle: manifest.bindle,
			declarationHash: manifest.declarationHash,
			commit: manifest.commit,
			artifacts,
		};
		if (mutant === "path-in-id") identity.origin = path;
		return sha256(cdCanonicalText(identity));
	};
	return {
		subject: mutant ? `reference-toolset[${mutant}]` : "reference-toolset",
		ingest: async (path) => ok({ freightId: freightId(arrive(path), path) }),
		nudgeWithoutEvidence: async () => ({
			freightIds: mutant === "trusts-payload" ? [sha256("payload")] : [],
			scheduledPolls: ["shop"],
		}),
	};
}

// ── Platform ─────────────────────────────────────────────────────────────────

export type PlatformMutant = "silent-downgrade" | "rebuilds-vm-images" | "wasm-unsupported";

export function refPlatformHarness(mutant?: PlatformMutant): PlatformMatrixHarness {
	return {
		subject: mutant ? `reference-platform[${mutant}]` : "reference-platform",
		deliver: async (cell: PlatformCell): Promise<CdOutcomeLike<PlatformDelivery>> => {
			if (cell.resolver === "wasm-component" && mutant === "wasm-unsupported") {
				return refuse("resolver-missing", "no resolver for this platform", "register a hobo:resolver component");
			}
			if (cell.strategy === "canary" && cell.rung === "none" && mutant !== "silent-downgrade") {
				return refuse(CD_REFUSAL.progressiveUnsupported, "canary required and no traffic offering is realizable", "choose a rolling strategy or a provider with a traffic offering");
			}
			const digest = sha256(`shop ${cell.artifactKind}`);
			const setDigest = mutant === "rebuilds-vm-images" && cell.artifactKind === "VM_IMAGE" ? sha256(`rebuilt ${cell.artifactKind}`) : digest;
			return ok({ status: CD_RECONCILE_STATUS.CONVERGED, freightDigests: [digest], setDigests: [setDigest], loweredRung: cell.rung });
		},
	};
}

// ── Air gap ──────────────────────────────────────────────────────────────────

export type AirgapMutant = "phones-home" | "station-dials-agent";

export function refAirgapHarness(mutant?: AirgapMutant): AirgapHarness {
	const inner: HttpTransport = async () => ({ status: 200, headers: {}, body: "{}" });
	return {
		subject: mutant ? `reference-airgap[${mutant}]` : "reference-airgap",
		yardHosts: ["registry.yard.internal", "station.yard.internal"],
		inner,
		run: async (transport) => {
			const call = (url: string) => transport({ method: "GET", url, headers: {}, timeoutMs: 5_000, maxResponseBytes: 1_048_576 });
			let status: number = CD_RECONCILE_STATUS.CONVERGED;
			try {
				await call("https://registry.yard.internal/v2/shop/app/tags/list");
				await call("https://station.yard.internal/v1/cd/feed?camp=edge-1");
				if (mutant === "phones-home") await call("https://telemetry.example.com/v1/ping");
			} catch {
				status = CD_RECONCILE_STATUS.BLOCKED;
			}
			return { status, stationToAgentConnections: mutant === "station-dials-agent" ? 1 : 0, stationTargetCredentials: [] };
		},
	};
}

// ── Journal replay ───────────────────────────────────────────────────────────

export type ReplayMutant = "unjournaled-state" | "wall-clock";
type Event = Readonly<{ type: string; data: Readonly<Record<string, string>> }>;
type State = Readonly<{ freight: readonly string[]; qualified: readonly string[]; sets: Readonly<Record<string, string>>; at: string }>;

function fold(events: readonly Event[], mutant?: ReplayMutant): State {
	const freight: string[] = [];
	const qualified: string[] = [];
	const sets: Record<string, string> = {};
	let at = "";
	for (const event of events) {
		if (event.type === "freight.Recorded") freight.push(event.data.id ?? "");
		if (event.type === "set.Created") sets[event.data.camp ?? ""] = event.data.set ?? "";
		if (event.type === "freight.Qualified") qualified.push(`${event.data.id}@${event.data.camp}`);
		at = mutant === "wall-clock" ? String(performance.now()) : (event.data.at ?? at);
	}
	return { freight, qualified, sets, at };
}

export function refReplayHarness(mutant?: ReplayMutant): JournalReplayHarness<readonly Event[], State> {
	return {
		subject: mutant ? `reference-replay[${mutant}]` : "reference-replay",
		live: async () => {
			const id = sha256("shop@1.4.0");
			const events: Event[] = [{ type: "freight.Recorded", data: { id, at: "1" } }];
			let step = 2;
			for (const camp of ["dev", "staging", "prod"]) {
				events.push({ type: "set.Created", data: { camp, set: `set-${camp}-1`, at: String(step++) } });
				events.push({ type: "freight.Qualified", data: { id, camp, at: String(step++) } });
			}
			const state = fold(events, mutant);
			return { journal: events, state: mutant === "unjournaled-state" ? { ...state, sets: { ...state.sets, cache: "warm" } } : state };
		},
		replay: async (journal) => fold(journal, mutant),
	};
}
