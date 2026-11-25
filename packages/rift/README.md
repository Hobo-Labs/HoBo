# @hobo/rift — virtual worktrees that work on this machine

`hobo-rift` gives every agent its own copy-on-write checkout so parallel agents
cannot collide in a shared tree. It keeps [upstream rift](https://github.com/anomalyco/rift)'s
CLI shape (`init`, `create`, `list`, `remove`, `exec`) and is a drop-in for it.

## Why a sidecar rather than upstream

Upstream rift needs a filesystem with copy-on-write — btrfs, XFS with reflinks,
or APFS — and ships per-platform binaries. On the common case here, **ext4 on
linux-arm64**, it fails twice over: there is no binary for the platform, and
`cp --reflink=always` returns `Operation not supported`. An agent multiplexer
relying on it therefore silently degrades every agent to one shared checkout.

## The ladder

`hobo-rift` picks the best primitive the machine actually offers:

| Tier | How | Isolates in-place writes |
|---|---|---|
| `reflink` | `cp --reflink=always` (FICLONE) | yes |
| `overlayfs` | `unshare -Urm` + unprivileged overlay mount | yes |

Overlay capability probing creates a short-lived `.rift-ovl-*` tree under the
probed directory; teardown runs `chmod -R u+rwx` before `rm` so a kernel `work/work`
at mode `000` cannot block deleting `HOBO_HOME` in tests or first-run sweeps.

| `hardlink` | `cp -al` | **no** |
| `copy` | `cp -a` | yes |

`hardlink` ranks below `overlayfs` deliberately: hardlinked files share inodes,
so an append or a `sed -i` in one workspace **reaches the source**. It is kept
only as a last resort before a full copy, and `capability` reports the hazard
rather than presenting all tiers as equivalent.

Regenerable bulk (`node_modules`, `.venv`, build output) is excluded when a
tier has to **copy** entries, unless you pass `--copy-all`. The overlay tier
copies nothing — the source is the lower layer — so the exclusion does not
apply to it and `node_modules` is simply visible at no cost.

Overlay probe cleanup restores owner access to kernel-created mode-000 work directories before removal, and cleanup failures never change the reported capability.

## Entering a workspace

Directory-backed tiers are ordinary paths — `cd` into them. The overlay tier is
mounted **inside a user namespace**, so its merged path does not exist to
anyone outside that namespace and `cd` would find an empty directory. Run
commands through the wrapper instead:

```sh
hobo-rift exec --name claude -- claude          # run it
hobo-rift exec --name claude --print-cmd -- claude   # print the wrapped command
```

An agent multiplexer wraps each tmux pane command in `hobo-rift exec` for the
same reason, so panes land in a real isolated tree rather than an empty
directory. `--print-cmd` prints that wrapper instead of running it, for
debugging.

Inside an overlay workspace, `.hobo-rift` is masked with an empty tmpfs: the
whole source is the lower layer, so without that an agent could read every
other agent's upper layer. The mask covers the path *inside* the workspace —
an absolute path back to the real source still resolves, so this protects
against collisions, not against a hostile process.

## Usage

```sh
hobo-rift capability            # which primitive is available here, and why
hobo-rift init                  # register the current directory as a source root
hobo-rift create --name claude  # prints the workspace path on stdout
hobo-rift list --json
hobo-rift remove --name claude
```
