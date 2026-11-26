import type { Job } from "@hobo/ci";

export interface JobPickupMetadata {
	readonly event?: string | undefined;
	readonly jobCreatedAt?: string | undefined;
}

export type JobPickupMetadataCache = Map<string, JobPickupMetadata>;

export function jobPickupMetadataKey(
	job: Pick<Job, "repositoryId" | "id" | "runAttempt">,
): string {
	return `${job.repositoryId}:${job.id}:${job.runAttempt}`;
}

export function observeJobPickupMetadata(
	cache: JobPickupMetadataCache,
	input: Pick<Job, "repositoryId" | "id" | "runAttempt"> & {
		event?: string | undefined;
		jobCreatedAt?: string | undefined;
	},
): void {
	const key = jobPickupMetadataKey(input);
	const previous = cache.get(key);
	const metadata = {
		event: input.event ?? previous?.event,
		jobCreatedAt: input.jobCreatedAt ?? previous?.jobCreatedAt,
	};
	cache.set(key, metadata);
}
