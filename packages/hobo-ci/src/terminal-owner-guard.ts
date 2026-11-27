import { AsyncLocalStorage } from "node:async_hooks";
import { realpathSync, statSync } from "node:fs";
import path from "node:path";

import type { OwnerSettingsStore } from "./owner-channel.js";
import {
	OwnerWriteGuardUnavailableError,
	ownerWriteGuard,
} from "./owner-write-guard.js";

export type TerminalOwnerWriteProtocol = Pick<
	OwnerSettingsStore,
	"assertCurrent" | "runStoreWrite" | "recordStoreChange" | "markUncertainWrite"
>;

const writing = new AsyncLocalStorage<ReadonlyMap<string, string>>();
const queues = new Map<string, Promise<void>>();

function canonicalProject(cwd: string): string {
	try {
		const resolved = path.resolve(cwd);
		const project = realpathSync(resolved);
		if (project !== resolved || !statSync(project).isDirectory())
			throw new OwnerWriteGuardUnavailableError();
		return project;
	} catch (error) {
		if (error instanceof OwnerWriteGuardUnavailableError) throw error;
		throw new OwnerWriteGuardUnavailableError();
	}
}

function enqueue<T>(scope: string, operation: () => Promise<T>): Promise<T> {
	const previous = queues.get(scope) ?? Promise.resolve();
	const run = previous.then(operation, operation);
	const settled = run.then(
		() => undefined,
		() => undefined,
	);
	queues.set(scope, settled);
	void settled.then(() => {
		if (queues.get(scope) === settled) queues.delete(scope);
	});
	return run;
}

export function terminalOwnerWriteProtocol(
	family: "ci" | "cd",
	cwd: string,
): TerminalOwnerWriteProtocol {
	let unavailable = false;
	let bound:
		| {
				readonly scope: string;
				readonly guard: ReturnType<typeof ownerWriteGuard>;
		  }
		| undefined;
	const bind = () => {
		if (unavailable) throw new OwnerWriteGuardUnavailableError();
		if (bound) return bound;
		try {
			const project = canonicalProject(cwd);
			const scope = `${family}\u0000${project}`;
			bound = { scope, guard: ownerWriteGuard(scope, project) };
			return bound;
		} catch (error) {
			unavailable = true;
			if (error instanceof OwnerWriteGuardUnavailableError) throw error;
			throw new OwnerWriteGuardUnavailableError();
		}
	};
	return {
		assertCurrent() {
			let current: ReturnType<typeof bind>;
			try {
				current = bind();
			} catch (error) {
				if (error instanceof OwnerWriteGuardUnavailableError) {
					unavailable = true;
					return;
				}
				throw error;
			}
			if (writing.getStore()?.has(current.scope)) return;
			try {
				current.guard.assertClear();
			} catch (error) {
				if (error instanceof OwnerWriteGuardUnavailableError) {
					unavailable = true;
					return;
				}
				throw error;
			}
		},
		recordStoreChange() {
			const current = bind();
			const nonce = writing.getStore()?.get(current.scope);
			if (nonce === undefined) throw new Error("No active owner store write.");
			current.guard.advanceSettingsRevision(
				current.guard.currentSelection().generation,
				nonce,
			);
		},
		markUncertainWrite() {
			try {
				bind().guard.markUncertain();
			} catch (error) {
				if (!(error instanceof OwnerWriteGuardUnavailableError)) throw error;
			}
		},
		runStoreWrite<T>(operation: () => Promise<T>): Promise<T> {
			let current: ReturnType<typeof bind>;
			try {
				current = bind();
			} catch (error) {
				if (error instanceof OwnerWriteGuardUnavailableError)
					unavailable = true;
				throw error;
			}
			if (writing.getStore()?.has(current.scope)) return operation();
			return enqueue(current.scope, async () => {
				if (unavailable) throw new OwnerWriteGuardUnavailableError();
				const selected = current.guard.currentSelection();
				return current.guard.run(
					(nonce) => {
						const next = new Map(writing.getStore() ?? []);
						next.set(current.scope, nonce);
						return writing.run(next, operation);
					},
					() => false,
					selected.generation,
				);
			});
		},
	};
}
