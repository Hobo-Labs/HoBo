# Host capacity (L10)

`createHostCapacity({ slots, workRoot, labels })` returns a `CapacitySource`. Each `read()` measures the host the way the box worker's `free()` does today (design §6.8):

| Figure | Source |
|---|---|
| `free_slots`, `total_slots` | `slots`, a whole number from 0 to 1024. The executor accounts for the slots it has in use |
| `free_memory_mb` | `MemAvailable` from `/proc/meminfo`, or `os.freemem()` outside Linux, minus the worker's default 2 GiB host reserve. The value never goes below 0 |
| `free_disk_mb` | `statfs(workRoot)`: `bavail × bsize`, the space an unprivileged process can still use |
| `hostSignals.freeInodes` | `statfs(workRoot)`: `ffree`, the free inodes on the work volume (L43) |
| `hostSignals.psiMemorySome`, `psiMemoryFull` | avg10 of the "some" and "full" lines of `/proc/pressure/memory` (L43). Absent off Linux, on a kernel without PSI, or for a missing line |
| `health` | `REACHABLE`, or `PRESSURED` when no memory is left above the reserve. Draining is the agent's state, not the host's |

If a figure cannot be read, the record leaves it out, which means unknown. It is never reported as zero. Figures are capped at the largest `uint32`.

`hostSignals` sits beside the frozen `CapacitySource` fields (`capacity`, `health`, `labels`), which have no place for inodes or PSI. The agent in `@hobo/fleet` reads it and derives the observation's `refusal` (`packages/fleet/src/observation/refusal.ts`), so the thresholds live in one place: fewer than 25,000 free inodes is `STORAGE`; PSI avg10 at or over 25 ("some") or 5 ("full") is `PRESSURE`. These are main's box worker's figures (`isolated-worker/host-capacity.ts`: `minInodeMargin`, `psiSomeBlock`, `psiFullBlock`), which L34 deletes.

Every read goes through `createHostProbes(readers)`: `readFile`, `statfs`, `freemem` and the platform. `NODE_READERS` are the real ones; tests pass fakes, so no real `/proc` is needed.
