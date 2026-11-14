import {
	collectStream,
	type DeploymentChangeSet,
	type DeploymentPlan,
	parseDeploymentMode,
	planDeploymentChanges,
	recordedResources,
} from "@hobo/cloud";
import type { EventStore } from "@hobo/core";

// The what-if (az/Bicep `what-if`, wrangler `--dry-run`, `pulumi preview`):
// the change set `up` or `down` would make, computed from the declaration and
// the durable log only. Reads the log; writes nothing; calls no provider.

function deploymentStream(deploymentId: string): string {
	return `deployment:${deploymentId}`;
}

/** The change set `up` would apply for this plan, in the given mode. */
export async function upWhatIf(
	store: EventStore,
	deploymentId: string,
	plan: DeploymentPlan,
	mode: string | null | undefined,
): Promise<DeploymentChangeSet> {
	const events = await collectStream(store, deploymentStream(deploymentId));
	return planDeploymentChanges(plan, events, parseDeploymentMode(mode));
}

/** The resources `down` would destroy: everything recorded and not destroyed. */
export async function downWhatIf(
	store: EventStore,
	deploymentId: string,
): Promise<string[]> {
	const events = await collectStream(store, deploymentStream(deploymentId));
	return [...recordedResources(events).values()]
		.filter((resource) => resource.state !== "Destroyed")
		.map((resource) => resource.resourceId)
		.sort();
}

/** `+2 ~1 -0 =3` (create, update, delete, no-op), plus retained orphans. */
export function changeSummaryLine(changes: DeploymentChangeSet): string {
	const { summary } = changes;
	const line = `+${summary.create} ~${summary.update} -${summary.delete} =${summary["no-op"]}`;
	return summary.retain > 0 ? `${line} (retain ${summary.retain})` : line;
}
