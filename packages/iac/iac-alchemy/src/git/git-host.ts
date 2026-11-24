import { BlobStoreR2 } from "@alchemy.run/git/BlobStoreR2";
import { HasherInline } from "@alchemy.run/git/Hasher/Hasher";
import {
	ObjectType,
	parseCommit,
	parseTree,
	ZERO_OID,
} from "@alchemy.run/git/Protocol/ObjectCodec";
import { RESERVED_OWNERS } from "@alchemy.run/git/RegistryObject";
import { MAX_PACK_BYTES } from "@alchemy.run/git/RepoObject";
import * as Data from "effect/Data";
import { validateAlchemyStage } from "../environments/index.js";

export type GitHostBlobStorageKind = "r2" | "s3";
export type GitHostRegistryKind = "durable-object" | "d1";

export class HoboGitHostConfigError extends Data.TaggedError(
	"HoboGitHostConfigError",
)<{
	readonly code: "INVALID_HOST_NAME" | "INVALID_DEFAULT_BRANCH" | "RESERVED_OWNER";
	readonly message: string;
}> {}

const HOST_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{1,62}$/u;
const BRANCH_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/u;

export interface AlchemyGitHostSpecInput {
	readonly hostName: string;
	readonly stage: string;
	readonly owner: string;
	readonly blobStorage: GitHostBlobStorageKind;
	readonly registry?: GitHostRegistryKind;
	readonly defaultBranch?: string;
	readonly protectedBranches?: readonly string[];
	readonly inlineHasher?: boolean;
}

export interface AlchemyGitHostSpec {
	readonly hostName: string;
	readonly stage: string;
	readonly owner: string;
	readonly blobStorage: GitHostBlobStorageKind;
	readonly registry: GitHostRegistryKind;
	readonly defaultBranch: string;
	readonly protectedBranches: readonly string[];
	readonly inlineHasher: boolean;
	readonly maxPackBytes: number;
	readonly zeroOid: string;
}

export function describeAlchemyGitHostSpec(
	input: AlchemyGitHostSpecInput,
): AlchemyGitHostSpec {
	const stage = validateAlchemyStage(input.stage);
	if (!HOST_NAME_PATTERN.test(input.hostName)) {
		throw new HoboGitHostConfigError({
			code: "INVALID_HOST_NAME",
			message: `invalid Alchemy Git host name: ${input.hostName}`,
		});
	}
	if (RESERVED_OWNERS.has(input.owner.toLowerCase())) {
		throw new HoboGitHostConfigError({
			code: "RESERVED_OWNER",
			message: `reserved Git owner name is not allowed: ${input.owner}`,
		});
	}
	const defaultBranch = input.defaultBranch ?? "main";
	if (!BRANCH_NAME_PATTERN.test(defaultBranch)) {
		throw new HoboGitHostConfigError({
			code: "INVALID_DEFAULT_BRANCH",
			message: `invalid default branch name: ${defaultBranch}`,
		});
	}
	return {
		hostName: input.hostName,
		stage,
		owner: input.owner,
		blobStorage: input.blobStorage,
		registry: input.registry ?? "durable-object",
		defaultBranch,
		protectedBranches: input.protectedBranches ?? [defaultBranch],
		inlineHasher: input.inlineHasher ?? true,
		maxPackBytes: MAX_PACK_BYTES,
		zeroOid: ZERO_OID,
	};
}

export const Git = {
	BlobStoreR2,
	HasherInline,
	MAX_PACK_BYTES,
	ObjectType,
	RESERVED_OWNERS,
	ZERO_OID,
	parseCommit,
	parseTree,
} as const;
