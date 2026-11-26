import { readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import {
	type BrokerCatalog,
	BrokerParseError,
	type ConnectorRegistry,
	createBroker,
	createCedarGatePlane,
	createConnectorRegistry,
	createLocalHostCatalog,
	createOpaGatePlane,
	defaultLocalPolicySet,
	type FetchLike,
	type GatePlane,
	parseBrokerPolicySet,
	policyHashOf,
	REJECTION_MATRIX,
} from "@hobo/broker";
import type { CommandModule } from "@hobo/cli";
import { loadProjectManifest } from "@hobo/cli";
import { must } from "@hobo/core/total-access";
import { resolveStationContext } from "@hobo/stations";
import { defaultHoboHome } from "./bare-metal-yard.js";
import { loadHoboProfile } from "./hobo-profile.js";
import {
	cloneAsJson,
	isJsonString,
	type JsonObject,
	type JsonValue,
	parseJsonValue,
} from "./json.js";

/** Required Station + active Rail pins for every Conductor resolve. */
function requireStationPins(flags: JsonObject) {
	const home =
		isJsonString(flags.home) && flags.home.length > 0
			? flags.home
			: defaultHoboHome();
	const ctx = resolveStationContext({
		hoboHome: home,
		...(isJsonString(flags.station)
			? { stationFlag: flags.station }
			: undefined),
		...(isJsonString(process.env.HOBO_STATION)
			? { stationEnv: process.env.HOBO_STATION }
			: undefined),
		...(loadHoboProfile(home)?.defaultStation?.id !== undefined
			? {
					profileStationId: must(
						must(loadHoboProfile(home), "loadHoboProfile(home)").defaultStation,
						"loadHoboProfile(home)!.defaultStation",
					).id,
				}
			: undefined),
	});
	const pins = ctx.client.pins();
	return { stationId: pins.stationId, railHash: pins.railHash };
}

export interface BrokerCommandDeps {
	// The provider catalog resolutions run against when a cloud config is
	// supplied. The composed Yard runtime's PlannerRegistry satisfies this
	// structurally; tests inject fixtures.
	readonly catalog: BrokerCatalog;
	// Injectable for tests; defaults to global fetch for OPA/Cedar engines.
	readonly fetchFn?: FetchLike;
}

// The broker config document (`hobo.broker.json`): a BrokerPolicySet plus the
// engine and connector wiring the CLI assembles around it.
//   {
//     ...BrokerPolicySet (schemaVersion, brokerId, placementPolicies,
//        billing, delivery, requiredConnectorKinds)...,
//     "connectors":   [ConnectorConfig...],          // optional
//     "policyEngine": { "kind": "opa"|"cedar",       // optional; default is
//                       "endpoint": "http://...",    // the built-in policy
//                       "decisionPath": "..." },     // packs
//     "catalog": "registry" | "local-host"           // optional
//   }
// public-contract: the broker config artifact name projects commit and review.
export const BROKER_CONFIG_FILENAME = "hobo.broker.json";

interface AssembledBroker {
	source: "config" | "default-local";
	configPath?: string;
	policies: ReturnType<typeof parseBrokerPolicySet>;
	catalog: BrokerCatalog;
	catalogKind: "registry" | "local-host";
	connectors?: ConnectorRegistry;
	gatePlane?: GatePlane;
	engineKind: "builtin" | "opa" | "cedar";
}

function defaultFetch(): FetchLike {
	return async (url, init) => {
		const response = await fetch(url, init);
		return {
			status: response.status,
			json: async () => parseJsonValue(await response.text()),
		};
	};
}

async function readJson(path: string, what: string): Promise<JsonValue> {
	const raw = await readFile(path, "utf8");
	try {
		JSON.parse(raw);
	} catch {
		throw new BrokerParseError(
			"invalid-json",
			`invalid-json: ${what} at ${path} is not valid JSON`,
		);
	}
	return parseJsonValue(raw);
}

async function locateConfig(
	flags: JsonObject,
	projectDir: string,
): Promise<string | undefined> {
	const explicit = flags.config;
	if (isJsonString(explicit)) return explicit;
	const candidate = join(projectDir, BROKER_CONFIG_FILENAME);
	try {
		await readFile(candidate, "utf8");
		return candidate;
	} catch {
		return undefined;
	}
}

// Assemble the broker from a config document — or, with no cloud config
// supplied, from the built-in local lane: the running machine registered as
// a HoBo cloud provider host with a permissive default policy set.
async function assembleBroker(
	deps: BrokerCommandDeps,
	flags: JsonObject,
	projectDir: string,
): Promise<AssembledBroker> {
	const configPath = await locateConfig(flags, projectDir);
	if (configPath === undefined) {
		return {
			source: "default-local",
			policies: defaultLocalPolicySet(),
			catalog: createLocalHostCatalog(),
			catalogKind: "local-host",
			engineKind: "builtin",
		};
	}

	// SAFETY: assertion required at this I/O or test boundary.
	const raw = (await readJson(configPath, "broker config")) as JsonObject;
	const { connectors, policyEngine, catalog, ...policyDocument } = raw;
	const policies = parseBrokerPolicySet(policyDocument);

	const registry = Array.isArray(connectors)
		? createConnectorRegistry(connectors)
		: undefined;

	let gatePlane: GatePlane | undefined;
	let engineKind: AssembledBroker["engineKind"] = "builtin";
	if (policyEngine !== undefined && policyEngine !== null) {
		// SAFETY: assertion required at this I/O or test boundary.
		const engine = policyEngine as JsonObject;
		const endpoint = engine.endpoint;
		if (!isJsonString(endpoint) || endpoint.length === 0) {
			throw new BrokerParseError(
				"invalid-policy-engine",
				"invalid-policy-engine: policyEngine.endpoint must be a non-empty string",
			);
		}
		const fetchFn = deps.fetchFn ?? defaultFetch();
		const policyFetch = async (
			url: string,
			init?: {
				method?: string;
				headers?: { [k: string]: string };
				body?: string;
			},
		) => {
			const res = await fetchFn(url, {
				method: init?.method ?? "GET",
				headers: init?.headers ?? {},
				body: init?.body ?? "",
			});
			return {
				status: res.status,
				json: async () => cloneAsJson(await res.json()),
			};
		};
		if (engine.kind === "opa") {
			engineKind = "opa";
			gatePlane = createOpaGatePlane({
				endpoint,
				fetchFn: policyFetch,
				...(isJsonString(engine.decisionPath)
					? { decisionPath: engine.decisionPath }
					: undefined),
			});
		} else if (engine.kind === "cedar") {
			engineKind = "cedar";
			gatePlane = createCedarGatePlane({ endpoint, fetchFn: policyFetch });
		} else {
			throw new BrokerParseError(
				"invalid-policy-engine",
				`invalid-policy-engine: kind ${String(engine.kind)} is not opa|cedar`,
			);
		}
	}

	const catalogKind = catalog === "local-host" ? "local-host" : "registry";
	return {
		source: "config",
		configPath,
		policies,
		catalog:
			catalogKind === "local-host" ? createLocalHostCatalog() : deps.catalog,
		catalogKind,
		...(registry !== undefined ? { connectors: registry } : undefined),
		...(gatePlane !== undefined ? { gatePlane } : undefined),
		engineKind,
	};
}

// Derive the brokering request from the project's own bindle manifest when no
// --request document is supplied; a bare machine gets a smoke requirement.
async function deriveRequest(
	flags: JsonObject,
	projectDir: string,
): Promise<JsonValue> {
	const explicit = flags.request;
	if (isJsonString(explicit)) {
		return readJson(explicit, "broker request");
	}
	const manifest = await loadProjectManifest(projectDir);
	const requirements =
		manifest !== null
			? Object.entries(
					// SAFETY: assertion required at this I/O or test boundary.
					manifest.value.resources as Record<
						string,
						{ type: string; port?: string }
					>,
				).map(([name, resource]) => ({
					resourceId: name,
					port: resource.port ?? resource.type,
				}))
			: [{ resourceId: "app", port: "hobo:http-service" }];
	return {
		schemaVersion: "hobo.broker/v1",
		requestId: `req-broker-up-${Date.now().toString(36)}`,
		scope: { bindleId: `bindle:${basename(projectDir)}` },
		requirements,
		spendEstimateUsd: 0,
	};
}

// `hobo broker` — the broker (the Conductor) surfaced on the CLI.
//   hobo broker config [--init] [--config <file>]
//     Validate and summarize the broker configuration (policies, budgets,
//     connectors, policy engine); --init scaffolds hobo.broker.json.
//   hobo broker up [--config <file>] [--request <file>]
//     Assemble the broker from config and realize the request through the
//     full pipeline: resolve -> spin-up directives -> delivery handoff. With
//     NO cloud config supplied, the running machine is registered as a HoBo
//     cloud provider host (zero-cost local catalog) so the whole loop is
//     testable on a bare machine.
//   hobo broker resolve --policies <file> --request <file>
//     Run one resolution and print the receipt or the cataloged rejection.
//   hobo broker matrix
//     Print the closed rejection-code catalog.
export function createBrokerCommand(deps: BrokerCommandDeps): CommandModule {
	return {
		run: async ({ args, flags, context, emitProgress }) => {
			const subcommand = args[0] ?? "up";
			const projectDir =
				// SAFETY: assertion required at this I/O or test boundary.
				(context as { projectDir?: string }).projectDir ??
				(isJsonString(flags.cwd) ? flags.cwd : context.cwd);

			if (subcommand === "matrix") {
				return {
					ok: true,
					status: "matrix",
					code: "HOBO_BROKER_MATRIX",
					message: `hobo broker matrix: ${REJECTION_MATRIX.length} cataloged rejection codes`,
					data: {
						command: "broker",
						matrix: REJECTION_MATRIX.map((row) => ({ ...row })),
					},
				};
			}

			try {
				if (subcommand === "config") {
					if (flags.init === true) {
						const target = join(projectDir, BROKER_CONFIG_FILENAME);
						const existing = await locateConfig({}, projectDir);
						if (existing !== undefined) {
							return {
								ok: false,
								status: "config_exists",
								code: "HOBO_BROKER_CONFIG_EXISTS",
								message: `hobo broker config --init: ${existing} already exists`,
								remediation: [
									"Edit the existing hobo.broker.json instead of re-initializing.",
								],
								data: { command: "broker" },
							};
						}
						const scaffold = {
							...defaultLocalPolicySet("broker:my-yard"),
							connectors: [],
							catalog: "local-host",
						};
						await writeFile(
							target,
							`${JSON.stringify(scaffold, null, "\t")}\n`,
						);
						return {
							ok: true,
							status: "config_initialized",
							code: "HOBO_BROKER_CONFIG_INIT",
							message: `hobo broker config: wrote ${target}`,
							data: { command: "broker", configPath: target },
						};
					}

					const assembled = await assembleBroker(deps, flags, projectDir);
					const summary = {
						source: assembled.source,
						...(assembled.configPath !== undefined
							? { configPath: assembled.configPath }
							: undefined),
						brokerId: assembled.policies.brokerId,
						policyHash: policyHashOf(assembled.policies),
						placementPolicies: assembled.policies.placementPolicies.length,
						billing: assembled.policies.billing,
						deliveryEngine: assembled.policies.delivery.engine,
						policyEngine: assembled.engineKind,
						catalog: assembled.catalogKind,
						catalogHash: assembled.catalog.catalogHash,
						connectors:
							assembled.connectors?.list().map((connector) => ({
								id: connector.id,
								kind: connector.kind,
								enabled: connector.enabled,
							})) ?? [],
						requiredConnectorKinds: assembled.policies.requiredConnectorKinds,
					};
					return {
						ok: true,
						status:
							assembled.source === "config" ? "config_valid" : "default_local",
						code: "HOBO_BROKER_CONFIG",
						message:
							assembled.source === "config"
								? `hobo broker config: ${assembled.configPath} is valid (${summary.placementPolicies} placement policies, engine ${summary.policyEngine}, catalog ${summary.catalog})`
								: "hobo broker config: no hobo.broker.json — broker up will register this machine as a local HoBo cloud provider host under the default policy set",
						data: { command: "broker", config: summary },
					};
				}

				if (subcommand === "up") {
					const assembled = await assembleBroker(deps, flags, projectDir);
					const pins = requireStationPins(flags);
					const broker = createBroker({
						policies: assembled.policies,
						catalog: assembled.catalog,
						stationId: pins.stationId,
						railHash: pins.railHash,
						...(assembled.connectors !== undefined
							? { connectors: assembled.connectors }
							: undefined),
						...(assembled.gatePlane !== undefined
							? { gatePlane: assembled.gatePlane }
							: undefined),
					});
					const resolution = await broker.resolve(
						await deriveRequest(flags, projectDir),
					);
					for (const event of resolution.events) emitProgress(event.type);

					if (resolution.outcome === "rejected") {
						return {
							ok: false,
							status: "rejected",
							code: "HOBO_BROKER_REJECTED",
							message: `hobo broker up: rejected — ${resolution.rejection?.reasons
								.map((reason) => `${reason.plane}:${reason.code}`)
								.join(", ")}`,
							remediation: resolution.rejection?.reasons.map(
								(reason) =>
									REJECTION_MATRIX.find((row) => row.code === reason.code)
										?.remediation ?? reason.message,
							) ?? [
								"Inspect the rejection reasons and adjust the request or policy.",
							],
							data: {
								command: "broker",
								rejection: resolution.rejection,
								events: resolution.events,
							},
						};
					}

					const receipt = resolution.receipt;
					if (receipt === undefined) {
						throw new Error("resolved without a receipt");
					}
					// Spin up every placement, then hand the receipt to delivery.
					const scaleEvents = receipt.placements.flatMap(
						(placement) =>
							broker.scale({
								resourceId: placement.resourceId,
								direction: "up",
								replicas: 1,
							}).events,
					);
					const delivery = await broker.deliver(receipt);
					for (const event of [...scaleEvents, ...delivery.events]) {
						emitProgress(event.type);
					}
					return {
						ok: true,
						status: "up",
						code: "HOBO_BROKER_UP",
						message: `hobo broker up: ${receipt.placements.length} placement(s) on ${[...new Set(receipt.placements.map((p) => p.providerId))].join(", ")} via ${assembled.catalogKind} catalog, delivered through ${delivery.ticket.engine}`,
						data: {
							command: "broker",
							catalog: assembled.catalogKind,
							receipt,
							ticket: delivery.ticket,
							events: [
								...resolution.events,
								...scaleEvents,
								...delivery.events,
							],
						},
					};
				}

				if (subcommand === "resolve") {
					const policiesPath = flags.policies;
					const requestPath = flags.request;
					if (!isJsonString(policiesPath) || !isJsonString(requestPath)) {
						return {
							ok: false,
							status: "missing_inputs",
							code: "HOBO_BROKER_USAGE",
							message:
								"hobo broker resolve needs --policies <file> and --request <file> (JSON documents).",
							remediation: [
								"Pass the broker policy set with --policies and the brokering request with --request.",
							],
							data: { command: "broker" },
						};
					}
					const pins = requireStationPins(flags);
					const broker = createBroker({
						policies: await readJson(policiesPath, "broker policy set"),
						catalog: deps.catalog,
						stationId: pins.stationId,
						railHash: pins.railHash,
					});
					const resolution = await broker.resolve(
						await readJson(requestPath, "broker request"),
					);
					for (const event of resolution.events) emitProgress(event.type);
					if (resolution.outcome === "resolved") {
						return {
							ok: true,
							status: "resolved",
							code: "HOBO_BROKER_RESOLVED",
							message: `hobo broker: resolved ${resolution.receipt?.placements.length ?? 0} placement(s) under policy ${resolution.receipt?.placementPolicyId}`,
							data: {
								command: "broker",
								receipt: resolution.receipt,
								events: resolution.events,
							},
						};
					}
					return {
						ok: false,
						status: "rejected",
						code: "HOBO_BROKER_REJECTED",
						message: `hobo broker: rejected — ${resolution.rejection?.reasons
							.map((reason) => `${reason.plane}:${reason.code}`)
							.join(", ")}`,
						remediation: resolution.rejection?.reasons.map(
							(reason) =>
								REJECTION_MATRIX.find((row) => row.code === reason.code)
									?.remediation ?? reason.message,
						) ?? [
							"Inspect the rejection reasons and adjust the request or policy.",
						],
						data: {
							command: "broker",
							rejection: resolution.rejection,
							events: resolution.events,
						},
					};
				}

				return {
					ok: false,
					status: "unknown_subcommand",
					code: "HOBO_BROKER_USAGE",
					message: `hobo broker: unknown subcommand '${subcommand}'`,
					remediation: [
						"Use `hobo broker up`, `hobo broker config [--init]`, `hobo broker resolve --policies <file> --request <file>`, or `hobo broker matrix`.",
					],
					data: { command: "broker" },
				};
			} catch (error) {
				if (error instanceof BrokerParseError) {
					return {
						ok: false,
						status: "invalid_input",
						code: "HOBO_BROKER_INVALID",
						message: `hobo broker: ${error.message}`,
						remediation: [
							"Fix the config/policy/request document to satisfy data-models/broker.cue and retry.",
						],
						data: { command: "broker", errorCode: error.code },
					};
				}
				throw error;
			}
		},
	};
}
