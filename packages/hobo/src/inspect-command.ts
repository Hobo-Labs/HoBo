import type { CommandModule, YardRuntime } from "@hobo/cli";
import { deploymentIdFor } from "@hobo/cli";
import { deploymentViewProjection, topologyViewProjection } from "@hobo/cloud";
import {
	getNamedEndpointSession,
	listNamedEndpointSessions,
} from "@hobo/connectivity";
import type { EventStore } from "@hobo/core";
import { defaultHoboHome } from "./bare-metal-yard.js";
import { loadHoboProfile } from "./hobo-profile.js";
import { quarantineDiagnostics } from "./quarantine-diagnostics.js";

export interface InspectCommandDeps {
	readonly runtime?: YardRuntime;
	readonly quarantineStore?: EventStore;
	readonly tenant?: string;
}

export function createInspectCommand(
	deps: InspectCommandDeps = {},
): CommandModule {
	return {
		run: async ({ context, flags, args, emitProgress }) => {
			const { runtime } = deps;
			if (args[0] === "quarantines") {
				if (
					args.length > 2 ||
					(args[1] !== undefined && !/^(0|[1-9]\d*)$/u.test(args[1]))
				) {
					return {
						ok: false,
						status: "usage_error",
						code: "HOBO_CLI_USAGE",
						message: "Use hobo inspect quarantines [position].",
					};
				}
				const configuredTenant = process.env.HOBO_TENANT;
				const tenant =
					deps.tenant ??
					(configuredTenant?.trim() ? configuredTenant : undefined) ??
					loadHoboProfile(defaultHoboHome())?.session?.tenant ??
					"local";
				const diagnostic = await quarantineDiagnostics(
					deps.quarantineStore ?? runtime?.store,
					tenant,
					args[1],
				);
				if (!diagnostic.available) {
					return {
						ok: false,
						status: "unavailable",
						code: "HOBO_QUARANTINE_UNAVAILABLE",
						message: diagnostic.reason,
						data: { command: "inspect", mode: "quarantines" },
					};
				}
				for (const finding of diagnostic.report.findings) {
					emitProgress(
						`${finding.sourceStreamId}#${finding.offendingSeq} ${finding.foldKind} ${finding.fold}: ${finding.reason}`,
					);
				}
				return {
					ok: true,
					status: "ok",
					code: "HOBO_OK",
					message: `Found ${diagnostic.report.findings.length} quarantined event(s)${diagnostic.report.complete ? "" : `; continue at position ${diagnostic.report.nextPosition}`}.`,
					data: {
						command: "inspect",
						mode: "quarantines",
						report: diagnostic.json,
					},
				};
			}
			if (!runtime) {
				return {
					ok: false,
					status: "unavailable",
					code: "HOBO_NO_RUNTIME",
					message:
						"hobo inspect has no Yard runtime wired — run it from the composed `hobo` binary.",
					data: { command: "inspect" },
				};
			}

			const projectDir = context.projectDir ?? flags.cwd ?? context.cwd;
			const deploymentId = deploymentIdFor(projectDir);

			if (args[0] === "graph") {
				const graphSnapshot = await topologyViewProjection.rebuildFromZero(
					runtime.store,
					`deployment:${deploymentId}`,
				);
				const graphRow = topologyViewProjection.get(
					graphSnapshot,
					deploymentId,
				);
				if (!graphRow) {
					return {
						ok: true,
						status: "no_history",
						code: "HOBO_OK",
						message: `hobo inspect graph: no deployment history for "${deploymentId}" — run \`hobo up\` first.`,
						data: {
							command: "inspect",
							mode: "graph",
							deploymentId,
							found: false,
						},
					};
				}
				for (const node of graphRow.nodes) {
					const detail = [
						node.port !== undefined ? `port=${node.port}` : undefined,
						node.lifecycle !== undefined
							? `lifecycle=${node.lifecycle}`
							: undefined,
						node.region !== undefined ? `region=${node.region}` : undefined,
					]
						.filter((part) => part !== undefined)
						.join(" ");
					emitProgress(
						`${node.id} (${node.kind})${detail.length > 0 ? ` ${detail}` : ""}`,
					);
					for (const edge of graphRow.edges) {
						if (edge.from !== node.id) continue;
						emitProgress(`  -[${edge.kind}]-> ${edge.to}`);
					}
				}
				return {
					ok: true,
					status: "ok",
					code: "HOBO_OK",
					message: `hobo inspect graph: deployment "${deploymentId}" — ${graphRow.nodes.length} node(s), ${graphRow.edges.length} edge(s)`,
					data: {
						command: "inspect",
						mode: "graph",
						deploymentId,
						found: true,
						graph: {
							nodes: graphRow.nodes,
							edges: graphRow.edges,
						},
						...(graphRow.bindleHash !== undefined
							? { bindleHash: graphRow.bindleHash }
							: undefined),
					},
				};
			}
			const snapshot = await deploymentViewProjection.rebuildFromZero(
				runtime.store,
				`deployment:${deploymentId}`,
			);
			const row = deploymentViewProjection.get(snapshot, deploymentId);

			const namedSessions = listNamedEndpointSessions();
			const activeNamed =
				getNamedEndpointSession("default") ??
				(namedSessions[0]
					? getNamedEndpointSession(namedSessions[0].sessionId)
					: null);
			const namedEndpointsPayload = {
				sessions: namedSessions,
				namedEndpoints: activeNamed?.namedEndpoints ?? [],
				primaryNamedUrl: activeNamed?.primaryNamedUrl ?? null,
			};

			if (!row) {
				return {
					ok: true,
					status: "no_history",
					code: "HOBO_OK",
					message: `hobo inspect: no deployment history for "${deploymentId}" — run \`hobo up\` first.`,
					data: {
						command: "inspect",
						deploymentId,
						found: false,
						...namedEndpointsPayload,
					},
				};
			}

			for (const [resource, lifecycle] of Object.entries(row.resources).sort(
				([a], [b]) => a.localeCompare(b),
			)) {
				emitProgress(`${resource}: ${lifecycle}`);
			}
			if (namedEndpointsPayload.primaryNamedUrl) {
				emitProgress(
					`named: ${namedEndpointsPayload.primaryNamedUrl} (${namedEndpointsPayload.namedEndpoints.length} endpoint(s))`,
				);
			}

			return {
				ok: true,
				status: row.status,
				code: "HOBO_OK",
				message: `hobo inspect: deployment "${deploymentId}" is ${row.status} (${Object.keys(row.resources).length} resource(s))`,
				data: {
					command: "inspect",
					deploymentId,
					found: true,
					deploymentStatus: row.status,
					resources: row.resources,
					decisions: row.decisions,
					...(row.planHash !== undefined
						? { planHash: row.planHash }
						: undefined),
					...(row.bindleHash !== undefined
						? { bindleHash: row.bindleHash }
						: undefined),
					...(row.rejection !== undefined
						? { rejection: row.rejection }
						: undefined),
					...(row.rollback !== undefined
						? { rollback: row.rollback }
						: undefined),
					...namedEndpointsPayload,
				},
			};
		},
	};
}
