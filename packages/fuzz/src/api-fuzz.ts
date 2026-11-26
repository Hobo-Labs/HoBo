/**
 * In-process control-plane request oracle. Schemathesis/RESTler wrap the
 * same fail-closed rules against an ephemeral server; this stays in-memory.
 */

import type { FuzzValue } from "./manifest.js";
import { hasPrototypePollution } from "./manifest.js";
import type { ControlModel } from "./model.js";

export interface FuzzRequest {
	readonly method: string;
	readonly path: string;
	readonly tenantId?: string;
	readonly body?: FuzzValue;
}

export interface FuzzResponse {
	readonly status: number;
	readonly body: Record<string, FuzzValue | ResourceResponse[]>;
}

type ResourceResponse = {
	readonly id: string;
	readonly bindleId: string;
	readonly idempotencyKey: string;
	readonly status: string;
};

export function handleControlRequest(
	world: ControlModel,
	req: FuzzRequest,
): FuzzResponse {
	if (req.body !== undefined && hasPrototypePollution(req.body)) {
		return fail(400, "prototype-pollution");
	}
	const tenantId = req.tenantId?.trim() ?? "";
	if (tenantId.length === 0) {
		return fail(403, "tenant-required");
	}

	const applyMatch = req.path.match(/^\/v1\/bindles\/([^/]+)\/apply$/);
	const destroyMatch = req.path.match(/^\/v1\/bindles\/([^/]+)\/destroy$/);
	const tenantMatch = req.path.match(/^\/v1\/tenants\/([^/]+)\/resources$/);

	if (req.method === "POST" && req.path === "/v1/bindles") {
		const rec = asRecord(req.body);
		const bindleId = stringField(rec, "bindleId");
		const manifestHash = stringField(rec, "manifestHash");
		if (!bindleId || !manifestHash) return fail(400, "invalid-bindle");
		const created = world.createBindle(tenantId, bindleId, manifestHash);
		if (!created.ok) return fail(409, created.reason);
		return ok({ bindleId, tenantId });
	}

	if (req.method === "POST" && applyMatch) {
		const bindleId = applyMatch[1] ?? "";
		const owned = world.bindles.get(bindleId);
		if (!owned) return fail(404, "bindle-missing");
		if (owned.tenantId !== tenantId) return fail(403, "cross-tenant");
		const rec = asRecord(req.body);
		const idempotencyKey = stringField(rec, "idempotencyKey");
		if (!idempotencyKey) return fail(400, "idempotency-required");
		const resource = world.apply(tenantId, bindleId, idempotencyKey);
		return ok({ id: resource.id, idempotencyKey, status: resource.status });
	}

	if (req.method === "POST" && destroyMatch) {
		const destroyed = world.destroy(tenantId, destroyMatch[1] ?? "");
		if (!destroyed.ok) return fail(403, destroyed.reason);
		return ok({ destroyed: true });
	}

	if (req.method === "GET" && tenantMatch) {
		const requested = tenantMatch[1] ?? "";
		if (requested !== tenantId) return fail(403, "cross-tenant");
		return ok({
			resources: [...world.resources.values()]
				.filter(
					(row) => row.tenantId === tenantId && row.status !== "destroyed",
				)
				.map((row) => ({
					id: row.id,
					bindleId: row.bindleId,
					idempotencyKey: row.idempotencyKey,
					status: row.status,
				})),
		});
	}

	return fail(404, "not-found");
}

function ok(
	body: Record<string, FuzzValue | ResourceResponse[]>,
): FuzzResponse {
	return { status: 200, body: { ok: true, ...body } };
}

function fail(status: number, code: string): FuzzResponse {
	return { status, body: { ok: false, code } };
}

function asRecord(value: FuzzValue | undefined): Record<string, FuzzValue> {
	if (!value || Object(value) !== value || Array.isArray(value)) return {};
	// SAFETY: Object identity and the array exclusion establish a record input.
	return value as Record<string, FuzzValue>;
}

function stringField(
	record: Record<string, FuzzValue>,
	key: string,
): string | undefined {
	const value = record[key];
	if (value?.constructor !== String || value.length === 0) return undefined;
	// SAFETY: String constructor identity establishes the primitive string contract.
	return value as string;
}
