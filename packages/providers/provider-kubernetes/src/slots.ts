import { capability, type SlotBinding, slotBinding } from "@hobo/core";
import { isJsonObject, type JsonBag, type JsonObject } from "./json.js";

function present<T extends object>(options: T): JsonObject {
	const out: JsonBag = {};
	for (const [key, value] of Object.entries(options)) {
		if (value === undefined) {
			continue;
		}
		out[key] =
			isJsonObject(value) && value !== null && !Array.isArray(value)
				? present(value)
				: value;
	}
	return out;
}

export interface ResourceQuantities {
	readonly cpu?: string;
	readonly memory?: string;
}

export interface DeploymentOptions {
	readonly replicas?: number;
	readonly image?: string;
	readonly limits?: ResourceQuantities;
	readonly requests?: ResourceQuantities;
	readonly namespace?: string;
}

export function deployment(options?: DeploymentOptions): SlotBinding {
	return slotBinding({
		slot: "web",
		profile: capability.web.hosted,
		productId: "kubernetes.deployment/v1",
		properties: present(options ?? {}),
	});
}

export function deploymentWorker(options?: DeploymentOptions): SlotBinding {
	return slotBinding({
		slot: "service",
		profile: capability.service.worker,
		productId: "kubernetes.deployment/v1",
		properties: present(options ?? {}),
	});
}

export interface StatefulSetOptions extends DeploymentOptions {
	readonly serviceName?: string;
	readonly volumeClaimStorage?: string;
}

export function statefulSet(options?: StatefulSetOptions): SlotBinding {
	return slotBinding({
		slot: "web",
		profile: capability.web.hosted,
		productId: "kubernetes.statefulset/v1",
		properties: present(options ?? {}),
	});
}

export function statefulSetWorker(options?: StatefulSetOptions): SlotBinding {
	return slotBinding({
		slot: "service",
		profile: capability.service.worker,
		productId: "kubernetes.statefulset/v1",
		properties: present(options ?? {}),
	});
}

export interface DaemonSetOptions extends DeploymentOptions {
	readonly nodeSelector?: Readonly<Record<string, string>>;
}

export function daemonSet(options?: DaemonSetOptions): SlotBinding {
	return slotBinding({
		slot: "service",
		profile: capability.service.worker,
		productId: "kubernetes.daemonset/v1",
		properties: present(options ?? {}),
	});
}

export const SERVICE_TYPES = Object.freeze([
	"ClusterIP",
	"NodePort",
	"LoadBalancer",
] as const);

export type ServiceType = (typeof SERVICE_TYPES)[number];

export interface ServiceOptions {
	readonly type?: ServiceType;
	readonly port?: number;
	readonly targetPort?: number;
	readonly namespace?: string;
}

export function service(options?: ServiceOptions): SlotBinding {
	return slotBinding({
		slot: "api",
		profile: capability.api.http,
		productId: "kubernetes.service/v1",
		properties: present(options ?? {}),
	});
}

export interface IngressOptions {
	readonly className?: string;
	readonly host?: string;
	readonly path?: string;
	readonly tlsSecretRef?: string;
	readonly namespace?: string;
}

export function ingress(options?: IngressOptions): SlotBinding {
	return slotBinding({
		slot: "api",
		profile: capability.api.http,
		productId: "kubernetes.ingress/v1",
		properties: present(options ?? {}),
	});
}

export interface JobOptions {
	readonly image?: string;
	readonly backoffLimit?: number;
	readonly completions?: number;
	readonly parallelism?: number;
	readonly namespace?: string;
}

export function job(options?: JobOptions): SlotBinding {
	return slotBinding({
		slot: "service",
		profile: capability.service.batch,
		productId: "kubernetes.job/v1",
		properties: present(options ?? {}),
	});
}

export interface CronJobOptions {
	readonly schedule?: string;
	readonly image?: string;
	readonly concurrencyPolicy?: "Allow" | "Forbid" | "Replace";
	readonly namespace?: string;
}

export function cronJob(options?: CronJobOptions): SlotBinding {
	return slotBinding({
		slot: "service",
		profile: capability.service.scheduled,
		productId: "kubernetes.cronjob/v1",
		properties: present(options ?? {}),
	});
}

export interface PersistentVolumeClaimOptions {
	readonly storage?: string;
	readonly storageClassName?: string;
	readonly accessMode?: "ReadWriteOnce" | "ReadOnlyMany" | "ReadWriteMany";
	readonly namespace?: string;
}

export function persistentVolumeClaim(
	options?: PersistentVolumeClaimOptions,
): SlotBinding {
	return slotBinding({
		slot: "bucket",
		profile: capability.bucket.filesystem,
		productId: "kubernetes.persistent-volume-claim/v1",
		properties: present(options ?? {}),
	});
}

export interface SecretOptions {
	readonly type?: string;
	readonly namespace?: string;
	readonly key?: string;
}

export function secret(options?: SecretOptions): SlotBinding {
	return slotBinding({
		slot: "secretRef",
		profile: capability.secretRef.runtimeProjection,
		productId: "kubernetes.secret/v1",
		properties: present(options ?? {}),
	});
}
