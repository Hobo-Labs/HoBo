import { isJsonObject, isJsonString } from "../json.js";
import { isRecord } from "../plain-value.js";
import {
	type AnnotationValue,
	type BindMountAnnotation,
	BindReferenceError,
	type ComponentHandle,
	createComponentHandle,
	type ResourceHandle,
	type VolumeAnnotation,
	type WaitForEntry,
} from "./bind-reference.js";

type DependencyRef = string | { readonly name: string };

export function addContainer(
	name: string,
	source: string,
	options: {
		bind?: Readonly<Record<string, ResourceHandle>>;
		env?: Readonly<Record<string, string>>;
	} = {},
): ComponentHandle {
	const handle = createComponentHandle("container", name, {
		image: source,
		...(options.bind !== undefined ? { bind: options.bind } : undefined),
		...(options.env !== undefined ? { env: options.env } : undefined),
		build: {
			provider: "hobo:build",
			source,
			defaultArtifact: "wasm-on-oci",
		},
	});

	// Bound to a local as well as the handle so `withHttpEndpoint` can call it
	// directly. Reaching back through `handle.withEndpoint!` asserted away an
	// optionality the type really does declare.
	const withEndpoint: NonNullable<typeof handle.withEndpoint> = (endpoint) => {
		const endpointName = endpoint.name ?? "http";
		handle.endpoints[endpointName] = {
			scheme: endpoint.scheme,
			port: endpoint.port,
			targetPort: endpoint.targetPort ?? endpoint.port,
			external: endpoint.external ?? false,
			protocol: endpoint.protocol ?? "tcp",
		};
		return handle;
	};
	handle.withEndpoint = withEndpoint;

	handle.withEnvironment = (key, value) => {
		handle.env[key] = value;
		return handle;
	};

	handle.withVolume = (volumeName, target) => {
		const volumes = volumeList(handle.annotations.volumes);
		volumes.push({ name: volumeName, target });
		handle.annotations.volumes = volumes;
		return handle;
	};

	handle.withHttpHealthCheck = (path) => {
		handle.annotations.health = { type: "http", path };
		return handle;
	};

	handle.withHttpEndpoint = (port, endpointOptions = {}) =>
		withEndpoint({
			name: endpointOptions.name ?? "http",
			scheme: "http",
			port,
			...(endpointOptions.targetPort !== undefined
				? { targetPort: endpointOptions.targetPort }
				: undefined),
			...(endpointOptions.external !== undefined
				? { external: endpointOptions.external }
				: undefined),
			...(endpointOptions.protocol !== undefined
				? { protocol: endpointOptions.protocol }
				: undefined),
		});

	handle.withArgs = (...args) => {
		handle.annotations.args = [
			...stringList(handle.annotations.args),
			...args.flat(),
		];
		return handle;
	};

	handle.withBindMount = (mountSource, target, readOnly = false) => {
		const mounts = bindMountList(handle.annotations.bindMounts);
		mounts.push({ source: mountSource, target, readOnly });
		handle.annotations.bindMounts = mounts;
		return handle;
	};

	handle.withLifetime = (lifetime) => {
		if (!["session", "persistent"].includes(lifetime)) {
			throw new BindReferenceError(
				`resources.${name}.lifetime`,
				"lifetime must be one of session, persistent",
			);
		}
		handle.annotations.lifetime = lifetime;
		return handle;
	};

	handle.waitFor = (dependency) => {
		recordWait(handle, name, "waitFor", dependency, "ready");
		return handle;
	};

	handle.waitForCompletion = (dependency) => {
		recordWait(handle, name, "waitForCompletion", dependency, "completed");
		return handle;
	};

	handle.withDnsRecord = () => {
		throw new BindReferenceError(
			`resources.${name}.dns`,
			"DNS is Yard-level and outside the bind reference contract",
		);
	};

	return handle;
}

function recordWait(
	handle: ComponentHandle,
	ownerName: string,
	key: string,
	dependency: DependencyRef,
	until: "ready" | "completed",
): void {
	const target = resolveDependencyName(dependency);
	if (!isJsonString(target) || !/^[A-Za-z][A-Za-z0-9_-]*$/.test(target)) {
		throw new BindReferenceError(
			`resources.${ownerName}.${key}`,
			"must reference a declared resource handle or id",
		);
	}
	const waits = waitList(handle.annotations[key]);
	waits.push({ to: target, until });
	handle.annotations[key] = waits;
}

function stringList(value: AnnotationValue | undefined): string[] {
	if (!Array.isArray(value)) return [];
	const out: string[] = [];
	for (const item of value) {
		if (isJsonString(item)) out.push(item);
	}
	return out;
}

function volumeList(value: AnnotationValue | undefined): VolumeAnnotation[] {
	if (!Array.isArray(value)) return [];
	const out: VolumeAnnotation[] = [];
	for (const item of value) {
		if (isJsonString(item) || !isJsonObject(item)) continue;
		if (
			isJsonString(item.name) &&
			isJsonString(item.target) &&
			item.source === undefined
		) {
			out.push({ name: item.name, target: item.target });
		}
	}
	return out;
}

function bindMountList(
	value: AnnotationValue | undefined,
): BindMountAnnotation[] {
	if (!Array.isArray(value)) return [];
	const out: BindMountAnnotation[] = [];
	for (const item of value) {
		if (isJsonString(item) || !isJsonObject(item)) continue;
		if (isJsonString(item.source) && isJsonString(item.target)) {
			out.push({
				source: item.source,
				target: item.target,
				readOnly: item.readOnly === true,
			});
		}
	}
	return out;
}

function waitList(value: AnnotationValue | undefined): WaitForEntry[] {
	if (!Array.isArray(value)) return [];
	const out: WaitForEntry[] = [];
	for (const item of value) {
		if (isJsonString(item) || !isJsonObject(item)) continue;
		if (isJsonString(item.to) && isJsonString(item.until)) {
			out.push({ to: item.to, until: item.until });
		}
	}
	return out;
}

function resolveDependencyName(dependency: DependencyRef): string | null {
	if (isJsonString(dependency)) {
		return dependency;
	}
	if (isRecord(dependency) && isJsonString(dependency.name)) {
		return dependency.name;
	}
	return null;
}
