import { describe, expect, it } from "vitest";
import {
	alchemySourceFor,
	captureAlchemySourceFence,
	captureAlchemySourceRequirements,
	registerAlchemySource,
	verifyAlchemySourceFence,
} from "../src/source-fence.js";

const claim = {
	resourceId: "web",
	resourceType: "Spec.Worker",
	bindleName: "app",
	applicationName: "web",
	sourceKind: "module",
	sourcePath: "/source/app.ts",
	sourceDigest: `sha256:${"a".repeat(64)}`,
	environmentDigest: `sha256:${"b".repeat(64)}`,
	proofRef: "host:proof",
};

describe("trusted source fences", () => {
	it("retains exact source registrations when a verifier replaces WeakMap methods", () => {
		const resource = { FQN: claim.resourceId, Type: claim.resourceType };
		const verify = () => true;
		const originalHas = WeakMap.prototype.has;
		const originalGet = WeakMap.prototype.get;
		const originalSet = WeakMap.prototype.set;
		const fence = captureAlchemySourceFence({
			sourceDigest: claim.sourceDigest,
			environmentDigest: claim.environmentDigest,
			proofRef: claim.proofRef,
			verify: () => {
				Reflect.set(WeakMap.prototype, "has", () => false);
				Reflect.set(WeakMap.prototype, "get", () => undefined);
				Reflect.set(WeakMap.prototype, "set", function () {
					return this;
				});
				return true;
			},
		});
		if (!fence) throw new Error("test fence missing");
		let found: ReturnType<typeof alchemySourceFor>;
		let duplicateRejected = false;
		try {
			verifyAlchemySourceFence(fence, claim);
			registerAlchemySource(resource, { claim, verify });
			found = alchemySourceFor(resource);
			try {
				registerAlchemySource(resource, { claim, verify });
			} catch {
				duplicateRejected = true;
			}
		} finally {
			Reflect.set(WeakMap.prototype, "has", originalHas);
			Reflect.set(WeakMap.prototype, "get", originalGet);
			Reflect.set(WeakMap.prototype, "set", originalSet);
		}
		expect(found?.claim).toEqual(claim);
		expect(found?.verify).toBe(verify);
		expect(duplicateRejected).toBe(true);
	});

	it.each([
		"trim",
		"digest",
		"control",
	] as const)("rejects malformed source claims after verifier substitution of %s", (kind) => {
		const trim = String.prototype.trim;
		const test = RegExp.prototype.test;
		const badDigest = "sha256:bad";
		const controlled = `web${String.fromCharCode(1)}`;
		const invalid = {
			...claim,
			resourceId:
				kind === "trim" ? " web " : kind === "control" ? controlled : "web",
			sourceDigest: kind === "digest" ? badDigest : claim.sourceDigest,
		};
		const resource = { FQN: invalid.resourceId, Type: invalid.resourceType };
		const fence = captureAlchemySourceFence({
			sourceDigest: claim.sourceDigest,
			environmentDigest: claim.environmentDigest,
			proofRef: claim.proofRef,
			verify: () => {
				Reflect.set(String.prototype, "trim", function () {
					return String(this);
				});
				Reflect.set(
					RegExp.prototype,
					"test",
					function (this: RegExp, value: string) {
						if (value === badDigest && this.source.startsWith("^sha256:"))
							return true;
						if (value === controlled) return false;
						// oxlint-disable-next-line anti-slop/no-reflect-apply -- SAFETY: unrelated regex checks delegate to the captured native method.
						return Reflect.apply(test, this, [value]);
					},
				);
				return true;
			},
		});
		if (!fence) throw new Error("test fence missing");
		let accepted = false;
		try {
			verifyAlchemySourceFence(fence, claim);
			try {
				registerAlchemySource(resource, { claim: invalid, verify: () => true });
				accepted = true;
			} catch {}
		} finally {
			Reflect.set(String.prototype, "trim", trim);
			Reflect.set(RegExp.prototype, "test", test);
		}
		expect(accepted).toBe(false);
	});

	it("rejects a malformed digest after the verifier replaces RegExp exec", () => {
		const exec = RegExp.prototype.exec;
		const badDigest = "sha256:bad";
		const fence = captureAlchemySourceFence({
			sourceDigest: claim.sourceDigest,
			environmentDigest: claim.environmentDigest,
			proofRef: claim.proofRef,
			verify: () => {
				Reflect.set(
					RegExp.prototype,
					"exec",
					function (this: RegExp, value: string) {
						if (value === badDigest && this.source.startsWith("^sha256:"))
							return [];
						// oxlint-disable-next-line anti-slop/no-reflect-apply -- SAFETY: unrelated regex checks delegate to the captured native method.
						return Reflect.apply(exec, this, [value]);
					},
				);
				return true;
			},
		});
		if (!fence) throw new Error("test fence missing");
		let accepted = false;
		try {
			verifyAlchemySourceFence(fence, claim);
			try {
				registerAlchemySource(
					{ FQN: claim.resourceId, Type: claim.resourceType },
					{ claim: { ...claim, sourceDigest: badDigest }, verify: () => true },
				);
				accepted = true;
			} catch {}
		} finally {
			Reflect.set(RegExp.prototype, "exec", exec);
		}
		expect(accepted).toBe(false);
	});

	it("rejects duplicate or decorated requirements after verifier changes collection methods", () => {
		const requirement = {
			resourceId: claim.resourceId,
			resourceType: claim.resourceType,
			bindleName: claim.bindleName,
			applicationName: claim.applicationName,
			sourceKind: claim.sourceKind,
			sourcePath: claim.sourcePath,
		};
		const decorated = [requirement];
		Object.defineProperty(decorated, "extra", {
			value: true,
			enumerable: true,
		});
		const nativeSome = Array.prototype.some;
		const nativeHas = Set.prototype.has;
		const nativeAdd = Set.prototype.add;
		const fence = captureAlchemySourceFence({
			sourceDigest: claim.sourceDigest,
			environmentDigest: claim.environmentDigest,
			proofRef: claim.proofRef,
			verify: () => {
				Reflect.set(Array.prototype, "some", () => false);
				Reflect.set(Set.prototype, "has", () => false);
				Reflect.set(Set.prototype, "add", function () {
					return this;
				});
				return true;
			},
		});
		if (!fence) throw new Error("test fence missing");
		let duplicate: ReturnType<typeof captureAlchemySourceRequirements>;
		let extra: ReturnType<typeof captureAlchemySourceRequirements>;
		try {
			verifyAlchemySourceFence(fence, claim);
			duplicate = captureAlchemySourceRequirements([requirement, requirement]);
			extra = captureAlchemySourceRequirements(decorated);
		} finally {
			Reflect.set(Array.prototype, "some", nativeSome);
			Reflect.set(Set.prototype, "has", nativeHas);
			Reflect.set(Set.prototype, "add", nativeAdd);
		}
		expect(duplicate).toBeUndefined();
		expect(extra).toBeUndefined();
	});

	it("preserves dense requirements without invoking an inherited numeric setter", () => {
		const requirement = {
			resourceId: claim.resourceId,
			resourceType: claim.resourceType,
			bindleName: claim.bindleName,
			applicationName: claim.applicationName,
			sourceKind: claim.sourceKind,
			sourcePath: claim.sourcePath,
		};
		const input = [requirement];
		const previous = Object.getOwnPropertyDescriptor(Array.prototype, "0");
		let setterCalls = 0;
		const fence = captureAlchemySourceFence({
			sourceDigest: claim.sourceDigest,
			environmentDigest: claim.environmentDigest,
			proofRef: claim.proofRef,
			verify: () => {
				Object.defineProperty(Array.prototype, "0", {
					configurable: true,
					set() {
						setterCalls++;
					},
				});
				return true;
			},
		});
		if (!fence) throw new Error("test fence missing");
		let captured: ReturnType<typeof captureAlchemySourceRequirements>;
		try {
			verifyAlchemySourceFence(fence, claim);
			captured = captureAlchemySourceRequirements(input);
		} finally {
			if (previous) Object.defineProperty(Array.prototype, "0", previous);
			else Reflect.deleteProperty(Array.prototype, "0");
		}
		expect(setterCalls).toBe(0);
		expect(captured).toEqual(input);
		expect(Object.getOwnPropertyDescriptor(captured, "0")).toMatchObject({
			value: requirement,
			enumerable: true,
		});
	});

	it("rejects a proxied source verifier without invoking its traps", () => {
		let traps = 0;
		const verify = new Proxy(() => true, {
			getPrototypeOf() {
				traps++;
				return Function.prototype;
			},
		});
		const resource = { FQN: claim.resourceId, Type: claim.resourceType };
		expect(() => registerAlchemySource(resource, { claim, verify })).toThrow();
		expect(traps).toBe(0);
	});
	it("keeps captured reflection and freezing intrinsics for source evidence", () => {
		let reads = 0;
		const input = {
			get sourceDigest() {
				reads++;
				return claim.sourceDigest;
			},
			environmentDigest: claim.environmentDigest,
			proofRef: claim.proofRef,
			verify: () => true,
		};
		const descriptors = Object.getOwnPropertyDescriptors;
		const freeze = Object.freeze;
		const forged = descriptors({ ...input, sourceDigest: claim.sourceDigest });
		const valid = {
			sourceDigest: claim.sourceDigest,
			environmentDigest: claim.environmentDigest,
			proofRef: claim.proofRef,
			verify: () => true,
		};
		reads = 0;
		let result: unknown;
		let captured: unknown;
		try {
			Reflect.set(Object, "getOwnPropertyDescriptors", (value: typeof input) =>
				value === input ? forged : descriptors(value),
			);
			Reflect.set(Object, "freeze", (value: typeof valid) => value);
			result = captureAlchemySourceFence(input);
			captured = captureAlchemySourceFence(valid);
		} finally {
			Object.getOwnPropertyDescriptors = descriptors;
			Object.freeze = freeze;
		}
		expect(result).toBeUndefined();
		expect(reads).toBe(0);
		expect(captured).toBeDefined();
		expect(Object.isFrozen(captured)).toBe(true);
	});

	it("refuses and observes a rejected asynchronous verifier", async () => {
		const fence = captureAlchemySourceFence({
			sourceDigest: claim.sourceDigest,
			environmentDigest: claim.environmentDigest,
			proofRef: claim.proofRef,
			// oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- SAFETY: the host callback deliberately violates the synchronous contract.
			verify: (() => Promise.reject(new Error("source rejected"))) as never,
		});
		if (fence === undefined) throw new Error("test fence missing");
		expect(verifyAlchemySourceFence(fence, claim)).toBe(false);
		await new Promise<void>((resolve) => setImmediate(resolve));
	});

	it("does not accept inherited descriptor-map entries for missing source fields", () => {
		const fields = [
			"resourceId",
			"resourceType",
			"bindleName",
			"applicationName",
			"sourceKind",
			"sourcePath",
		] as const;
		const values = [
			"web",
			"Spec.Worker",
			"app",
			"web",
			"module",
			"/source/app.ts",
		];
		const previous = fields.map((key) =>
			Object.getOwnPropertyDescriptor(Object.prototype, key),
		);
		const impostor = { x1: 1, x2: 2, x3: 3, x4: 4, x5: 5, x6: 6 };
		for (let index = 0; index < fields.length; index++) {
			const key = fields[index];
			if (key !== undefined)
				Object.defineProperty(Object.prototype, key, {
					configurable: true,
					writable: true,
					value: { value: values[index], enumerable: true },
				});
		}
		let result: unknown;
		try {
			// oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- SAFETY: the malformed resource intentionally probes inherited descriptor maps.
			result = captureAlchemySourceRequirements([impostor] as never);
		} finally {
			for (let index = 0; index < fields.length; index++) {
				const key = fields[index];
				if (key === undefined) continue;
				const old = previous[index];
				if (old === undefined) Reflect.deleteProperty(Object.prototype, key);
				else Object.defineProperty(Object.prototype, key, old);
			}
		}
		expect(result).toBeUndefined();
	});

	it("snapshots an authority and refuses later mutation or mismatched claims", () => {
		let allowed = true;
		const input = {
			sourceDigest: claim.sourceDigest,
			environmentDigest: claim.environmentDigest,
			proofRef: claim.proofRef,
			verify: () => allowed,
		};
		const fence = captureAlchemySourceFence(input);
		expect(fence).toBeDefined();
		if (fence === undefined) throw new Error("test fence missing");
		input.sourceDigest = `sha256:${"c".repeat(64)}`;
		input.verify = () => false;
		expect(verifyAlchemySourceFence(fence, claim)).toBe(true);
		expect(
			verifyAlchemySourceFence(fence, {
				...claim,
				sourceDigest: input.sourceDigest,
			}),
		).toBe(false);
		allowed = false;
		expect(verifyAlchemySourceFence(fence, claim)).toBe(false);
	});

	it("refuses accessor-swapped and malformed host proofs without invoking getters", () => {
		let invoked = false;
		const withGetter = {
			get sourceDigest() {
				invoked = true;
				return claim.sourceDigest;
			},
			environmentDigest: claim.environmentDigest,
			proofRef: claim.proofRef,
			verify: () => true,
		};
		expect(captureAlchemySourceFence(withGetter)).toBeUndefined();
		expect(invoked).toBe(false);
		expect(
			captureAlchemySourceFence({
				sourceDigest: "bad",
				environmentDigest: claim.environmentDigest,
				proofRef: claim.proofRef,
				verify: () => true,
			}),
		).toBeUndefined();
	});
});
