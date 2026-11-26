import { create } from "@bufbuild/protobuf";
import type { JsonValue } from "@hobo/core";
import {
	type ArtifactRef,
	ArtifactRefSchema,
	SubscriptionKind,
} from "../../_generated/cd_pb.js";
import type {
	CiArtifactReader,
	CiEventReader,
	SubscriptionDriver,
} from "../../ports.js";
import {
	field,
	isRecord,
	isText,
	list,
	parseJson,
	sha256Hex,
	text,
} from "../json.js";
import { refuse, SOURCE_REASON } from "../reasons.js";
import {
	type Candidate,
	discovered,
	discoveryLimit,
	parseCursor,
	writeCursor,
} from "./common.js";

export const CI_RESULT_EVENT = "ci.PipelineResultObserved" as const;
export const CI_PASSED = "passed" as const;
export const CI_SCAN_LIMIT = 10_000;

const COMMIT = /^[0-9a-f]{7,64}$/;

type CiOutput = Readonly<{
	runId: string;
	path: string;
	sha256: string;
	commit?: string;
}>;

export function ciOutputs(
	data: JsonValue,
	locator: string,
): readonly CiOutput[] {
	const detail = field(data, "detail");
	const lease: JsonValue | undefined = isText(detail)
		? parseJson(detail)
		: data;
	if (!isRecord(lease)) return [];
	const result = field(lease, "result");
	if (text(result, "status") !== CI_PASSED) return [];
	const runId = text(result, "id");
	if (!runId) return [];
	const owners = [text(lease, "pipelineId"), text(lease, "repository")];
	if (!owners.includes(locator)) return [];
	const commit =
		text(lease, "headSha") ?? text(lease, "commit") ?? text(lease, "sha");
	return list(result, "artifacts").flatMap((artifact) => {
		const path = text(artifact, "path");
		const sha = (text(artifact, "sha256") ?? "").replace(/^sha256:/, "");
		if (!path || !/^[0-9a-f]{64}$/.test(sha)) return [];
		const output: CiOutput = { runId, path, sha256: sha };
		return [commit && COMMIT.test(commit) ? { ...output, commit } : output];
	});
}

function pathMatches(
	path: string,
	artifactName: string,
	include: readonly string[],
): boolean {
	if (artifactName !== "") return path === artifactName;
	if (include.length === 0) return true;
	return include.some(
		(prefix) =>
			path === prefix ||
			path.startsWith(prefix.endsWith("/") ? prefix : `${prefix}/`),
	);
}

export function ciCoordinate(
	locator: string,
	runId: string,
	path: string,
): string {
	return `hobo-ci://${encodeURIComponent(locator)}/${encodeURIComponent(runId)}/${path.split("/").map(encodeURIComponent).join("/")}`;
}

export function createCiDriver(
	d: Readonly<{
		readCiEvents?: CiEventReader;
		readCiArtifact?: CiArtifactReader;
	}>,
): SubscriptionDriver {
	return {
		kind: SubscriptionKind.HOBO_CI,
		async discover(input, ctx) {
			const { subscription } = input;
			const readEvents = d.readCiEvents;
			const readArtifact = d.readCiArtifact;
			if (!readEvents || !readArtifact) {
				return refuse(
					SOURCE_REASON.driverUnavailable,
					"HOBO_CI discovery needs both a CiEventReader and a CiArtifactReader",
					"compose createSubscriptionDrivers with readCiEvents and readCiArtifact",
					subscription.name,
				);
			}
			const previous = parseCursor(input.cursor);
			let at = previous.at;
			let scanned = 0;
			const outputs: CiOutput[] = [];
			for await (const event of readEvents(previous.at, input.signal)) {
				scanned += 1;
				at = event.cursor;
				if (event.type === CI_RESULT_EVENT) {
					for (const output of ciOutputs(event.data, subscription.locator)) {
						if (
							pathMatches(
								output.path,
								subscription.artifactName,
								subscription.includePaths,
							)
						)
							outputs.push(output);
					}
				}
				if (scanned >= CI_SCAN_LIMIT) break;
			}
			const newest = outputs.slice(
				Math.max(0, outputs.length - discoveryLimit(subscription)),
			);
			const candidates: Candidate[] = [];
			for (const output of newest) {
				const bytes = await readArtifact(output.runId, output.path);
				if (!bytes) {
					return refuse(
						SOURCE_REASON.notFound,
						`CI run ${output.runId} has no readable output ${output.path}`,
						"check CI artifact retention; the poll retries with backoff",
						`${output.runId}/${output.path}`,
					);
				}
				const digest = sha256Hex(bytes);
				if (digest !== output.sha256) {
					return refuse(
						SOURCE_REASON.upstreamInvalid,
						`CI output ${output.path} of run ${output.runId} does not match its recorded sha256`,
						"investigate the CI artifact store for tampering; nothing was discovered",
						`${output.runId}/${output.path}`,
					);
				}
				const artifact: ArtifactRef = create(ArtifactRefSchema, {
					name: subscription.artifactName || subscription.name,
					kind: subscription.artifactKind,
					digest: `sha256:${digest}`,
					coordinate: ciCoordinate(
						subscription.locator,
						output.runId,
						output.path,
					),
					sizeBytes: BigInt(bytes.byteLength),
					ecosystem: "store",
				});
				const candidate: Candidate = {
					version: output.runId,
					rank: output.runId,
					artifact,
				};
				candidates.push(
					output.commit ? { ...candidate, commit: output.commit } : candidate,
				);
			}
			const cursor =
				at === undefined
					? writeCursor(previous)
					: writeCursor({ ...previous, at });
			return {
				ok: true,
				value: {
					artifacts: candidates.map((item) => discovered(input, item, ctx)),
					cursor,
				},
			};
		},
	};
}
