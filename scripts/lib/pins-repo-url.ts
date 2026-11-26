/**
 * When two repository URLs name the same repository.
 *
 * Erasable TypeScript with node builtins only.
 */

/**
 * `https://Host/a/b.git/`, `file:///a/b` and `/a/b` compare by what they name.
 * The scheme and the host fold case; the path does not, because a host whose
 * paths are case-sensitive serves `/Org/Repo` and `/org/repo` as two
 * repositories.
 */
export function sameRepo(left: string, right: string): boolean {
	const normal = (value: string): string => {
		const bare = value
			.replace(/^file:\/\//u, "")
			.replace(/\/+$/u, "")
			.replace(/\.git$/u, "");
		const url = /^(https?:\/\/[^/]*)(.*)$/iu.exec(bare);
		return url === null
			? bare
			: `${(url[1] ?? "").toLowerCase()}${url[2] ?? ""}`;
	};
	return normal(left) === normal(right);
}
