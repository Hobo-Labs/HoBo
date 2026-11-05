import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import { BudgetAdmissionDeniedError } from "@hobo/broker";
import {
	type CiAsyncSharedBudgetHooks,
	type CiSharedBudgetHooks,
	createCiAsyncSharedBudgetHooks,
	createCiSharedBudgetHooks,
} from "@hobo/ci";
import { z } from "zod";

type SqliteOptions = Parameters<typeof createCiSharedBudgetHooks>[0];
type PostgresOptions = Parameters<typeof createCiAsyncSharedBudgetHooks>[0];
type Adapter =
	| {
			kind: "sqlite";
			options: SqliteOptions;
			close?: () => void | Promise<void>;
	  }
	| {
			kind: "postgres";
			options: PostgresOptions;
			close?: () => void | Promise<void>;
	  };
type AdapterModule = {
	createCiWorkerBudgetAdapter: (input: {
		kind: "sqlite" | "postgres";
	}) => Adapter | Promise<Adapter>;
};
const callable = z.function();
const denialCode = z.enum([
	"budget.exhausted",
	"provider.exhausted",
	"entitlement.exhausted",
	"policy.denied",
]);
const moduleSchema = z.object({ createCiWorkerBudgetAdapter: callable });
const closeSchema = z.object({ close: callable });
const adapterSchema = z.object({
	kind: z.enum(["sqlite", "postgres"]),
	options: z.object({
		quoteLease: callable,
		authority: z.object({
			persistence: z.literal("durable-cas"),
			read: callable,
			lookup: callable,
			reserve: callable,
			claimExecution: callable,
			uncertain: callable,
			settle: callable,
			release: callable,
		}),
	}),
	close: callable.optional(),
});

function redactOperationError(error: Error): never {
	// Preserve the original typed precommit denial so another offer may be tried.
	if (error instanceof BudgetAdmissionDeniedError) {
		const parsed = denialCode.safeParse(error.code);
		if (parsed.success)
			throw new BudgetAdmissionDeniedError(
				parsed.data,
				"CI budget admission denied",
			);
	}
	throw new Error("trusted CI budget operation failed");
}
function safeSync<T>(action: () => T): T {
	try {
		return action();
	} catch (error) {
		return redactOperationError(error instanceof Error ? error : new Error());
	}
}
async function safeAsync<T>(action: () => Promise<T>): Promise<T> {
	try {
		return await action();
	} catch (error) {
		return redactOperationError(error instanceof Error ? error : new Error());
	}
}
function safeSqliteHooks(hooks: CiSharedBudgetHooks): CiSharedBudgetHooks {
	return {
		reserve: (lease, measurements) =>
			safeSync(() => hooks.reserve(lease, measurements)),
		claim: (lease, measurements) =>
			safeSync(() => hooks.claim(lease, measurements)),
		uncertain: (lease) => safeSync(() => hooks.uncertain(lease)),
		settle: (lease, evidence) => safeSync(() => hooks.settle(lease, evidence)),
		releaseUnused: (lease, ref) =>
			safeSync(() => hooks.releaseUnused(lease, ref)),
	};
}
function safePostgresHooks(
	hooks: CiAsyncSharedBudgetHooks,
): CiAsyncSharedBudgetHooks {
	return {
		reserve: (lease, measurements) =>
			safeAsync(() => hooks.reserve(lease, measurements)),
		claim: (lease, measurements) =>
			safeAsync(() => hooks.claim(lease, measurements)),
		uncertain: (lease) => safeAsync(() => hooks.uncertain(lease)),
		settle: (lease, evidence) => safeAsync(() => hooks.settle(lease, evidence)),
		releaseUnused: (lease, ref) =>
			safeAsync(() => hooks.releaseUnused(lease, ref)),
	};
}

/** Operator-selected trusted code supplies a shared durable authority and native evidence.
 * Never load this path from a repository or job configuration. */
export async function loadWorkerBudgetAdapter(
	path: string | undefined,
	kind: "sqlite" | "postgres",
) {
	if (path === undefined) return undefined;
	if (!isAbsolute(path) || !/\.(?:mjs|js)$/u.test(path))
		throw new Error("invalid trusted CI budget adapter path");
	let adapter: Adapter | undefined;
	try {
		const module: AdapterModule = await import(
			/* @vite-ignore */ pathToFileURL(path).href
		);
		if (!moduleSchema.safeParse(module).success)
			throw new Error("missing factory");
		adapter = await module.createCiWorkerBudgetAdapter({ kind });
		if (!adapterSchema.safeParse(adapter).success || adapter.kind !== kind)
			throw new Error("invalid adapter");
		const authority = adapter.options.authority;
		// SQLite workers need synchronous durable hooks; distributed PostgreSQL
		// workers require the asynchronous shared authority contract.
		const probe = authority.read(new Date().toISOString());
		const asynchronous = probe instanceof Promise;
		if (asynchronous !== (kind === "postgres")) {
			if (asynchronous) await probe.catch(() => undefined);
			throw new Error("authority backend does not match worker store");
		}
		await probe;
		const close = async () => {
			try {
				await adapter?.close?.();
			} catch {
				throw new Error("trusted CI budget adapter cleanup failed");
			}
		};
		if (adapter.kind === "sqlite")
			return {
				kind: adapter.kind,
				hooks: safeSqliteHooks(createCiSharedBudgetHooks(adapter.options)),
				close,
			};
		return {
			kind: adapter.kind,
			hooks: safePostgresHooks(createCiAsyncSharedBudgetHooks(adapter.options)),
			close,
		};
	} catch {
		try {
			const closeable = closeSchema.safeParse(adapter);
			if (closeable.success) await closeable.data.close();
		} catch {
			// The operator adapter is trusted code; do not expose its errors or secrets.
		}
		throw new Error("trusted CI budget adapter could not be initialized");
	}
}
