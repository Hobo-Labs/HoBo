// The resolver-component conformance kit. Every hobo:resolver component must
// pass it before an operator registers it: describe() matches the signed
// manifest and is deterministic; reconcile converges, is idempotent and
// updates; read observes; retained fields never read as drift; outputs are
// secret-free; delete removes and is idempotent; instances() answers with a
// list or a typed refusal; every outbound request stayed on the allowlist
// and the credential went only to bound hosts.
//
// The kit drives a component through the same `componentResolvers` seam the
// reconciler uses, against an upstream the caller supplies (the fakes in
// ./fakes.ts for the reference components, or a live endpoint in a
// credential-gated lane).
import { create } from "@bufbuild/protobuf";
import type {
	HttpTransport,
	JsonObject,
	JsonValue,
	ResolveOutcome,
	ResolveRequest,
	TransportRequest,
} from "@hobo/core";
import {
	type ConformanceCheckRecord,
	ConformanceCheckRecordSchema,
	type ConformanceReportRecord,
	ConformanceReportRecordSchema,
} from "../_generated/resolver_components_pb.js";
import { ResolverComponentError } from "../errors.js";
import { compare } from "../manifest.js";
import {
	componentResolvers,
	isComponentResolver,
} from "../resolver.js";
import type { LoadedResolverComponent } from "../runtime.js";
import { createSecretScanner } from "../secrets.js";

export * from "./fakes.js";

// public-contract: the conformance check ids, in run order.
export const CONFORMANCE_CHECKS = Object.freeze([
	"describe.matches-manifest",
	"describe.deterministic",
	"reconcile.converges",
	"reconcile.idempotent",
	"reconcile.updates",
	"read.observes",
	"observe.retained-not-drift",
	"outputs.secret-free",
	"egress.within-allowlist",
	"credential.bound-hosts-only",
	"delete.removes",
	"delete.idempotent",
	"instances.typed",
] as const);
export type ConformanceCheckId = (typeof CONFORMANCE_CHECKS)[number];

export interface ConformanceTarget {
	readonly component: LoadedResolverComponent;
	readonly productId: string;
	/** The provider endpoint the component talks to (fresh state). */
	readonly upstream: HttpTransport;
	readonly desired: JsonObject;
	/** A second desired state that must produce update or replace. */
	readonly changed: JsonObject;
	readonly credentialRef: string;
	/** The material the host injects for `credentialRef` (for the scanner). */
	readonly credentialMaterial: readonly string[];
	readonly logicalId?: string;
}

/** Run every check; never throws for a failing component. */
export async function runResolverComponentConformance(
	target: ConformanceTarget,
): Promise<ConformanceReportRecord> {
	const verified = target.component.verified;
	const manifest = verified.manifest;
	const checks = new Map<ConformanceCheckId, ConformanceCheckRecord>();
	const record = (id: ConformanceCheckId, passed: boolean, detail: string): void => {
		checks.set(id, create(ConformanceCheckRecordSchema, { id, passed, detail }));
	};
	const requests: TransportRequest[] = [];
	const transport: HttpTransport = async (request) => {
		requests.push(request);
		return target.upstream(request);
	};
	const resolver = componentResolvers({ components: [target.component] }).find(
		(candidate) => candidate.productId === target.productId,
	);
	if (resolver === undefined || !isComponentResolver(resolver)) {
		record("describe.matches-manifest", false, `no resolver for ${target.productId}`);
		return report(target, checks);
	}

	const declared = manifest.classes.map((entry) => entry.productId).join(",");
	const live = target.component.classes.map((entry) => entry.productId).join(",");
	record("describe.matches-manifest", declared === live, `manifest ${declared}; describe ${live}`);

	await check(record, "describe.deterministic", async () => {
		const first = await target.component.invoke("describe", null, { productId: "" });
		const second = await target.component.invoke("describe", null, { productId: "" });
		return [JSON.stringify(first) === JSON.stringify(second), "two describe() calls are byte-identical"];
	});

	const outcomes: ResolveOutcome[] = [];
	const at = (desired: JsonObject, physicalId?: string): ResolveRequest => ({
		ref: {
			slot: resolver.resourceClass.slot,
			productId: target.productId,
			logicalId: target.logicalId ?? "conformance",
			...(physicalId === undefined ? undefined : { physicalId }),
		},
		desired,
		credentialRef: target.credentialRef,
	});

	let physicalId: string | undefined;
	await check(record, "reconcile.converges", async () => {
		const first = await resolver.reconcile(at(target.desired), transport);
		outcomes.push(first);
		physicalId = first.physicalId;
		return [first.action === "create" || first.action === "adopt", `first reconcile: ${first.action}`];
	});
	await check(record, "reconcile.idempotent", async () => {
		const again = await resolver.reconcile(at(target.desired, physicalId), transport);
		outcomes.push(again);
		return [
			again.action === "noop" && again.physicalId === physicalId,
			`second reconcile: ${again.action} ${again.physicalId}`,
		];
	});
	await check(record, "reconcile.updates", async () => {
		const changed = await resolver.reconcile(at(target.changed, physicalId), transport);
		const settled = await resolver.reconcile(at(target.changed, changed.physicalId), transport);
		outcomes.push(changed, settled);
		physicalId = settled.physicalId;
		return [
			(changed.action === "update" || changed.action === "replace") && settled.action === "noop",
			`changed: ${changed.action}; then ${settled.action}`,
		];
	});
	await check(record, "read.observes", async () => {
		const read = await resolver.read?.(at(target.changed, physicalId), transport);
		if (read !== undefined) outcomes.push(read);
		return [read?.physicalId === physicalId, `read: ${read?.physicalId ?? "nothing"}`];
	});
	await check(record, "observe.retained-not-drift", async () => {
		const retained = resolver.resourceClass.retainedFields;
		const desired: Record<string, JsonValue> = { ...target.changed };
		for (const field of retained) desired[field] = "__conformance_retained__";
		const observed = await resolver.observe(
			at(desired, physicalId),
			transport,
			resolver.resourceClass.observeFields,
		);
		const drift = observed?.driftKind ?? "";
		const leaked = retained.filter((field) => drift.split(/[:,]/u).includes(field));
		return [
			observed !== undefined && leaked.length === 0,
			leaked.length === 0 ? `drift "${drift}"` : `retained reported as drift: ${leaked.join(",")}`,
		];
	});
	const scanner = createSecretScanner(target.credentialMaterial);
	const leaking = outcomes.filter((entry) => scanner.find(JSON.stringify(entry)));
	record("outputs.secret-free", leaking.length === 0, `${outcomes.length} outcomes scanned`);

	const allowed = new Set(manifest.egress.map((entry) => entry.host));
	const strays = requests.map((request) => new URL(request.url).hostname).filter((host) => !allowed.has(host));
	record("egress.within-allowlist", strays.length === 0, strays.length === 0 ? `${requests.length} requests` : `reached ${strays.join(",")}`);
	const bound = new Set(manifest.credentialHosts);
	const misplaced = requests.filter(
		(request) =>
			!bound.has(new URL(request.url).hostname) &&
			Object.values(request.headers).some((value) => scanner.find(value)),
	);
	record("credential.bound-hosts-only", misplaced.length === 0, `${misplaced.length} credentialed requests to unbound hosts`);

	await check(record, "delete.removes", async () => {
		await resolver.delete(at(target.changed, physicalId), transport);
		const after = await resolver.read?.(at(target.changed, physicalId), transport);
		return [after === undefined, after === undefined ? "gone" : `still ${after.physicalId}`];
	});
	await check(record, "delete.idempotent", async () => {
		await resolver.delete(at(target.changed, physicalId), transport);
		return [true, "second delete succeeded"];
	});
	await check(record, "instances.typed", async () => {
		try {
			const listed = await resolver.instances(transport, target.credentialRef);
			return [true, `${listed.length} instances`];
		} catch (error) {
			if (error instanceof ResolverComponentError && error.componentCode === "component.guest-unsupported")
				return [true, "typed refusal: unsupported"];
			throw error;
		}
	});
	return report(target, checks);
}

async function check(
	record: (id: ConformanceCheckId, passed: boolean, detail: string) => void,
	id: ConformanceCheckId,
	run: () => Promise<readonly [boolean, string]>,
): Promise<void> {
	try {
		const [passed, detail] = await run();
		record(id, passed, detail);
	} catch (error) {
		record(id, false, error instanceof Error ? error.message : "threw");
	}
}

function report(
	target: ConformanceTarget,
	checks: ReadonlyMap<ConformanceCheckId, ConformanceCheckRecord>,
): ConformanceReportRecord {
	const ordered = CONFORMANCE_CHECKS.map(
		(id) =>
			checks.get(id) ??
			create(ConformanceCheckRecordSchema, { id, passed: false, detail: "not reached" }),
	);
	return create(ConformanceReportRecordSchema, {
		componentId: target.component.verified.manifest.id,
		version: target.component.verified.manifest.version,
		wasmDigest: target.component.verified.wasmDigest,
		passed: ordered.every((entry) => entry.passed),
		checks: ordered,
	});
}

/** Failed check ids of a report, sorted (for assertions and CLIs). */
export function failedChecks(report: ConformanceReportRecord): readonly string[] {
	return Object.freeze(
		report.checks.filter((entry) => !entry.passed).map((entry) => entry.id).sort(compare),
	);
}

