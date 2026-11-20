import type { CdPassReport } from "@hobo/hobo/cd-platform";
import { QueueClient } from "@vercel/queue";
import { productionDeploymentRefusal } from "./compose.js";
import { loadCdHost, runCdPass } from "./entry.js";
import { CdStoreBindingError } from "./store.js";

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

export type TickDeps = Readonly<{
	env?: Readonly<Record<string, string | undefined>>;
	runPass?: () => Promise<CdPassReport>;
	write?: (line: string) => void;
}>;

export async function runTick(deps: TickDeps = {}): Promise<void> {
	const env = deps.env ?? process.env;
	const write =
		deps.write ?? ((line: string) => void process.stdout.write(line));
	const refusal = productionDeploymentRefusal(env);
	if (refusal !== undefined) {
		write(
			`${JSON.stringify({
				event: "cd.pass.skipped",
				reason: refusal.code,
				vercelEnv: env.VERCEL_ENV,
			})}\n`,
		);
		return;
	}
	let report: CdPassReport;
	try {
		report = await (deps.runPass ?? (() => runCdPass(loadCdHost)))();
	} catch (error) {
		if (error instanceof CdStoreBindingError) {
			write(
				`${JSON.stringify({
					event: "cd.pass.refused",
					reason: error.code,
				})}\n`,
			);
			return;
		}
		throw error;
	}
	if (report.skipped) {
		write(
			`${JSON.stringify({
				event: "cd.pass.skipped",
				reason: report.skipReason ?? "fleet-pass-lease-held",
			})}\n`,
		);
		return;
	}
	const { tick, reconciled } = report;
	const failed = reconciled.filter((camp) => !camp.ok);
	write(
		`${JSON.stringify({
			event: "cd.pass",
			camps: reconciled.length,
			failed: failed.map((camp) => camp.campId),
			store: tick.store,
		})}\n`,
	);
}

export const onTick = singleFlight(() => runTick());

export const consume = queue.handleNodeCallback(onTick);
