import type { MigrationJournal } from "./facts.js";
import type { EngineBinding } from "./spi.js";

export class InjectedCrash extends Error {
	constructor(at: string) {
		super(`process died at ${at}`);
		this.name = "InjectedCrash";
	}
}

export const CRASH_MODES = ["before", "after"] as const;
export type CrashMode = (typeof CRASH_MODES)[number];

export interface CrashPoint {
	readonly occurrence: number;
	readonly effect?: string;
	readonly mode: CrashMode;
}

export class CrashInjector {
	calls = 0;
	dead = false;
	readonly trace: string[] = [];
	readonly #point: CrashPoint | undefined;
	#matched = 0;

	constructor(point?: CrashPoint) {
		this.#point = point;
	}

	#due(name: string): boolean {
		const point = this.#point;
		if (point === undefined) return false;
		if (point.effect !== undefined && point.effect !== name) return false;
		this.#matched += 1;
		return this.#matched === point.occurrence;
	}

	async effect<T>(name: string, action: () => T | Promise<T>): Promise<T> {
		if (this.dead) throw new InjectedCrash(name);
		this.calls += 1;
		this.trace.push(name);
		if (!this.#due(name)) return action();
		if (this.#point?.mode === "after") await action();
		this.dead = true;
		throw new InjectedCrash(name);
	}

	async read<T>(name: string, action: () => T | Promise<T>): Promise<T> {
		if (this.dead) throw new InjectedCrash(name);
		return action();
	}

	counts(): ReadonlyMap<string, number> {
		const counts = new Map<string, number>();
		for (const name of this.trace) {
			counts.set(name, (counts.get(name) ?? 0) + 1);
		}
		return counts;
	}
}

export function crashingBinding(
	binding: EngineBinding,
	side: string,
	injector: CrashInjector,
): EngineBinding {
	const { snapshot, capture, apply, verify, fence, retire, nativeTransfer } =
		binding;
	const at = (name: string) => `${side}.${name}`;
	return {
		declaration: binding.declaration,
		datasets: {
			ensureDataset: (schema) =>
				injector.effect(at("datasets.ensure"), () =>
					binding.datasets.ensureDataset(schema),
				),
			describeDataset: (name) =>
				injector.read(at("datasets.describe"), () =>
					binding.datasets.describeDataset(name),
				),
		},
		records: {
			write: (request) =>
				injector.effect(at("records.write"), () =>
					binding.records.write(request),
				),
			read: (request) =>
				injector.read(at("records.read"), () => binding.records.read(request)),
		},
		...(snapshot === undefined
			? undefined
			: {
					snapshot: {
						openSnapshot: (request) =>
							injector.read(at("snapshot.open"), () =>
								snapshot.openSnapshot(request),
							),
					},
				}),
		...(capture === undefined
			? undefined
			: {
					capture: {
						start: (request) =>
							injector.effect(at("capture.start"), () =>
								capture.start(request),
							),
						read: (request) =>
							injector.read(at("capture.read"), () => capture.read(request)),
						acknowledge: (request) =>
							injector.read(at("capture.acknowledge"), () =>
								capture.acknowledge(request),
							),
						stop: (subscription) =>
							injector.effect(at("capture.stop"), () =>
								capture.stop(subscription),
							),
					},
				}),
		...(apply === undefined
			? undefined
			: {
					apply: {
						apply: (request) =>
							injector.effect(at("apply"), () => apply.apply(request)),
						watermark: (request) =>
							injector.read(at("apply.watermark"), () =>
								apply.watermark(request),
							),
					},
				}),
		...(verify === undefined
			? undefined
			: {
					verify: {
						digest: (request) =>
							injector.read(at("verify.digest"), () => verify.digest(request)),
					},
				}),
		...(fence === undefined
			? undefined
			: {
					fence: {
						raise: (request) =>
							injector.effect(at("fence.raise"), () => fence.raise(request)),
						release: (request) =>
							injector.effect(at("fence.release"), () =>
								fence.release(request),
							),
						status: (scope) =>
							injector.read(at("fence.status"), () => fence.status(scope)),
					},
				}),
		...(retire === undefined
			? undefined
			: {
					retire: {
						retire: (request) =>
							injector.effect(at("retire"), () => retire.retire(request)),
					},
				}),
		...(nativeTransfer === undefined
			? undefined
			: {
					nativeTransfer: {
						profiles: nativeTransfer.profiles,
						publish: (request) =>
							injector.effect(at("native.publish"), () =>
								nativeTransfer.publish(request),
							),
						subscribe: (request) =>
							injector.effect(at("native.subscribe"), () =>
								nativeTransfer.subscribe(request),
							),
						seeded: (request) =>
							injector.read(at("native.seeded"), () =>
								nativeTransfer.seeded(request),
							),
						mark: (request) =>
							injector.read(at("native.mark"), () =>
								nativeTransfer.mark(request),
							),
						reached: (request) =>
							injector.read(at("native.reached"), () =>
								nativeTransfer.reached(request),
							),
						pause: (request) =>
							injector.effect(at("native.pause"), () =>
								nativeTransfer.pause(request),
							),
						resume: (request) =>
							injector.effect(at("native.resume"), () =>
								nativeTransfer.resume(request),
							),
						stop: (request) =>
							injector.effect(at("native.stop"), () =>
								nativeTransfer.stop(request),
							),
					},
				}),
		close: () => binding.close(),
	};
}

export function crashingJournal(
	journal: MigrationJournal,
	injector: CrashInjector,
): MigrationJournal {
	return {
		load: (migrationId) =>
			injector.read("journal.load", () => journal.load(migrationId)),
		append: (migrationId, fact, expectedCount) =>
			injector.effect(
				`journal.append ${fact.type.replace("migration.", "")}`,
				() => journal.append(migrationId, fact, expectedCount),
			),
	};
}
