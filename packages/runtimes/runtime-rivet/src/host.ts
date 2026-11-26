import { createRivetActorHost, type RivetActorHost } from "./actor-host.js";
import { type ActorLocalJournal, createActorLocalJournal } from "./journal.js";
import { cloneAsJson, isJsonString } from "./json.js";
import { parseRivetRuntimeConfig } from "./parse.js";
import {
	type RivetDoctorReport,
	RivetJournalError,
	type RivetRuntimeConfig,
	type RivetRuntimeMode,
} from "./types.js";

export interface RivetRuntimeHostOptions {
	readonly tenantId: string;
	readonly campId: string;
	readonly mode?: RivetRuntimeMode;
	readonly journalPath: string;
	readonly legacyEventPayloads?: "command" | "event";
}

export interface RivetRuntimeBundle {
	readonly host: {
		readonly kind: "rivet";
		ensure(input: { hoboHome: string; env: NodeJS.ProcessEnv }): Promise<{
			kind: "rivet";
			ready: true;
			details: {
				placementMode: "rivet";
				fidelity: RivetActorHost["fidelity"];
				secretless: true;
			};
		}>;
	};
	readonly actors: RivetActorHost;
	readonly journal: ActorLocalJournal;
	readonly config: RivetRuntimeConfig;
	readonly doctor: RivetDoctorReport;
}

export function createRivetRuntimeHost(
	options: RivetRuntimeHostOptions,
): RivetRuntimeBundle {
	const config = parseRivetRuntimeConfig({
		tenantId: options.tenantId,
		campId: options.campId,
		mode: options.mode ?? "local",
		svidBindingRef: "svid://camp/rivet",
	});
	if (config.mode !== "local") {
		throw new RivetJournalError(
			"PARSE",
			`Rivet runtime mode ${config.mode} is unavailable; only local-sqlite is implemented`,
		);
	}
	const journalPath = cloneAsJson(options.journalPath);
	if (!isJsonString(journalPath) || !journalPath.trim()) {
		throw new RivetJournalError(
			"PARSE",
			"Rivet runtime requires an explicit journalPath; use :memory: only for volatile state",
		);
	}
	const journal = createActorLocalJournal(journalPath);
	const actors = createRivetActorHost({
		journal,
		fidelity: "local-sqlite",
		tenantId: options.tenantId,
		legacyEventPayloads: options.legacyEventPayloads,
	});
	const doctor: RivetDoctorReport = {
		mode: config.mode,
		rivetkitAvailable: false,
		journalReady: true,
		fidelity: "local-sqlite",
		notes: [
			"RivetKit is not required for local-sqlite fidelity.",
			"Raw Rivet queue receive-loss is not command authority.",
		],
		remediation: [
			"Implement and verify a Rivet-backed journal before advertising fidelity=rivetkit.",
		],
	};
	return {
		config,
		journal,
		actors,
		doctor,
		host: {
			kind: "rivet",
			async ensure() {
				return {
					kind: "rivet",
					ready: true,
					details: {
						placementMode: "rivet",
						fidelity: actors.fidelity,
						secretless: true,
					},
				};
			},
		},
	};
}

export function diagnoseRivetReadiness(
	bundle: RivetRuntimeBundle,
): RivetDoctorReport {
	return bundle.doctor;
}
