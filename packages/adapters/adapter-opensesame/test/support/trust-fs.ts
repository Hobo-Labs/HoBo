/** An in-memory file tree for the trust rule, so ownership can be tested without being root. */
import type { EntryStat, Trust } from "../../src/trust.js";

export type TreeNode = EntryStat & Readonly<{ link?: string }>;

export const dir = (uid: number, mode: number): TreeNode => ({
	uid,
	mode,
	directory: true,
});
export const file = (uid: number, mode: number): TreeNode => ({
	uid,
	mode,
	directory: false,
});
export const link = (target: string): TreeNode => ({
	uid: 0,
	mode: 0o777,
	directory: false,
	link: target,
});

export function memoryTrust(
	nodes: Readonly<Record<string, TreeNode>>,
	options: {
		euid?: number | undefined;
		cwd?: string;
		home?: string;
	} = {},
): Trust {
	function follow(path: string): string | undefined {
		let at = path;
		for (let hops = 0; hops < 16; hops += 1) {
			const node = nodes[at];
			if (node === undefined) return undefined;
			if (node.link === undefined) return at;
			at = node.link;
		}
		return undefined;
	}
	return {
		fs: {
			realpath: follow,
			stat(path) {
				const real = follow(path);
				const node = real === undefined ? undefined : nodes[real];
				return node === undefined
					? undefined
					: { uid: node.uid, mode: node.mode, directory: node.directory };
			},
		},
		euid: "euid" in options ? options.euid : 1000,
		cwd: options.cwd ?? "/work/checkout",
		home: options.home ?? "/home/me",
	};
}

/** Directories every tree here starts from: root, /usr and /usr/bin owned by root, 0755. */
export const SYSTEM = {
	"/": dir(0, 0o755),
	"/usr": dir(0, 0o755),
	"/usr/bin": dir(0, 0o755),
	"/usr/local": dir(0, 0o755),
	"/usr/local/bin": dir(0, 0o755),
	"/bin": dir(0, 0o755),
} satisfies Record<string, TreeNode>;

/** The system tree and a kit (a bridge script) root owns under /kit, in a place the rule trusts. */
export const KIT = {
	...SYSTEM,
	"/kit": dir(0, 0o755),
	"/kit/bridge": dir(0, 0o755),
	"/kit/bridge/parse.mjs": file(0, 0o644),
} satisfies Record<string, TreeNode>;
