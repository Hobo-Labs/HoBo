import type { CommandModule, YardRuntime } from "@hobo/cli";
import { deploymentIdFor } from "@hobo/cli";
import { deploymentViewProjection, topologyViewProjection } from "@hobo/cloud";
import {
	getNamedEndpointSession,
	listNamedEndpointSessions,
} from "@hobo/connectivity";

export interface InspectCommandDeps {
	// The shared Yard runtime whose durable event store `inspect` folds. The
	// composed CLI injects the SAME runtime `up`/`down` write to, so `inspect`
	// renders their real history. Un-injected, `inspect` reports that no runtime
	// is wired rather than fabricating a view.
	readonly runtime?: YardRuntime;
}

// `hobo inspect` — render the DeploymentView projection for the current project's
// deployment by folding the durable event log from zero (the log is
// authoritative; the view is derived). It answers "what is the current state of
// my deployment, and how did each resource get there?" straight from the event
// store — no cloud call, no credential. Rebuilding from zero is exactly the
// property the data-plane guarantees: drop the sink, replay the stream, get the
// same view.
export function createInspectCommand(
	deps: InspectCommandDeps = {},
): CommandModule {
	return {
		run: async ({ context, flags, args, emitProgress }) => {
			const { runtime } = deps;
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

			// `hobo inspect graph` — render the TopologyView app-graph projection
			// (E21): nodes are the bindle, its resources, and the yards they land
			// on; edges are bindings and placements. Same durable log, same
			// rebuild-from-zero discipline; `--json` gets the structured graph, the
			// text path gets a readable adjacency listing via emitProgress.
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
				// Adjacency listing: every node, then its outbound edges.
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

			// MCP/agent discovery of the current session's hierarchical named endpoints
			// (list_local_named_endpoints surface via inspect).
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
