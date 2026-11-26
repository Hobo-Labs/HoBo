package vercel

// Constraints on RelayWorkerHealth (../worker_health.proto), the repair
// evidence the stateless relay keeps in its cache. src/worker-health-cache.ts
// is the only writer.

#RelayWorkerHealth: {
	component:    "repair" | "repair-deliveries" | "repair-queued"
	successAtMs?: number & >=0
	failureAtMs?: number & >=0
}
