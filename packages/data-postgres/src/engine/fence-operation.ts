/** A durable source-side lock around a destination receiver's route operation. */
import { createHash, createPublicKey, KeyObject, verify } from "node:crypto";
import {
	canonicalFenceOperationReceipt,
	DataCoreError,
	type DatasetScope,
	type FenceOperationClaim,
	type FenceOperationPort,
	fenceTokenDigest,
} from "@hobo/data-core";
import type { PostgresExecutor } from "./executor.js";
import type { DatasetStore } from "./store.js";

export type FenceOperationReceiverKeys = ReadonlyMap<
	string,
	string | Buffer | KeyObject
>;

/**
 * The keys must come from independently authenticated enrollment. The first
 * claim fixes the exact key set in the source database; changing it needs an
 * independently authorized key-rotation protocol, which is not provided here.
 */
export function createFenceOperationPort(
	store: DatasetStore,
	input: FenceOperationReceiverKeys | undefined,
): FenceOperationPort | undefined {
	if (!input?.size) return undefined;
	const keys = new Map(
		[...input].map(([id, value]) => {
			const key = value instanceof KeyObject ? value : createPublicKey(value);
			if (
				!id ||
				id.length > 512 ||
				id !== id.trim() ||
				/\p{Cc}/u.test(id) ||
				key.type !== "public" ||
				key.asymmetricKeyType !== "ed25519"
			) {
				throw new Error("invalid native fence receiver enrollment");
			}
			return [
				id,
				{
					key,
					digest: createHash("sha256")
						.update(key.export({ type: "spki", format: "der" }))
						.digest("hex"),
				},
			] as const;
		}),
	);
	const conflict = (message: string) =>
		new DataCoreError("FENCE_OPERATION_CONFLICT", message);
	const untrusted = () =>
		new DataCoreError(
			"FENCE_OPERATION_UNTRUSTED",
			"native fence operation receipt is untrusted",
		);
	const lockDataset = async (
		tx: PostgresExecutor,
		dataset: string,
	): Promise<void> => {
		const result = await tx.query(
			`UPDATE ${store.meta("datasets")} SET fence_epoch = fence_epoch + 1 WHERE dataset = $1::text RETURNING dataset`,
			[dataset],
		);
		if (!result.rows.length) throw conflict("native fence dataset is missing");
	};
	const checkPolicy = async (
		tx: PostgresExecutor,
		create: boolean,
	): Promise<void> => {
		await tx.query(
			"SELECT pg_advisory_xact_lock(hashtext($1::text))::text AS locked",
			[`hobo-data-fence-policy:${store.namespace}`],
		);
		const policy = await tx.query(
			`SELECT id::text AS id FROM ${store.meta("fencePolicy")} WHERE id = 1`,
		);
		if (!policy.rows.length) {
			if (!create) throw untrusted();
			await tx.query(
				`INSERT INTO ${store.meta("fencePolicy")} (id) VALUES (1)`,
			);
			for (const [id, receiver] of keys) {
				await tx.query(
					`INSERT INTO ${store.meta("fenceReceivers")} (key_id, key_digest) VALUES ($1::text, $2::text)`,
					[id, receiver.digest],
				);
			}
			return;
		}
		const enrolled = await tx.query(
			`SELECT key_id, key_digest FROM ${store.meta("fenceReceivers")}`,
		);
		if (
			enrolled.rows.length !== keys.size ||
			enrolled.rows.some(
				(row) => !row.key_id || keys.get(row.key_id)?.digest !== row.key_digest,
			)
		) {
			throw conflict(
				"native fence receiver policy differs from its durable enrollment",
			);
		}
	};
	const token = async (
		tx: PostgresExecutor,
		scope: DatasetScope,
	): Promise<string | undefined> => {
		const found = await tx.query(
			`SELECT token FROM ${store.meta("fences")} WHERE dataset = $1::text AND tenant = $2::text`,
			[scope.dataset, scope.tenant],
		);
		return found.rows[0]?.token ?? undefined;
	};
	const operation = async (
		tx: PostgresExecutor,
		scope: DatasetScope,
		id: string,
	) => {
		const found = await tx.query(
			`SELECT route_digest, receiver_key_id, receiver_key_digest, fence_token_digest, status FROM ${store.meta("fenceOperations")} WHERE dataset = $1::text AND tenant = $2::text AND operation_id = $3::text`,
			[scope.dataset, scope.tenant, id],
		);
		return found.rows[0];
	};
	return {
		async claim(request): Promise<FenceOperationClaim> {
			const receiver = keys.get(request.receiverKeyId);
			if (!receiver) throw untrusted();
			const claim: FenceOperationClaim = Object.freeze({
				scope: Object.freeze({ ...request.scope }),
				operationId: request.operationId,
				routeDigest: request.routeDigest,
				receiverKeyId: request.receiverKeyId,
				fenceTokenDigest: fenceTokenDigest(request.fenceToken),
			});
			canonicalFenceOperationReceipt({
				...claim,
				contract: "hobo.fence-operation-receipt/v1",
				outcome: "committed",
			});
			await store.dataset(claim.scope.dataset);
			return store.executor.transaction(async (tx) => {
				await tx.query("SET TRANSACTION ISOLATION LEVEL READ COMMITTED");
				await checkPolicy(tx, true);
				await lockDataset(tx, claim.scope.dataset);
				if ((await token(tx, claim.scope)) !== request.fenceToken)
					throw new DataCoreError(
						"FENCE_TOKEN_MISMATCH",
						"native fence token is no longer current",
					);
				const prior = await operation(tx, claim.scope, claim.operationId);
				if (prior) {
					if (
						prior.status !== "held" ||
						prior.route_digest !== claim.routeDigest ||
						prior.receiver_key_id !== claim.receiverKeyId ||
						prior.receiver_key_digest !== receiver.digest ||
						prior.fence_token_digest !== claim.fenceTokenDigest
					)
						throw conflict("native fence operation identity was already used");
					return claim;
				}
				await store.assertNoFenceOperation(tx, claim.scope);
				await tx.query(
					`INSERT INTO ${store.meta("fenceOperations")} (dataset, tenant, operation_id, route_digest, receiver_key_id, receiver_key_digest, fence_token_digest, status) VALUES ($1::text, $2::text, $3::text, $4::text, $5::text, $6::text, $7::text, 'held')`,
					[
						claim.scope.dataset,
						claim.scope.tenant,
						claim.operationId,
						claim.routeDigest,
						claim.receiverKeyId,
						receiver.digest,
						claim.fenceTokenDigest,
					],
				);
				return claim;
			});
		},
		async complete(receipt): Promise<void> {
			const { signature, ...body } = receipt;
			const canonical = canonicalFenceOperationReceipt(body);
			const receiver = keys.get(receipt.receiverKeyId);
			if (
				!receiver ||
				!/^[A-Za-z0-9_-]{86}$/u.test(signature) ||
				Buffer.from(signature, "base64url").toString("base64url") !==
					signature ||
				!verify(
					null,
					Buffer.from(canonical),
					receiver.key,
					Buffer.from(signature, "base64url"),
				)
			)
				throw untrusted();
			await store.dataset(receipt.scope.dataset);
			await store.executor.transaction(async (tx) => {
				await tx.query("SET TRANSACTION ISOLATION LEVEL READ COMMITTED");
				await checkPolicy(tx, false);
				await lockDataset(tx, receipt.scope.dataset);
				const row = await operation(tx, receipt.scope, receipt.operationId);
				if (
					!row ||
					row.route_digest !== receipt.routeDigest ||
					row.receiver_key_id !== receipt.receiverKeyId ||
					row.receiver_key_digest !== receiver.digest ||
					row.fence_token_digest !== receipt.fenceTokenDigest
				)
					throw conflict("native fence operation receipt has a foreign scope");
				if (row.status === "completed") return;
				const current = await token(tx, receipt.scope);
				if (
					row.status !== "held" ||
					!current ||
					fenceTokenDigest(current) !== receipt.fenceTokenDigest
				)
					throw new DataCoreError(
						"FENCE_TOKEN_MISMATCH",
						"native fence changed before operation completion",
					);
				await tx.query(
					`UPDATE ${store.meta("fenceOperations")} SET status = 'completed' WHERE dataset = $1::text AND tenant = $2::text AND operation_id = $3::text AND status = 'held'`,
					[receipt.scope.dataset, receipt.scope.tenant, receipt.operationId],
				);
			});
		},
		async inspect(scope, operationId) {
			await store.dataset(scope.dataset);
			const result =
				operationId === undefined
					? await store.executor.query(
							`SELECT operation_id, route_digest, receiver_key_id, fence_token_digest, status FROM ${store.meta("fenceOperations")} WHERE dataset = $1::text AND tenant = $2::text AND status = 'held'`,
							[scope.dataset, scope.tenant],
						)
					: await store.executor.query(
							`SELECT operation_id, route_digest, receiver_key_id, fence_token_digest, status FROM ${store.meta("fenceOperations")} WHERE dataset = $1::text AND tenant = $2::text AND operation_id = $3::text`,
							[scope.dataset, scope.tenant, operationId],
						);
			const row = result.rows[0];
			if (!row) return undefined;
			if (
				!row.operation_id ||
				!row.route_digest ||
				!row.receiver_key_id ||
				!row.fence_token_digest ||
				(row.status !== "held" && row.status !== "completed")
			)
				throw conflict("native fence operation is malformed");
			return Object.freeze({
				status: row.status,
				claim: Object.freeze({
					scope: Object.freeze({ ...scope }),
					operationId: row.operation_id,
					routeDigest: row.route_digest,
					receiverKeyId: row.receiver_key_id,
					fenceTokenDigest: row.fence_token_digest,
				}),
			});
		},
	};
}
