import { CiSetupUsage } from "./ci-command-errors.js";

export function validRepository(value: string): boolean {
	return /^[A-Za-z0-9_][A-Za-z0-9_.-]*\/[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(
		value,
	);
}

/** Parse GitHub remotes without executing a shell or accepting another host. */
export function ciRepositoryFromRemote(remote: string): string {
	const match =
		/^(?:git@github\.com:|ssh:\/\/git@github\.com\/|https:\/\/github\.com\/)([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)\/?$/.exec(
			remote.trim(),
		);
	const repository = match?.[1]?.replace(/\.git$/, "");
	if (!repository || !validRepository(repository))
		throw new CiSetupUsage("Select a GitHub remote or pass --repo owner/name.");
	return repository;
}
