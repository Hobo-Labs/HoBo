import type { CdPassReport } from "@hobo/hobo/cd-platform";
import { QueueClient } from "@vercel/queue";
import { loadCdHost, runCdPass } from "./entry.js";
import { cdStoreBindingErrorOf } from "./store.js";

const queue = new QueueClient();

function singleFlight<T>(run: () => Promise<T>): () => Promise<T> {
	let inFlight: Promise<T> | undefined;
	return () => {
		if (inFlight !== undefined) return inFlight;
		const tracked = run().finally(() => {
			if (inFlight === tracked) inFlight = undefined;
		});
		inFlight = tracked;
		return tracked;
	};
}

async function runTick(): Promise<void> {
	const vercelEnv = process.env.VERCEL_ENV;
	if (
		vercelEnv !== "production" &&
		!(
			vercelEnv === undefined &&
			process.env.HOBO_CD_ALLOW_UNSET_VERCEL_ENV === "1"
		)
	) {
		process.stdout.write(
			`${JSON.stringify({
				event: "cd.pass.skipped",
				reason: "cd-non-production-deployment",
				vercelEnv,
			})}\n`,
		);
		return;
	}
	let report: CdPassReport;
	try {
		report = await runCdPass(loadCdHost);
	} catch (error) {
		const permanent = cdStoreBindingErrorOf(error);
		if (permanent !== undefined) {
			process.stdout.write(
				`${JSON.stringify({
					event: "cd.pass.refused",
					reason: permanent.code,
				})}\n`,
			);
			return;
		}
		throw error;
	}
	if (report.skipped) {
		process.stdout.write(
			`${JSON.stringify({
				event: "cd.pass.skipped",
				reason: report.skipReason ?? "fleet-pass-lease-held",
			})}\n`,
		);
		return;
	}
	const { tick, reconciled } = report;
	const failed = reconciled.filter((camp) => !camp.ok);
	process.stdout.write(
		`${JSON.stringify({
			event: "cd.pass",
			camps: reconciled.length,
			failed: failed.map((camp) => camp.campId),
			store: tick.store,
		})}\n`,
	);
}

export const onTick = singleFlight(runTick);

export const consume = queue.handleNodeCallback(onTick);
