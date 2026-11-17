/** Verify that a tested commit is the current head of an open PR. */
import { execFileSync } from "node:child_process";
import { devNull } from "node:os";
import {
	asNumber,
	asObject,
	asText,
	type JsonValue,
	parseJson,
} from "./attestation.mts";

type Repository = Readonly<{ name: string; id: number }>;

/** Compare the whole proof with a fresh verification immediately before signoff. */
export type PrHeadProof = Readonly<{
	host: string;
	prNumber: number;
	baseRepository: Repository;
	baseBranch: string;
	baseSha: string;
	headRepository: Repository;
	headBranch: string;
	headSha: string;
}>;

export class PrHeadVerificationError extends Error {}

const OWNER = /^[A-Za-z0-9][A-Za-z0-9_-]{0,38}$/u;
const REPOSITORY = /^[A-Za-z0-9_.-]{1,100}$/u;
const OBJECT_ID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const HOST =
	/^[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?(?::[1-9][0-9]{0,4})?$/u;

function validHost(host: string | undefined): host is string {
	if (!host || !HOST.test(host)) return false;
	const [hostname, port] = host.split(":");
	return (
		(port === undefined || Number(port) <= 65535) &&
		!!hostname &&
		hostname
			.split(".")
			.every(
				(label) => !!label && !label.startsWith("-") && !label.endsWith("-"),
			)
	);
}

function positiveInteger(value: number | undefined): value is number {
	return value !== undefined && Number.isSafeInteger(value) && value > 0;
}

/** Git's branch-name restrictions, before the name becomes an API path. */
function branchName(value: string | undefined): value is string {
	if (
		!value ||
		Buffer.byteLength(value, "utf8") > 255 ||
		value === "@" ||
		value.startsWith("-") ||
		value.startsWith("/") ||
		value.endsWith("/") ||
		value.endsWith(".") ||
		value.includes("//") ||
		value.includes("..") ||
		value.includes("@{") ||
		[...value].some((character) => {
			const code = character.codePointAt(0) ?? 0;
			return code <= 0x20 || code === 0x7f || "~^:?*[\\".includes(character);
		}) ||
		value
			.split("/")
			.some((part) => part.startsWith(".") || part.endsWith(".lock"))
	)
		return false;
	try {
		encodeURIComponent(value);
		return true;
	} catch {
		return false;
	}
}

function repository(value: JsonValue | undefined): Repository | undefined {
	const item = asObject(value);
	const owner = asText(asObject(item?.owner)?.login);
	const name = asText(item?.name);
	const fullName = asText(item?.full_name);
	const id = asNumber(item?.id);
	if (
		!owner ||
		!OWNER.test(owner) ||
		!name ||
		!REPOSITORY.test(name) ||
		name === "." ||
		name === ".." ||
		!fullName ||
		fullName.toLowerCase() !== `${owner}/${name}`.toLowerCase() ||
		!positiveInteger(id)
	)
		return undefined;
	return { name: fullName, id };
}

function sameRepository(left: Repository, right: Repository): boolean {
	return (
		left.id === right.id && left.name.toLowerCase() === right.name.toLowerCase()
	);
}

/**
 * Verify an exact open PR in the already-pinned GitHub target and its live head
 * branch. An inferred PR number is only a candidate. Failure to read any part
 * of the proof is a refusal, and subprocess output is never included in errors.
 *
 * Re-run immediately before publication and compare the entire returned proof;
 * this binds the recheck to the same PR, repository IDs, refs and commits.
 * Publication is not atomic with these reads: a GitHub status remains attached
 * to the commit even if the PR, its base or the head branch later changes.
 */
export function verifyPrHead(input: {
	cwd: string;
	env: NodeJS.ProcessEnv;
	baseBranch: string;
	baseSha: string;
	headSha: string;
	prNumber?: number | undefined;
}): PrHeadProof {
	const host = input.env.GH_HOST;
	const target = input.env.GH_REPO;
	const parts = target?.split("/") ?? [];
	const targetParts = parts.length === 3 ? parts.slice(1) : parts;
	const [owner, name] = targetParts;
	if (
		!validHost(host) ||
		(parts.length !== 2 && parts.length !== 3) ||
		(parts.length === 3 && parts[0]?.toLowerCase() !== host.toLowerCase()) ||
		!owner ||
		!OWNER.test(owner) ||
		!name ||
		!REPOSITORY.test(name) ||
		name === "." ||
		name === ".."
	)
		throw new PrHeadVerificationError(
			"GitHub target is not pinned to a valid host and repository",
		);
	if (
		!branchName(input.baseBranch) ||
		!OBJECT_ID.test(input.baseSha) ||
		!OBJECT_ID.test(input.headSha)
	)
		throw new PrHeadVerificationError("the tested base or head is invalid");
	if (input.prNumber !== undefined && !positiveInteger(input.prNumber))
		throw new PrHeadVerificationError(
			"the pull request number must be a positive integer",
		);

	const environment: NodeJS.ProcessEnv = {
		...input.env,
		GH_HOST: host,
		GH_REPO: `${host}/${owner}/${name}`,
	};
	for (const key of [
		"GIT_DIR",
		"GIT_WORK_TREE",
		"GIT_INDEX_FILE",
		"GIT_COMMON_DIR",
		"GIT_OBJECT_DIRECTORY",
		"GIT_ALTERNATE_OBJECT_DIRECTORIES",
		"GIT_NAMESPACE",
		"GIT_PREFIX",
		"GIT_QUARANTINE_PATH",
	])
		delete environment[key];
	delete environment.GIT_REPLACE_REF_BASE;
	environment.GIT_NO_REPLACE_OBJECTS = "1";
	environment.GIT_GRAFT_FILE = devNull;
	const gh = (args: readonly string[], failure: string): string => {
		try {
			return execFileSync("gh", args, {
				cwd: input.cwd,
				env: environment,
				encoding: "utf8",
				stdio: ["ignore", "pipe", "pipe"],
				timeout: 10_000,
				maxBuffer: 1024 * 1024,
			}).trim();
		} catch {
			throw new PrHeadVerificationError(failure);
		}
	};
	const read = (path: string, failure: string): JsonValue => {
		try {
			return parseJson(gh(["api", "--hostname", host, path], failure));
		} catch {
			throw new PrHeadVerificationError(failure);
		}
	};
	let prNumber = input.prNumber;
	if (prNumber === undefined) {
		const discovered = gh(
			["pr", "view", "--json", "number", "--jq", ".number"],
			"could not discover a pull request; specify --pr=<number>",
		);
		prNumber = /^[1-9][0-9]*$/u.test(discovered)
			? Number(discovered)
			: undefined;
		if (!positiveInteger(prNumber))
			throw new PrHeadVerificationError(
				"could not discover one pull request; specify --pr=<number>",
			);
	}

	const pull = asObject(
		read(
			`repos/{owner}/{repo}/pulls/${prNumber}`,
			"could not read the target pull request",
		),
	);
	const base = asObject(pull?.base);
	const head = asObject(pull?.head);
	const baseRepository = repository(base?.repo);
	const headRepository = repository(head?.repo);
	const headBranch = asText(head?.ref);
	if (
		asNumber(pull?.number) !== prNumber ||
		asText(pull?.state) !== "open" ||
		asText(base?.ref) !== input.baseBranch ||
		asText(head?.sha) !== input.headSha ||
		!baseRepository ||
		baseRepository.name.toLowerCase() !== `${owner}/${name}`.toLowerCase() ||
		!headRepository ||
		(headRepository.id === baseRepository.id) !==
			(headRepository.name.toLowerCase() ===
				baseRepository.name.toLowerCase()) ||
		!branchName(headBranch)
	)
		throw new PrHeadVerificationError(
			"the open pull request does not match the tested base, head and repository",
		);

	const liveBase = repository(
		read("repos/{owner}/{repo}", "could not verify the target repository"),
	);
	if (!liveBase || !sameRepository(baseRepository, liveBase))
		throw new PrHeadVerificationError("the target repository identity changed");
	const [headOwner, headName] = headRepository.name.split("/");
	const headPath = `repos/${encodeURIComponent(headOwner ?? "")}/${encodeURIComponent(headName ?? "")}`;
	const liveHeadRepository = repository(
		read(headPath, "could not verify the head repository"),
	);
	if (
		!liveHeadRepository ||
		!sameRepository(headRepository, liveHeadRepository)
	)
		throw new PrHeadVerificationError("the head repository identity changed");
	const branch = asObject(
		read(
			`${headPath}/branches/${encodeURIComponent(headBranch)}`,
			"could not read the live head branch",
		),
	);
	if (
		asText(branch?.name) !== headBranch ||
		asText(asObject(branch?.commit)?.sha) !== input.headSha
	)
		throw new PrHeadVerificationError(
			"the head branch no longer points to the tested head",
		);
	const liveHeadRecheck = repository(
		read(headPath, "could not recheck the head repository"),
	);
	if (!liveHeadRecheck || !sameRepository(headRepository, liveHeadRecheck))
		throw new PrHeadVerificationError("the head repository identity changed");
	// GitHub's PR base.sha can lag the branch after it advances. Read the live
	// branch instead, then recheck the repository identity around that read.
	const liveBaseBranch = asObject(
		read(
			`repos/{owner}/{repo}/branches/${encodeURIComponent(input.baseBranch)}`,
			"could not read the live base branch",
		),
	);
	if (
		asText(liveBaseBranch?.name) !== input.baseBranch ||
		asText(asObject(liveBaseBranch?.commit)?.sha) !== input.baseSha
	)
		throw new PrHeadVerificationError("the live base branch changed");
	const confirmedTarget = repository(
		read("repos/{owner}/{repo}", "could not recheck the target repository"),
	);
	if (!confirmedTarget || !sameRepository(baseRepository, confirmedTarget))
		throw new PrHeadVerificationError("the target repository identity changed");
	const confirmedPull = asObject(
		read(
			`repos/{owner}/{repo}/pulls/${prNumber}`,
			"could not recheck the target pull request",
		),
	);
	const confirmedBase = asObject(confirmedPull?.base);
	const confirmedHead = asObject(confirmedPull?.head);
	const confirmedBaseRepository = repository(confirmedBase?.repo);
	const confirmedHeadRepository = repository(confirmedHead?.repo);
	if (
		asNumber(confirmedPull?.number) !== prNumber ||
		asText(confirmedPull?.state) !== "open" ||
		asText(confirmedBase?.ref) !== input.baseBranch ||
		asText(confirmedHead?.ref) !== headBranch ||
		asText(confirmedHead?.sha) !== input.headSha ||
		!confirmedBaseRepository ||
		!sameRepository(baseRepository, confirmedBaseRepository) ||
		!confirmedHeadRepository ||
		!sameRepository(headRepository, confirmedHeadRepository)
	)
		throw new PrHeadVerificationError(
			"the pull request changed during verification",
		);

	return {
		host: host.toLowerCase(),
		prNumber,
		baseRepository,
		baseBranch: input.baseBranch,
		baseSha: input.baseSha,
		headRepository,
		headBranch,
		headSha: input.headSha,
	};
}
