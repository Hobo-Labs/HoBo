export const VERCEL_BLOB_EPHEMERAL_COST = Object.freeze({
	get: { simple: 1, advanced: 0, deletes: 0 },
	getMany: { simple: 1, advanced: 0, deletes: 0, perKey: true },
	putIfAbsent: { simple: 0, advanced: 1, deletes: 0 },
	"putIfAbsent.lost": { simple: 1, advanced: 1, deletes: 0 },
	"putIfAbsent.replacesExpired": { simple: 1, advanced: 2, deletes: 0 },
	compareAndSet: { simple: 1, advanced: 1, deletes: 0 },
	"compareAndSet.stale": { simple: 1, advanced: 0, deletes: 0 },
	delete: { simple: 1, advanced: 0, deletes: 1 },
	increment: { simple: 1, advanced: 1, deletes: 0 },
	expire: { simple: 1, advanced: 1, deletes: 0 },
	"lock.acquire": { simple: 0, advanced: 1, deletes: 0 },
	"lock.renew": { simple: 1, advanced: 1, deletes: 0 },
	"lock.release": { simple: 1, advanced: 0, deletes: 1 },
	"ring.append": { simple: 2, advanced: 2, deletes: 1 },
	"ring.read": { simple: 1, advanced: 0, deletes: 0, perKey: true },
	conflictRound: { simple: 1, advanced: 1, deletes: 0 },
	"purge.listPage": { simple: 0, advanced: 1, deletes: 0 },
} as const);

export type VercelBlobEphemeralOperation =
	keyof typeof VERCEL_BLOB_EPHEMERAL_COST;

export const VERCEL_BLOB_PRICING = Object.freeze({
	readOn: "2026-11-11",
	pro: {
		usdPerMillionSimpleOperations: 0.4,
		usdPerMillionAdvancedOperations: 5,
		usdPerGbMonthStorage: 0.023,
		monthlyCreditUsd: 20,
	},
	hobbyIncludedPerMonth: {
		simpleOperations: 10_000,
		advancedOperations: 2_000,
		storageGb: 1,
		dataTransferGb: 10,
	},
	rateLimitPerMinute: {
		hobby: { simple: 1_200, advanced: 900 },
		pro: { simple: 7_200, advanced: 4_500 },
	},
} as const);

export type VercelBlobOperationCounts = {
	readonly simple: number;
	readonly advanced: number;
	readonly deletes: number;
};

export function vercelBlobProOperationsUsd(
	counts: VercelBlobOperationCounts,
): number {
	const { pro } = VERCEL_BLOB_PRICING;
	return (
		(counts.simple / 1_000_000) * pro.usdPerMillionSimpleOperations +
		(counts.advanced / 1_000_000) * pro.usdPerMillionAdvancedOperations
	);
}
