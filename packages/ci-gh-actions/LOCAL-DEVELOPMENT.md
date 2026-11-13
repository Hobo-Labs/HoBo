# Run HoBo CI on a development machine

The local runner controller (`hobo-local-host`, `pnpm local:runner`) is gone.
A development machine now joins a HoBo Fleet as an enrolled `PERSONAL`
executor and runs `hobo fleet run`; it takes the work its owner authored and
runs each job in a single-use sandbox (design §6.11).

- Quick start and the standing description: `docs/design/fleet.md` (the HoBo
  Fleet design; its quick start covers enrolling a machine and `hobo fleet run`).
- The device agent's parts (sandbox drivers, egress proxy, key stores, service
  install): [`@hobo/fleet-agent`](../fleet-agent/README.md).
- The relay's own local contract and broker gate:
  [contracts/LOCAL-RUNNER-PACT.md](contracts/LOCAL-RUNNER-PACT.md).
