/**
 * What copy-on-write primitive does *this* machine actually have?
 *
 * Upstream rift needs btrfs, reflink-capable XFS, or APFS, and ships
 * per-platform binaries — on a plain ext4 arm64 box it cannot run at all.
 * That is not a reason to give agents a shared checkout; it is a reason to
 * pick the best primitive the kernel will give us.
 *
 * The ladder, best first:
 *
 * | tier      | mechanism                  | instant | space | in-place writes |
 * |-----------|----------------------------|---------|-------|-----------------|
 * | reflink   | FICLONE (btrfs/XFS/APFS)   | yes     | shared| isolated        |
 * | overlayfs | unprivileged userns overlay| yes     | diff  | isolated        |
 * | hardlink  | cp -al                     | yes     | shared| **propagate**   |
 * | copy      | cp -a                      | no      | full  | isolated        |
 *
 * Hardlink sits below overlayfs deliberately: `mv` breaks a hardlink safely,
 * but an in-place append (`>>`, `sed -i` without a temp file) writes straight
 * through to the original. That is a data-loss shape, so it is only used when
 * nothing better exists.
 */

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

// The parsed domain form of hobo.rift.v1.Capability: a string-literal tier
// rather than a numeric enum, so an unhandled tier is a compile error.
/**
 * Behaviours a caller may depend on.
 *
 * `hobo-code` composes commands that only work against a sidecar which quotes
 * its argv vector and marks the namespace. Both arrived after the first
 * release, and a sidecar found on PATH may predate them — silently, since the
 * older one accepts the same flags and simply mangles them. Advertising the
 * contract is what lets the caller notice instead of shipping an injection.
 *
 * The values are **derived from the code that implements them** (see
 * `deriveContract` in workspace.ts), never asserted as constants. A constant
 * would keep reading `true` through a refactor that dropped the behaviour, so
 * the guard would catch old sidecars and miss regressed ones — the more likely
 * failure by far.
 */
export interface RiftContract {
	/** `exec -- cmd args…` quotes each element rather than joining on spaces. */
	readonly execArgvVector: boolean;
	/** `exec` sets HOBO_RIFT_WORKSPACE inside the namespace. */
	readonly namespaceMarker: boolean;
}

// domain-view: wire form is hobo.rift.v1.Capability; src/wire.ts converts.
export interface Capability {
	readonly tier: CowTier;
	/** Every tier that probed successfully, best first. */
	readonly available: readonly CowTier[];
	/** Why the chosen tier, in one line. */
	readonly reason: string;
	/** True when writes in a workspace cannot reach the source. */
	readonly isolatesInPlaceWrites: boolean;
	/** Behaviours this build guarantees; absent on builds that predate it. */
	readonly contract?: RiftContract;
}

function run(cmd: string, args: readonly string[]): number | null {
	const r = spawnSync(cmd, [...args], { stdio: "ignore" });
	return r.status;
}

/** Overlay probe leaves `work/work` at mode 000; chmod before rm or HOBO_HOME teardown EACCES. */
export function removeCopyOnWriteTree(dir: string): void {
	run("chmod", ["-R", "u+rwx", dir]);
	rmSync(dir, { recursive: true, force: true });
}

/** Can this directory take a FICLONE reflink? */
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
	} catch {
		// Probe may never have mounted.
	}
	try {
		restoreOwnerAccess(probe);
		removeCopyOnWriteTree(probe);
	} catch {
		// Cleanup failure must not change the probe result.
	}
}

/**
 * Can we mount an overlay in an unprivileged user namespace **on this
 * filesystem**?
 *
 * The directory matters: probing `/tmp` and then recording `overlayfs` for a
 * project on a filesystem that cannot host the `upperdir` bakes in a tier that
 * fails on every later `exec`, with no fallback left. Falls back to the
 * temporary directory only when the target is not writable.
 */
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
		// Quoted and escaped exactly as execCommand does it: an unquoted probe
		// failed on any path containing a space and silently demoted the machine
		// to the hardlink tier, where in-place writes reach the source.
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

/** Can we hardlink within this directory? */
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

/** Choose the best tier available for `dir`. */
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

	// `copy` is pushed unconditionally above, so `available` is never empty.
	// Naming the winner directly makes that fact visible to the checker.
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
