import type { runInventory } from "./implementations.ts";

export type InventoryWorld = { result?: ReturnType<typeof runInventory> };
