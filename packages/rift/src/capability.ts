import { spawnSync } from "node:child_process";
import {
	chmodSync,
	mkdtempSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type CowTier = "reflink" | "overlayfs" | "hardlink" | "copy";

export interface RiftContract {
	readonly execArgvVector: boolean;
	readonly namespaceMarker: boolean;
}

// domain-view: wire form is hobo.rift.v1.Capability; src/wire.ts converts.
export interface Capability {
	readonly tier: CowTier;
	readonly available: readonly CowTier[];
	readonly reason: string;
	readonly isolatesInPlaceWrites: boolean;
	readonly contract?: RiftContract;
}

function run(cmd: string, args: readonly string[]): number | null {
	const r = spawnSync(cmd, [...args], { stdio: "ignore" });
	return r.status;
}

export function removeCopyOnWriteTree(dir: string): void {
	run("chmod", ["-R", "u+rwx", dir]);
	rmSync(dir, { recursive: true, force: true });
}

export function probeReflink(dir: string): boolean {
	const probe = mkdtempSync(join(dir, ".rift-probe-"));
	try {
		writeFileSync(join(probe, "a"), "x");
		return (
			run("cp", ["--reflink=always", join(probe, "a"), join(probe, "b")]) === 0
		);
	} catch {
		return false;
	} finally {
		rmSync(probe, { recursive: true, force: true });
	}
}

function restoreOwnerAccess(dir: string): void {
	try {
		chmodSync(dir, 0o700);
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			if (entry.isDirectory()) restoreOwnerAccess(join(dir, entry.name));
		}
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") {
			return;
		}
		throw error;
	}
}

export function removeOverlayProbe(probe: string): void {
	try {
		const merged = join(probe, "merged");
		run("umount", [merged]);
	} catch {}
	try {
		restoreOwnerAccess(probe);
		removeCopyOnWriteTree(probe);
	} catch {}
}

export function probeOverlayfs(dir: string = tmpdir()): boolean {
	let probe: string;
	try {
		probe = mkdtempSync(join(dir, ".rift-ovl-"));
	} catch {
		probe = mkdtempSync(join(tmpdir(), "rift-ovl-"));
	}
	try {
		const lower = join(probe, "lower");
		const upper = join(probe, "upper");
		const work = join(probe, "work");
		const merged = join(probe, "merged");
		const q = (v: string) => `'${v.replace(/'/gu, `'\\''`)}'`;
		const m = (v: string) => v.replace(/([\\,:])/gu, "\\$1");
		const options = `lowerdir=${m(lower)},upperdir=${m(upper)},workdir=${m(work)}`;
		const status = run("unshare", [
			"-Urm",
			"sh",
			"-c",
			`mkdir -p ${q(lower)} ${q(upper)} ${q(work)} ${q(merged)} && mount -t overlay overlay -o ${q(options)} ${q(merged)}`,
		]);
		return status === 0;
	} catch {
		return false;
	} finally {
		removeOverlayProbe(probe);
	}
}

export function probeHardlink(dir: string): boolean {
	const probe = mkdtempSync(join(dir, ".rift-probe-"));
	try {
		writeFileSync(join(probe, "a"), "x");
		return run("cp", ["-al", join(probe, "a"), join(probe, "b")]) === 0;
	} catch {
		return false;
	} finally {
		rmSync(probe, { recursive: true, force: true });
	}
}

export interface ProbeOverrides {
	readonly reflink?: (dir: string) => boolean;
	readonly overlayfs?: (dir: string) => boolean;
	readonly hardlink?: (dir: string) => boolean;
}

export function detectCapability(
	dir: string,
	overrides: ProbeOverrides = {},
): Capability {
	const reflink = (overrides.reflink ?? probeReflink)(dir);
	const overlayfs = (overrides.overlayfs ?? probeOverlayfs)(dir);
	const hardlink = (overrides.hardlink ?? probeHardlink)(dir);
	const available: CowTier[] = [];
	if (reflink) available.push("reflink");
	if (overlayfs) available.push("overlayfs");
	if (hardlink) available.push("hardlink");
	available.push("copy");

	const tier: CowTier = reflink
		? "reflink"
		: overlayfs
			? "overlayfs"
			: hardlink
				? "hardlink"
				: "copy";
	const reason =
		tier === "reflink"
			? "filesystem supports FICLONE reflinks"
			: tier === "overlayfs"
				? "no reflinks; using unprivileged overlayfs copy-on-write"
				: tier === "hardlink"
					? "no reflinks or overlayfs; hardlinks are instant but in-place writes reach the source"
					: "no copy-on-write primitive available; falling back to a full copy";
	return {
		tier,
		available,
		reason,
		isolatesInPlaceWrites: tier !== "hardlink",
	};
}
