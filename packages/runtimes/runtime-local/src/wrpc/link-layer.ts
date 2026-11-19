import { AsyncLocalStorage } from "node:async_hooks";
import {
	type ComponentRegistration,
	type EstablishedLink,
	type LinkRequest,
	linkKey,
	type MembraneEvent,
	NoRouteError,
	ProviderHandlerStore,
	type ProviderRegistration,
	parseInterfaceId,
	parseWireVersion,
	type TransportInvocation,
	WireVersionIncompatibleError,
	type WrpcLinkPort,
	type WrpcTransport,
} from "@hobo/core";
import {
	DeadlineExceededError,
	MembraneBackpressureError,
	RuntimeMembraneError,
} from "../failure/taxonomy.js";
import { isJsonObject, isJsonString, type JsonValue } from "../json.js";
import { createInProcessTransport } from "./in-process-transport.js";
import { negotiateWireVersion } from "./wire-version.js";

export interface LinkClock {
	nowMs(): number;
}

const DEFAULT_LINK_CLOCK: LinkClock = { nowMs: () => Date.now() };
const MAX_TIMER_MS = 2_147_483_647;
const activeDeadline = new AsyncLocalStorage<{
	readonly iso: string;
	readonly milliseconds: number;
}>();

function raceDeadline<T>(
	work: Promise<T>,
	deadlineMs: number,
	clock: LinkClock,
	makeError: (observedNowMs: number) => DeadlineExceededError,
	abort: AbortController,
): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		let settled = false;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const fail = (error: RuntimeMembraneError) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			abort.abort(error);
			reject(error);
		};
		const schedule = () => {
			if (settled) return;
			let observedNowMs: number;
			try {
				observedNowMs = checkedNow(clock);
			} catch {
				fail(new RuntimeMembraneError("fatal", "wrpc.invalid_clock"));
				return;
			}
			const remaining = deadlineMs - observedNowMs;
			if (remaining <= 0) {
				fail(makeError(observedNowMs));
				return;
			}
			timer = setTimeout(schedule, Math.min(remaining, MAX_TIMER_MS));
		};
		schedule();
		const finish = (complete: () => void) => {
			if (settled) return;
			try {
				const observedNowMs = checkedNow(clock);
				if (observedNowMs >= deadlineMs) {
					fail(makeError(observedNowMs));
					return;
				}
			} catch {
				fail(new RuntimeMembraneError("fatal", "wrpc.invalid_clock"));
				return;
			}
			settled = true;
			clearTimeout(timer);
			complete();
		};
		work.then(
			(value) => finish(() => resolve(value)),
			(error: Error) => finish(() => reject(error)),
		);
	});
}

function parseDeadlineMs(iso: string): number {
	if (!isJsonString(iso) || iso.length > 128)
		throw new RuntimeMembraneError("fatal", "wrpc.invalid_deadline");
	const match =
		/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(?:Z|[+-](\d{2}):(\d{2}))$/u.exec(
			iso,
		);
	if (!match) throw new RuntimeMembraneError("fatal", "wrpc.invalid_deadline");
	const year = Number(match[1]);
	const month = Number(match[2]);
	const day = Number(match[3]);
	const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
	const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
	if (
		month < 1 ||
		month > 12 ||
		day < 1 ||
		day > (days[month - 1] ?? 0) ||
		Number(match[4]) > 23 ||
		Number(match[5]) > 59 ||
		Number(match[6]) > 59 ||
		Number(match[8] ?? 0) > 23 ||
		Number(match[9] ?? 0) > 59
	) {
		throw new RuntimeMembraneError("fatal", "wrpc.invalid_deadline");
	}
	const ms = Date.parse(iso);
	if (!Number.isFinite(ms))
		throw new RuntimeMembraneError("fatal", "wrpc.invalid_deadline");
	return ms;
}

function checkedNow(clock: LinkClock): number {
	let now: number;
	try {
		now = clock.nowMs();
	} catch {
		throw new RuntimeMembraneError("fatal", "wrpc.invalid_clock");
	}
	if (!Number.isFinite(now))
		throw new RuntimeMembraneError("fatal", "wrpc.invalid_clock");
	return now;
}

type IndexedPins = Map<
	string,
	| ComponentRegistration["imports"][number]
	| ProviderRegistration["exports"][number]
>;

function indexPins(
	pins: ComponentRegistration["imports"] | ProviderRegistration["exports"],
): IndexedPins {
	const indexed: IndexedPins = new Map();
	for (const pin of pins) {
		indexed.set(pin.interfaceId, pin);
	}
	return indexed;
}

function assertId(id: string | undefined, kind: string): asserts id is string {
	if (!isJsonString(id) || id.length === 0) {
		throw new Error(`wrpc.${kind}_id_required`);
	}
}

export function createWrpcLinkLayer(options: {
	transport: WrpcTransport;
	compatibilityFloor: string;
	store?: ProviderHandlerStore;
	maxInFlight?: number;
	clock?: LinkClock;
}): WrpcLinkPort {
	const floor = parseWireVersion(options.compatibilityFloor);
	const store = options.store ?? new ProviderHandlerStore();
	const transport = options.transport;
	const maxInFlight = options.maxInFlight ?? Number.POSITIVE_INFINITY;
	const clock = options.clock ?? DEFAULT_LINK_CLOCK;
	const inFlight = new Map<string, number>();
	const codec =
		"codec" in transport && isJsonObject(transport.codec)
			? transport.codec
			: undefined;
	const codecName = isJsonString(codec?.name) ? codec.name : "unknown";

	const components = new Map<string, { id: string; imports: IndexedPins }>();
	const providers = new Map<string, { id: string; exports: IndexedPins }>();
	const links = new Map<string, EstablishedLink>();
	const events: MembraneEvent[] = [];

	return {
		registerComponent(component: ComponentRegistration) {
			assertId(component?.id, "component");
			components.set(component.id, {
				id: component.id,
				imports: indexPins(component.imports),
			});
		},

		registerProvider(provider: ProviderRegistration) {
			assertId(provider?.id, "provider");
			providers.set(provider.id, {
				id: provider.id,
				exports: indexPins(provider.exports),
			});
			store.register(provider);
		},

		manifestIr() {
			return {
				schema: "hobo.manifest.wrpc-links/v1",
				links: [...links.values()].map((link) => ({
					componentId: link.componentId,
					importInterface: link.importInterface,
					providerId: link.providerId,
					exportInterface: link.exportInterface,
					wire: { ...link.negotiatedWire },
				})),
			};
		},

		establishLink(request: LinkRequest): EstablishedLink {
			const component = components.get(request.componentId);
			if (!component) {
				throw new Error(
					`wrpc.component_not_registered: ${request.componentId}`,
				);
			}
			const provider = providers.get(request.providerId);
			if (!provider) {
				throw new Error(`wrpc.provider_not_registered: ${request.providerId}`);
			}

			const importInterface = parseInterfaceId(request.importInterface);
			const exportInterface = parseInterfaceId(request.exportInterface);
			const imported = component.imports.get(importInterface);
			const exported = provider.exports.get(exportInterface);
			if (!imported) {
				throw new Error(
					`wrpc.import_not_declared: ${request.componentId}:${importInterface}`,
				);
			}
			if (!exported) {
				throw new Error(
					`wrpc.export_not_found: ${request.providerId}:${exportInterface}`,
				);
			}

			try {
				const negotiatedWire = negotiateWireVersion({
					caller: imported,
					provider: exported,
					floor,
					componentId: request.componentId,
					providerId: request.providerId,
				});
				const link = Object.freeze({
					componentId: request.componentId,
					importInterface,
					providerId: request.providerId,
					exportInterface,
					transport: transport.kind,
					boundaryMode: "live" as const,
					negotiatedWire,
				});
				links.set(linkKey(request.componentId, importInterface), link);
				events.push({
					type: "link.Established",
					componentId: link.componentId,
					importInterface: link.importInterface,
					providerId: link.providerId,
					exportInterface: link.exportInterface,
					transport: link.transport,
					boundaryMode: link.boundaryMode,
					negotiatedWire: link.negotiatedWire,
				});
				return link;
			} catch (error) {
				if (error instanceof WireVersionIncompatibleError) {
					events.push({
						type: "link.Rejected",
						code: error.code,
						reason: error.reason,
						componentId: request.componentId,
						providerId: request.providerId,
						interfaceId: importInterface,
						floor: floor.raw,
					});
				}
				throw error;
			}
		},

		async callImport(
			componentId: string,
			importInterface: string,
			operation: string,
			payload: JsonValue = {},
			options: { deadline?: string | null } = {},
		) {
			if (!components.has(componentId)) {
				throw new Error(`wrpc.component_not_registered: ${componentId}`);
			}
			const parsedInterface = parseInterfaceId(importInterface);
			const link = links.get(linkKey(componentId, parsedInterface));
			if (!link) {
				throw new NoRouteError({
					componentId,
					importInterface: parsedInterface,
				});
			}

			let deadlineIso = options.deadline ?? null;
			let deadlineMs =
				deadlineIso === null ? null : parseDeadlineMs(deadlineIso);
			const parent = activeDeadline.getStore();
			if (
				parent &&
				(deadlineMs === null || parent.milliseconds <= deadlineMs)
			) {
				deadlineIso = parent.iso;
				deadlineMs = parent.milliseconds;
			}
			const startedAtMs = deadlineMs === null ? null : checkedNow(clock);
			if (
				deadlineIso !== null &&
				deadlineMs !== null &&
				startedAtMs !== null &&
				deadlineMs <= startedAtMs
			) {
				throw new DeadlineExceededError({
					componentId,
					importInterface: parsedInterface,
					operation,
					deadline: deadlineIso,
					deadlineMs,
					observedNowMs: startedAtMs,
				});
			}

			const providerId = link.providerId;
			const current = inFlight.get(providerId) ?? 0;
			if (current >= maxInFlight) {
				throw new MembraneBackpressureError({
					providerId,
					operation,
					importInterface: parsedInterface,
					maxInFlight,
					inFlight: current,
				});
			}

			inFlight.set(providerId, current + 1);
			const abort = new AbortController();
			const release = () => {
				const remaining = (inFlight.get(providerId) ?? 1) - 1;
				if (remaining === 0) inFlight.delete(providerId);
				else inFlight.set(providerId, remaining);
			};
			let invocation: Promise<JsonValue>;
			const transportInvocation: TransportInvocation = {
				link,
				operation,
				payload,
				deadline: deadlineIso,
			};
			if (transport.kind === "in-process") {
				transportInvocation.signal = abort.signal;
			}
			try {
				const invoke = () => transport.invoke(transportInvocation);
				invocation = Promise.resolve(
					deadlineIso !== null && deadlineMs !== null
						? activeDeadline.run(
								{ iso: deadlineIso, milliseconds: deadlineMs },
								invoke,
							)
						: invoke(),
				);
			} catch (error) {
				release();
				throw error;
			}
			const tracked = invocation.finally(release);

			const result =
				deadlineMs !== null && deadlineIso !== null
					? await raceDeadline(
							tracked,
							deadlineMs,
							clock,
							(observedNowMs) =>
								new DeadlineExceededError({
									componentId,
									importInterface: parsedInterface,
									operation,
									deadline: deadlineIso,
									deadlineMs,
									observedNowMs,
								}),
							abort,
						)
					: await tracked;

			events.push({
				type: "link.Called",
				componentId: link.componentId,
				importInterface: link.importInterface,
				providerId: link.providerId,
				exportInterface: link.exportInterface,
				operation,
				boundaryMode: link.boundaryMode,
				transport: link.transport,
				codec: codecName,
				deadline: deadlineIso,
			});
			return result;
		},

		get events() {
			return events;
		},
	};
}

export function createDefaultWrpcLinkLayer(
	compatibilityFloor: string,
): WrpcLinkPort {
	const store = new ProviderHandlerStore();
	const transport = createInProcessTransport({ store });
	return createWrpcLinkLayer({ transport, compatibilityFloor, store });
}
