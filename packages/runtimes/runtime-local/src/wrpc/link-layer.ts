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
	WireVersionIncompatibleError,
	type WrpcLinkPort,
	type WrpcTransport,
} from "@hobo/core";
import {
	DeadlineExceededError,
	MembraneBackpressureError,
} from "../failure/taxonomy.js";
import { isJsonObject, isJsonString, type JsonValue } from "../json.js";
import { createInProcessTransport } from "./in-process-transport.js";
import { negotiateWireVersion } from "./wire-version.js";

/**
 * A monotonic-enough source of wall-clock milliseconds, injectable so tests
 * can drive deadline enforcement deterministically. Defaults to `Date.now`.
 */
export interface LinkClock {
	nowMs(): number;
}

const DEFAULT_LINK_CLOCK: LinkClock = { nowMs: () => Date.now() };

/**
 * Race a link invocation against its carried deadline. A call that settles
 * before the remaining budget elapses wins (synchronous/fast providers resolve
 * on the microtask queue and beat even a zero-length timer); a slow provider
 * loses to the timer and is cancelled with a typed {@link DeadlineExceededError}.
 * The losing invocation's settlement is consumed so it never leaks as an
 * unhandled rejection.
 */
function raceDeadline<T>(
	work: Promise<T>,
	remainingMs: number,
	makeError: () => DeadlineExceededError,
): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		let settled = false;
		const timer = setTimeout(() => {
			if (settled) {
				return;
			}
			settled = true;
			reject(makeError());
		}, remainingMs);
		if (isJsonObject(timer) && timer && timer.unref instanceof Function) {
			timer.unref();
		}
		work.then(
			(value) => {
				if (settled) {
					return;
				}
				settled = true;
				clearTimeout(timer);
				resolve(value);
			},
			(error: Error) => {
				if (settled) {
					return;
				}
				settled = true;
				clearTimeout(timer);
				reject(error);
			},
		);
	});
}

function parseDeadlineMs(iso: string): number | null {
	const ms = Date.parse(iso);
	return Number.isNaN(ms) ? null : ms;
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
	/**
	 * Membrane backpressure bound: the maximum number of concurrent in-flight
	 * calls per provider before the link sheds load with a typed
	 * {@link MembraneBackpressureError}. Defaults to unbounded (carry-only).
	 */
	maxInFlight?: number;
	/** Clock used to enforce carried deadlines. Defaults to `Date.now`. */
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

			// Membrane backpressure: a saturated provider sheds load with a
			// typed retryable error rather than buffering unboundedly.
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

			// Each link is a timeout boundary: a carried deadline is enforced,
			// not merely propagated. A call still in flight past the deadline is
			// cancelled with a typed `cancelled`/deadline-exceeded error.
			const deadlineIso = options.deadline ?? null;
			const deadlineMs =
				deadlineIso !== null ? parseDeadlineMs(deadlineIso) : null;
			const startedAtMs = clock.nowMs();

			inFlight.set(providerId, current + 1);
			try {
				const invocation = transport.invoke({
					link,
					operation,
					payload,
					deadline: deadlineIso,
				});

				const result =
					deadlineMs !== null
						? await raceDeadline(
								invocation,
								Math.max(0, deadlineMs - startedAtMs),
								() =>
									new DeadlineExceededError({
										componentId,
										importInterface: parsedInterface,
										operation,
										// SAFETY: assertion to `deadlineIso as string` is required at this boundary.
										deadline: deadlineIso as string,
										deadlineMs,
										observedNowMs: startedAtMs,
									}),
							)
						: await invocation;

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
			} finally {
				inFlight.set(providerId, (inFlight.get(providerId) ?? 1) - 1);
			}
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
