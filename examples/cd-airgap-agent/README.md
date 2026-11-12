# HoBo.CD in an air-gapped Yard

This example delivers to a plant floor that has no route to the internet
(plan 0024, D5, D19, I3, I24, and the §10 row "Air-gapped Yard, egress
disabled").

- **Local source.** Images are mirrored by digest into
  `registry.plant.internal`, and CD polls that registry. A mirror never
  changes a digest. If the mirror cannot serve one, convergence fails and
  nothing is substituted (D22).
- **Agent reconciler.** `hobo deploy agent run` runs inside the plant. It
  pulls desired state from the in-Yard Station feed over outbound HTTPS,
  using a key-bound JWT-SVID with a DPoP proof on every request. The Station
  never connects to the agent and holds no plant credential. Credentials are
  local files the agent resolves (`file:///etc/hobo/...`).
- **Double opt-in.** An enrolled key stays PENDING until two separate
  principals grant `reconciler.approve-key` and `reconciler.accept`. The Rail
  auto-accepts no scope.
- **Pipeline.** `bench` (a test cell, verified) → `line` (two production
  lines, after a 24 h soak and an approval).

## Install offline

The agent ships in the HoBo CLI distribution; there is no separate image or
binary (R7).

```sh
# On a connected machine: pack the CLI and its dependencies.
npm pack @hobo/cli && npm install --global --offline --cache ./npm-cache ./hobo-cli-*.tgz
# Copy hobo-cli-*.tgz and ./npm-cache across the air gap, then on the plant host:
npm install --global --offline --cache ./npm-cache ./hobo-cli-*.tgz

# On the Station (operator): issue a single-use bootstrap token for the Camp set.
hobo deploy agent token --camp-set plant-floor --mode agent --ttl 1h

# On the plant host: enroll the agent's key (state PENDING).
hobo deploy agent enroll --station https://station.plant.internal --token-stdin < token.txt

# On the Station: two different operators grant feed access.
hobo deploy agent approve-key <reconciler-id>     # operator A
hobo deploy agent accept <reconciler-id> --camps plant-7-bench,plant-7-line-a,plant-7-line-b   # operator B

# On the plant host: run the agent (outbound only).
hobo deploy agent run --station https://station.plant.internal
```

## Run the example

```sh
pnpm --filter @hobo/example-cd-airgap-agent test
hobo deploy pipeline apply --file examples/cd-airgap-agent/src/hobo.delivery.ts
```

## Runbook

- **The agent is refused with `enrollment-incomplete`.** Only one grant was
  recorded. A second, different principal must run the other grant (I24).
- **`CREDENTIAL_VALID=false` on the Camp.** The SVID was not refreshed and
  has less than 2 min left. Check the agent's clock (DPoP skew ±60 s) and
  its outbound reach to `station.plant.internal`. Rotation never fails
  silently.
- **The Camp is `REACHABLE=false` and `NO_PLACE`.** The Station has seen no
  lease activity for 90 s. No failover starts from this alone, and the
  agent's own reports can never add `NO_RUN`.
- **Convergence is blocked with a missing digest.** The mirror does not hold
  that digest. Mirror it by digest. Never retag.
