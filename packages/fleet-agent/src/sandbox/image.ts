/**
 * Image store for the OCI sandbox drivers: turns an image reference
 * (`docker.io/library/busybox:1.37`, `busybox@sha256:…`) into an unpacked root
 * file system, pulled from its registry over the distribution API and cached
 * by manifest digest. The root file system is mounted read-only into every
 * sandbox made from it, so one copy serves them all.
 *
 * Every manifest and blob is checked against its sha256 digest before use; a
 * pinned reference (`@sha256:…`) is checked against the manifest it fetched.
 * Layers are unpacked in order with the host's `tar`, applying OCI whiteouts.
 */

import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
	existsSync,
	lchownSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";

export type ImageStore = Readonly<{
	/** The directory holding the unpacked root file system of `image`. */
	rootfs(image: string): Promise<string>;
}>;

export type ImageReference = Readonly<{
	registry: string;
	repository: string;
	tag: string;
	digest: string | undefined;
}>;

/** Parses `[registry/]repository[:tag][@sha256:hex]`, with Docker Hub's defaults. */
export function parseImageReference(image: string): ImageReference | undefined {
	const match =
		/^(?:([a-z0-9.-]+(?::\d+)?|localhost(?::\d+)?)\/)?([a-z0-9]+(?:[._/-][a-z0-9]+)*)(?::([\w][\w.-]{0,127}))?(?:@(sha256:[a-f0-9]{64}))?$/u.exec(
			image,
		);
	if (match === null) return undefined;
	let registry = match[1];
	let repository = match[2] ?? "";
	// A first component without a dot, a port or "localhost" is a Hub namespace.
	if (
		registry !== undefined &&
		!registry.includes(".") &&
		!registry.includes(":") &&
		registry !== "localhost"
	) {
		repository = `${registry}/${repository}`;
		registry = undefined;
	}
	registry ??= "docker.io";
	if (registry === "docker.io" || registry === "index.docker.io") {
		registry = "registry-1.docker.io";
		if (!repository.includes("/")) repository = `library/${repository}`;
	}
	return {
		registry,
		repository,
		tag: match[3] ?? "latest",
		digest: match[4],
	};
}

const MANIFEST_TYPES = [
	"application/vnd.oci.image.index.v1+json",
	"application/vnd.docker.distribution.manifest.list.v2+json",
	"application/vnd.oci.image.manifest.v1+json",
	"application/vnd.docker.distribution.manifest.v2+json",
].join(", ");

type Descriptor = Readonly<{
	digest: string;
	mediaType?: string;
	platform?: Readonly<{ os?: string; architecture?: string }>;
}>;
/** domain-view: the fields of an OCI image index or manifest this store reads. */
type ManifestDocument = Readonly<{
	mediaType?: string;
	manifests?: readonly Descriptor[];
	layers?: readonly Descriptor[];
}>;

const sha256 = (bytes: Uint8Array) =>
	`sha256:${createHash("sha256").update(bytes).digest("hex")}`;

/** OCI architecture name of this host. */
export function hostArchitecture(): string {
	return process.arch === "x64" ? "amd64" : process.arch;
}

/** Unpacks `archive` into `dir` with the host's tar (compression detected by tar). */
export function untar(archive: string, dir: string): Promise<void> {
	return new Promise((resolve, reject) => {
		const child = spawn(
			"tar",
			["-x", "-f", archive, "-C", dir, "--no-same-permissions"],
			{
				stdio: ["ignore", "ignore", "pipe"],
			},
		);
		let stderr = "";
		child.stderr.on("data", (chunk) => {
			stderr += String(chunk);
		});
		child.on("error", reject);
		child.on("close", (code) =>
			code === 0
				? resolve()
				: reject(new Error(`tar exited ${code}: ${stderr.slice(0, 300)}`)),
		);
	});
}

/** Applies and removes the OCI whiteout entries a layer left in `dir`. */
export function applyWhiteouts(dir: string): void {
	for (const name of readdirSync(dir)) {
		if (name === ".wh..wh..opq") rmSync(join(dir, name), { force: true });
		else if (name.startsWith(".wh.")) {
			rmSync(join(dir, name.slice(4)), { recursive: true, force: true });
			rmSync(join(dir, name), { force: true });
		}
	}
	for (const entry of readdirSync(dir, { withFileTypes: true }))
		if (entry.isDirectory()) applyWhiteouts(join(dir, entry.name));
}

/** Adds `shift` to the owner and group of `path` and everything under it, without following links. */
export function shiftOwners(
	path: string,
	shift: number,
	seen: Set<string> = new Set(),
): void {
	const stat = lstatSync(path);
	// Hard links share an inode: shift each inode once.
	const inode = `${stat.dev}:${stat.ino}`;
	if (!seen.has(inode)) {
		seen.add(inode);
		lchownSync(path, stat.uid + shift, stat.gid + shift);
	}
	if (stat.isDirectory())
		for (const entry of readdirSync(path))
			shiftOwners(join(path, entry), shift, seen);
}

/** Removes everything in `dir` that an opaque whiteout in a layer hides, before unpacking it. */
async function opaqueDirectories(archive: string): Promise<readonly string[]> {
	const listing = await new Promise<string>((resolve, reject) => {
		const child = spawn("tar", ["-t", "-f", archive], {
			stdio: ["ignore", "pipe", "ignore"],
		});
		let out = "";
		child.stdout.on("data", (chunk) => {
			out += String(chunk);
		});
		child.on("error", reject);
		child.on("close", () => resolve(out));
	});
	return listing
		.split("\n")
		.filter((line) => line.endsWith(".wh..wh..opq"))
		.map((line) => line.slice(0, -".wh..wh..opq".length));
}

export function createRegistryImageStore(
	options: Readonly<{
		cacheDir: string;
		fetch: typeof fetch;
		architecture?: string;
		/** Added to every owner id after unpacking: the rootful agent's id remapping base, so a sandbox's root owns its root file system. */
		idShift?: number;
		extract?: (archive: string, dir: string) => Promise<void>;
	}>,
): ImageStore {
	const architecture = options.architecture ?? hostArchitecture();
	const extract = options.extract ?? untar;
	const idShift = options.idShift ?? 0;
	const rootfsDir = join(
		options.cacheDir,
		idShift === 0 ? "rootfs" : `rootfs-${idShift}`,
	);
	const pending = new Map<string, Promise<string>>();
	const tokens = new Map<string, string>();

	async function get(
		reference: ImageReference,
		path: string,
		accept: string,
	): Promise<Uint8Array> {
		const url = `https://${reference.registry}/v2/${reference.repository}/${path}`;
		const headers = (): Record<string, string> => {
			const token = tokens.get(reference.repository);
			return token === undefined
				? { accept }
				: { accept, authorization: `Bearer ${token}` };
		};
		let answer = await options.fetch(url, { headers: headers() });
		if (answer.status === 401) {
			const challenge = answer.headers.get("www-authenticate") ?? "";
			const realm = /realm="([^"]+)"/u.exec(challenge)?.[1];
			if (realm === undefined)
				throw new Error(`${reference.registry} asked for credentials`);
			const service = /service="([^"]+)"/u.exec(challenge)?.[1];
			const query = new URLSearchParams({
				scope: `repository:${reference.repository}:pull`,
			});
			if (service !== undefined) query.set("service", service);
			const tokenAnswer = await options.fetch(`${realm}?${query}`);
			if (!tokenAnswer.ok)
				throw new Error(
					`${reference.registry} refused an anonymous token (${tokenAnswer.status})`,
				);
			const body: Readonly<{ token?: string; access_token?: string }> =
				JSON.parse(await tokenAnswer.text());
			const token = body.token ?? body.access_token;
			if (token === undefined)
				throw new Error(`${reference.registry} answered no token`);
			tokens.set(reference.repository, token);
			answer = await options.fetch(url, { headers: headers() });
		}
		if (!answer.ok)
			throw new Error(
				`${reference.registry}/${reference.repository} ${path}: ${answer.status}`,
			);
		return new Uint8Array(await answer.arrayBuffer());
	}

	async function manifest(
		reference: ImageReference,
		ref: string,
		expected: string | undefined,
	): Promise<Readonly<{ digest: string; document: ManifestDocument }>> {
		const bytes = await get(reference, `manifests/${ref}`, MANIFEST_TYPES);
		const digest = sha256(bytes);
		if (expected !== undefined && digest !== expected)
			throw new Error(
				`manifest ${ref} has digest ${digest}, expected ${expected}`,
			);
		const document: ManifestDocument = JSON.parse(
			new TextDecoder().decode(bytes),
		);
		return { digest, document };
	}

	async function pull(image: string): Promise<string> {
		const reference = parseImageReference(image);
		if (reference === undefined)
			throw new Error(`not an image reference: ${image}`);
		let top = await manifest(
			reference,
			reference.digest ?? reference.tag,
			reference.digest,
		);
		if (top.document.manifests !== undefined) {
			const chosen = top.document.manifests.find(
				(entry) =>
					entry.platform?.os === "linux" &&
					entry.platform.architecture === architecture,
			);
			if (chosen === undefined)
				throw new Error(`${image} has no linux/${architecture} manifest`);
			top = await manifest(reference, chosen.digest, chosen.digest);
		}
		const layers = top.document.layers;
		if (layers === undefined) throw new Error(`${image} has no layers`);
		const root = join(rootfsDir, top.digest.slice(7));
		if (existsSync(root)) return root;
		// 0711: a sandbox's remapped root must traverse to its root file system.
		mkdirSync(rootfsDir, { recursive: true, mode: 0o711 });
		const work = `${root}.partial-${randomBytes(4).toString("hex")}`;
		const unpacked = join(work, "rootfs");
		mkdirSync(unpacked, { recursive: true });
		try {
			for (const [index, layer] of layers.entries()) {
				const bytes = await get(reference, `blobs/${layer.digest}`, "*/*");
				if (sha256(bytes) !== layer.digest)
					throw new Error(`layer ${layer.digest} failed its digest check`);
				const archive = join(work, `layer-${index}`);
				writeFileSync(archive, bytes);
				for (const opaque of await opaqueDirectories(archive)) {
					const dir = join(unpacked, opaque);
					if (existsSync(dir))
						for (const entry of readdirSync(dir))
							rmSync(join(dir, entry), { recursive: true, force: true });
				}
				await extract(archive, unpacked);
				applyWhiteouts(unpacked);
				rmSync(archive, { force: true });
			}
			if (idShift !== 0) shiftOwners(unpacked, idShift);
			try {
				renameSync(unpacked, root);
			} catch (error) {
				if (!existsSync(root)) throw error;
			}
			return root;
		} finally {
			rmSync(work, { recursive: true, force: true });
		}
	}

	return {
		rootfs(image) {
			let found = pending.get(image);
			if (found === undefined) {
				found = pull(image);
				pending.set(image, found);
				found.catch(() => pending.delete(image));
			}
			return found;
		},
	};
}
