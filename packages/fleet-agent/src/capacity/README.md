# Host capacity (L10)

`createHostCapacity({ slots, workRoot, labels })` returns a `CapacitySource`. Each `read()` measures the host the way the box worker's `free()` does today (design §6.8):

| Figure | Source |
|---|---|
| `free_slots`, `total_slots` | `slots`, a whole number from 0 to 1024. The executor accounts for the slots it has in use |
| `free_memory_mb` | `MemAvailable` from `/proc/meminfo`, or `os.freemem()` outside Linux, minus the worker's default 2 GiB host reserve. The value never goes below 0 |
| `free_disk_mb` | `statfs(workRoot)`: `bavail × bsize`, the space an unprivileged process can still use |
| `health` | `REACHABLE`, or `PRESSURED` when no memory is left above the reserve. Draining is the agent's state, not the host's |

If a figure cannot be read, the record leaves it out, which means unknown. It is never reported as zero. Figures are capped at the largest `uint32`.
