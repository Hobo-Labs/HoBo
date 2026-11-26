import { describe, expect, it } from "vitest";

import { placeProblem, trustedPath } from "../src/trust.js";
import { refusalOf } from "./support/refusal.js";
import { dir, file, link, memoryTrust, SYSTEM } from "./support/trust-fs.js";

const ME = 1000;
const STRANGER = 4242;

function problem(
	nodes: Parameters<typeof memoryTrust>[0],
	target: string,
	options?: Parameters<typeof memoryTrust>[1],
): string | undefined {
	return placeProblem(target, memoryTrust({ ...SYSTEM, ...nodes }, options));
}

describe("a place is trusted when it and every directory above it belong to the user or root and only they can write", () => {
	it("accepts a file the user owns, and one root owns, under directories the same way", () => {
		expect(
			problem(
				{
					"/home": dir(0, 0o755),
					"/home/me": dir(ME, 0o755),
					"/home/me/bin": dir(ME, 0o755),
					"/home/me/bin/opensesame": file(ME, 0o755),
				},
				"/home/me/bin/opensesame",
			),
		).toBeUndefined();
		expect(
			problem({ "/usr/bin/opensesame": file(0, 0o755) }, "/usr/bin/opensesame"),
		).toBeUndefined();
	});

	it("refuses a file another user owns, wherever it is", () => {
		const message = problem(
			{ "/usr/bin/opensesame": file(STRANGER, 0o755) },
			"/usr/bin/opensesame",
		);
		expect(message).toMatch(/\/usr\/bin\/opensesame is owned by another user/u);
	});

	it("refuses a file under a directory another user owns, even when the file is the user's", () => {
		const message = problem(
			{
				"/opt": dir(0, 0o755),
				"/opt/tools": dir(STRANGER, 0o755),
				"/opt/tools/opensesame": file(ME, 0o755),
			},
			"/opt/tools/opensesame",
		);
		expect(message).toMatch(/\/opt\/tools is owned by another user/u);
	});

	it("refuses a file group or others can write, and any such directory above it", () => {
		for (const mode of [0o775, 0o757, 0o777, 0o722, 0o702]) {
			expect(
				problem(
					{ "/usr/bin/opensesame": file(0, mode) },
					"/usr/bin/opensesame",
				),
				mode.toString(8),
			).toMatch(/writable by group or others/u);
			expect(
				problem(
					{
						"/opt": dir(0, 0o755),
						"/opt/tools": dir(ME, mode),
						"/opt/tools/opensesame": file(ME, 0o755),
					},
					"/opt/tools/opensesame",
				),
				`dir ${mode.toString(8)}`,
			).toMatch(/\/opt\/tools is writable by group or others/u);
		}
	});

	it("allows a sticky directory the user or root owns, like /tmp, and not one a stranger owns", () => {
		const tree = {
			"/tmp": dir(0, 0o1777),
			"/tmp/mine": dir(ME, 0o700),
			"/tmp/mine/opensesame": file(ME, 0o755),
		};
		expect(problem(tree, "/tmp/mine/opensesame")).toBeUndefined();
		expect(
			problem(
				{ ...tree, "/tmp": dir(STRANGER, 0o1777) },
				"/tmp/mine/opensesame",
			),
		).toMatch(/\/tmp is owned by another user/u);
		expect(
			problem({ ...tree, "/tmp": dir(0, 0o777) }, "/tmp/mine/opensesame"),
		).toMatch(/\/tmp is writable by group or others/u);
	});

	it("follows symlinks and judges where they end, then every directory above that", () => {
		const tree = {
			"/opt": dir(0, 0o755),
			"/opt/real": dir(ME, 0o755),
			"/opt/real/opensesame": file(ME, 0o755),
			"/opt/open": link("/opt/real/opensesame"),
			"/opt/loop": link("/opt/open"),
		};
		expect(problem(tree, "/opt/loop")).toBeUndefined();
		expect(
			problem({ ...tree, "/opt/real": dir(ME, 0o777) }, "/opt/loop"),
		).toMatch(/\/opt\/real is writable by group or others/u);
		expect(problem(tree, "/opt/missing")).toMatch(/does not exist/u);
		expect(
			problem({ "/opt/dangling": link("/opt/nowhere") }, "/opt/dangling"),
		).toMatch(/does not exist/u);
	});

	it("refuses anything under node_modules/.bin, by its own name or by where a link ends", () => {
		const tree = {
			"/srv": dir(0, 0o755),
			"/srv/app": dir(ME, 0o755),
			"/srv/app/node_modules": dir(ME, 0o755),
			"/srv/app/node_modules/.bin": dir(ME, 0o755),
			"/srv/app/node_modules/.bin/opensesame": file(ME, 0o755),
			"/srv/elsewhere": link("/srv/app/node_modules/.bin"),
		};
		expect(problem(tree, "/srv/app/node_modules/.bin/opensesame")).toMatch(
			/node_modules\/\.bin/u,
		);
		expect(problem(tree, "/srv/elsewhere")).toMatch(/node_modules\/\.bin/u);
		expect(problem(tree, "/srv/app/node_modules")).toBeUndefined();
	});

	it("refuses anything inside the working directory tree, a symlink into it included", () => {
		const tree = {
			"/work": dir(0, 0o755),
			"/work/checkout": dir(ME, 0o755),
			"/work/checkout/tools": dir(ME, 0o755),
			"/work/checkout/tools/opensesame": file(ME, 0o755),
			"/opt": dir(0, 0o755),
			"/opt/into-checkout": link("/work/checkout/tools"),
			"/work/other": dir(ME, 0o755),
		};
		const at = { cwd: "/work/checkout" };
		expect(problem(tree, "/work/checkout", at)).toMatch(/working directory/u);
		expect(problem(tree, "/work/checkout/tools/opensesame", at)).toMatch(
			/working directory/u,
		);
		expect(problem(tree, "/opt/into-checkout", at)).toMatch(
			/working directory/u,
		);
		expect(problem(tree, "/work/other", at)).toBeUndefined();
		expect(problem(tree, "/work/checkout-two", at)).toMatch(/does not exist/u);
	});

	it("does not call a home directory or the root a project, whatever runs from it", () => {
		const tree = {
			"/home": dir(0, 0o755),
			"/home/me": dir(ME, 0o755),
			"/home/me/.local": dir(ME, 0o755),
			"/home/me/.local/bin": dir(ME, 0o755),
		};
		expect(
			problem(tree, "/home/me/.local/bin", {
				cwd: "/home/me",
				home: "/home/me",
			}),
		).toBeUndefined();
		expect(
			problem(tree, "/home/me/.local/bin", { cwd: "/", home: "/home/me" }),
		).toBeUndefined();
		expect(
			problem(tree, "/home/me/.local/bin", {
				cwd: "/home/me/.local",
				home: "/home/me",
			}),
		).toMatch(/working directory/u);
	});

	it("checks no ownership or mode where there is no effective uid, but still keeps out the working tree and node_modules/.bin", () => {
		const tree = {
			"/opt": dir(STRANGER, 0o777),
			"/opt/opensesame": file(STRANGER, 0o777),
			"/work": dir(0, 0o755),
			"/work/checkout": dir(0, 0o755),
		};
		expect(
			problem(tree, "/opt/opensesame", { euid: undefined }),
		).toBeUndefined();
		expect(problem(tree, "/work/checkout", { euid: undefined })).toMatch(
			/working directory/u,
		);
	});
});

describe("the PATH a run is started with keeps only places that pass the same rule", () => {
	const nodes = {
		...SYSTEM,
		"/usr/sbin": dir(0, 0o755),
		"/opt": dir(0, 0o755),
		"/opt/shared": dir(STRANGER, 0o755),
		"/opt/open": dir(ME, 0o777),
		"/opt/mine": dir(ME, 0o755),
		"/opt/link-to-mine": link("/opt/mine"),
		"/work": dir(0, 0o755),
		"/work/checkout": dir(ME, 0o755),
		"/work/checkout/node_modules": dir(ME, 0o755),
		"/work/checkout/node_modules/.bin": dir(ME, 0o755),
		"/opt/into-checkout": link("/work/checkout"),
		"/opt/a-file": file(ME, 0o755),
	};
	const trust = memoryTrust(nodes, { cwd: "/work/checkout" });
	const make = (value: string | undefined) =>
		trustedPath(value, trust, "linux", {});

	it("drops empty, relative, missing, non-directory, foreign-owned, writable, project and node_modules entries", () => {
		expect(
			make(
				[
					"",
					".",
					"..",
					"bin",
					"./bin",
					"/nowhere",
					"/opt/a-file",
					"/opt/shared",
					"/opt/open",
					"/opt/into-checkout",
					"/work/checkout/node_modules/.bin",
					"/usr/local/bin",
					"/usr/bin",
					"",
				].join(":"),
			),
		).toBe("/usr/local/bin:/usr/bin");
	});

	it("drops a sticky directory group or others can write, /tmp included: sticky stops them removing a name, not adding one, and a lookup is by name", () => {
		const sticky = memoryTrust(
			{
				...nodes,
				"/tmp": dir(0, 0o1777),
				"/opt/drop": dir(ME, 0o1777),
				"/opt/team": dir(ME, 0o1775),
			},
			{ cwd: "/work/checkout" },
		);
		expect(
			trustedPath("/tmp:/opt/drop:/opt/team:/usr/bin", sticky, "linux", {}),
		).toBe("/usr/bin");
		expect(trustedPath("/tmp", sticky, "linux", {})).toBe(
			"/usr/local/bin:/usr/bin:/bin",
		);
	});

	it("writes a symlinked entry as where it ends, once", () => {
		expect(make("/opt/link-to-mine:/opt/mine:/usr/bin")).toBe(
			"/opt/mine:/usr/bin",
		);
	});

	it("falls back to the fixed system directories, each held to the rule, when nothing is left", () => {
		for (const value of [
			undefined,
			"",
			".",
			":",
			"/nowhere:rel",
			"/opt/shared:/opt/open",
		]) {
			expect(make(value), String(value)).toBe("/usr/local/bin:/usr/bin:/bin");
		}
	});

	it("does not offer back a fallback directory the rule refused: /usr/local/bin is where hosted images leave a 0777 directory", () => {
		const shared = memoryTrust(
			{
				...nodes,
				"/usr/local/bin": dir(ME, 0o777),
				"/bin": dir(STRANGER, 0o755),
			},
			{ cwd: "/work/checkout" },
		);
		for (const value of [undefined, "", "/usr/local/bin", "/opt/shared:/bin"]) {
			expect(trustedPath(value, shared, "linux", {}), String(value)).toBe(
				"/usr/bin",
			);
		}
		const sticky = memoryTrust(
			{ ...nodes, "/usr/local/bin": dir(0, 0o1777) },
			{ cwd: "/work/checkout" },
		);
		expect(trustedPath("/nowhere", sticky, "linux", {})).toBe("/usr/bin:/bin");
	});

	it("refuses the run when no directory passes, and never returns an empty PATH: an empty PATH makes execvp search the working directory", () => {
		const none: Parameters<typeof memoryTrust>[0][] = [
			{},
			{
				"/": dir(0, 0o755),
				"/usr": dir(0, 0o755),
				"/usr/bin": dir(ME, 0o777),
				"/usr/local": dir(0, 0o755),
				"/usr/local/bin": dir(ME, 0o777),
				"/bin": dir(ME, 0o777),
			},
			{
				"/": dir(0, 0o755),
				"/usr": dir(0, 0o755),
				"/usr/bin": dir(STRANGER, 0o755),
				"/usr/local": dir(0, 0o755),
				"/usr/local/bin": dir(STRANGER, 0o755),
				"/bin": dir(STRANGER, 0o755),
			},
		];
		for (const tree of none) {
			for (const value of [undefined, "", ".", "/usr/bin:/bin:/opt/shared"]) {
				const label = `${JSON.stringify(tree)} ${String(value)}`;
				const said = refusalOf(() =>
					trustedPath(
						value,
						memoryTrust(tree, { cwd: "/work/checkout" }),
						"linux",
						{},
					),
				);
				expect(said?.code, label).toBe("bridge_missing");
				// The remedy is a trusted directory on PATH; OPENSESAME_NODE does not help when OpenSesame is never started.
				expect(said?.message, label).toContain("on PATH");
				expect(said?.message, label).not.toContain("OPENSESAME_NODE");
			}
		}
	});

	it("on Windows starts from SystemRoot, held to the same rule, and keeps absolute Windows entries", () => {
		const windows = {
			"C:\\Tools": dir(0, 0o755),
			"C:\\Windows": dir(0, 0o755),
			"C:\\Windows\\System32": dir(0, 0o755),
			"D:\\Win": dir(0, 0o755),
			"D:\\Win\\System32": dir(0, 0o755),
		};
		const win = (value: string | undefined, env: NodeJS.ProcessEnv = {}) =>
			trustedPath(
				value,
				memoryTrust(windows, {
					euid: undefined,
					cwd: "C:\\proj",
					home: "C:\\Users\\me",
				}),
				"win32",
				env,
			);
		expect(win("", { SYSTEMROOT: "D:\\Win" })).toBe(
			"D:\\Win\\System32;D:\\Win",
		);
		expect(win(".;rel;")).toBe("C:\\Windows\\System32;C:\\Windows");
		expect(win("C:\\Tools;C:\\Missing")).toBe("C:\\Tools");
		// A SystemRoot that is not a directory there, or not absolute, is not a fallback either.
		for (const env of [{ SYSTEMROOT: "E:\\Gone" }, { SYSTEMROOT: "." }]) {
			expect(refusalOf(() => win("", env))?.code, JSON.stringify(env)).toBe(
				"bridge_missing",
			);
		}
	});
});
