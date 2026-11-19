import type { ResourceKind } from "./types.js";

export const APP_KIT_KINDS = Object.freeze([
	"api",
	"web",
	"service",
	"ui",
	"websocket",
	"job",
	"wasm-component",
] as const satisfies readonly ResourceKind[]);

export type AppKitKind = (typeof APP_KIT_KINDS)[number];

export const HTTP_APP_KIT_KINDS = Object.freeze([
	"api",
	"web",
	"service",
	"ui",
] as const satisfies readonly AppKitKind[]);

export type HttpAppKitKind = (typeof HTTP_APP_KIT_KINDS)[number];

export const INFRA_KIT_KINDS = Object.freeze([
	"kv",
	"cache",
	"bucket",
	"queue",
	"topic",
	"secret",
	"data",
	"schedule",
	"project",
	"external",
	"container",
	"flag",
	"auth",
	"crypto",
	"notify",
	"guardrail",
	"experiment",
	"rollout",
] as const satisfies readonly ResourceKind[]);

export function isAppKitKind(kind: string): kind is AppKitKind {
	return APP_KIT_KINDS.some((item) => item === kind);
}

export function isHttpAppKitKind(kind: string): kind is HttpAppKitKind {
	return HTTP_APP_KIT_KINDS.some((item) => item === kind);
}

export function appKitLabel(kind: AppKitKind): string {
	switch (kind) {
		case "api":
			return "API Kit";
		case "web":
			return "Web Kit";
		case "service":
			return "Service Kit";
		case "ui":
			return "UI Kit";
		case "websocket":
			return "Realtime Kit";
		case "job":
			return "Job Kit";
		case "wasm-component":
			return "Component Kit";
		default: {
			const _exhaustive: never = kind;
			return _exhaustive;
		}
	}
}
