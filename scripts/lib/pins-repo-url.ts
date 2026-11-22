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
