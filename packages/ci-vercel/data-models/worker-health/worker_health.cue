package vercel


#RelayWorkerHealth: {
	component:    "repair" | "repair-deliveries" | "repair-queued"
	successAtMs?: number & >=0
	failureAtMs?: number & >=0
}
