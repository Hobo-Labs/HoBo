# HoBo Fleet deployment assets

Everything needed to run a HoBo fleet's server side in either profile of
[the fleet design](../../docs/design/index.md) (§6.7 NATS topology, §6.16
deployment): NATS server templates, Compose files, Kubernetes manifests, the
peer-to-peer relay, the provisioning job, and the systemd, launchd and Windows
definitions that run `hobo fleet run` on a device. `test/assets.test.ts` (O33)
holds every file here to the properties below.

| Path | What |
|---|---|
| `nats/standalone.conf`, `nats/ha.conf` | NATS server templates: operator mode, full resolver, JetStream, TLS on every listener, monitoring on `127.0.0.1:8222`, `max_control_line` 8 KiB (the provisioner JWT is about 3.6 KiB). No leaf-node, MQTT or gateway listener. `ha.conf` adds mutual-TLS cluster routes bound to a private address |
| `nats/operator.conf.example` | The shape of `operator.conf`, which both templates include |
| `relay/iroh-relay.toml` | The peer-to-peer relay (iroh-relay 1.4.1), TLS with a mounted certificate, metrics on loopback |
| `config/*.json` | `FleetAuthorityConfig` (protobuf JSON) for the authority, the witness and the provisioner, per profile. Each names its own OpenBao role; the binaries support only OpenBao |
| `compose.standalone.yml` | One NATS server, one authority (SQLite journal), the witness under another user, one relay, the provisioning job |
| `compose.ha.yml` | Three NATS servers, two authority replicas (`FLEET_JOURNAL`), the witness, two relays, the provisioning job |
| `kubernetes/` | The high-availability profile on Kubernetes (`kubectl kustomize --load-restrictor LoadRestrictionsNone deploy/fleet/kubernetes`) |
| `service/` | `hobo fleet run` as a systemd user unit, a launchd agent and a Windows task (the same shape `hobo fleet service install` writes) |
| `scripts/dev-tls.sh` | Throwaway CA and certificates for trying the Compose files on one host |

The release images are defined beside the others:
`deploy/release-images/hobo-fleet-authority`, `hobo-fleet-witness` and
`hobo-fleet-relay`.

## Hardening every file keeps

- **NATS:** TLS on the client (4222), WebSocket (container 8443, published as
  443 where the host has it free) and cluster (6222) listeners; cluster routes
  verify the peer's certificate and bind only the private address the
  deployment names (`HOBO_FLEET_NATS_CLUSTER_HOST`); monitoring on loopback;
  operator mode with the full resolver and `allow_delete: false`.
- **Compose:** every service has a read-only root, drops every capability,
  sets `no-new-privileges`, and publishes no monitoring, cluster, leaf-node or
  MQTT port. HoBo images run as uid 1000 (the witness as 1001, another
  account). The NATS image runs as its own root user holding no capability, so
  it can write its named volume and nothing else. The authority is published
  on loopback only: TLS for its issuer origin ends in a proxy in front of it.
- **Kubernetes:** the namespace enforces the `restricted` Pod Security
  Standard; every workload is non-root with a read-only root, all capabilities
  dropped, no privilege escalation and the runtime seccomp profile; the
  authority has two replicas and a disruption budget (`minAvailable: 1`), NATS
  and the relay have budgets too; a NetworkPolicy admits cluster routes only
  from the NATS pods. Each workload reads OpenBao with its own projected
  service-account token (audience `openbao`).

## Before the first start

1. Run the key ceremony (`hobo fleet ops ceremony`) against your OpenBao. It
   stores the operator JWT at `<secretPrefix>/operator-jwt`. Write
   `operator.conf` from it in the shape of `nats/operator.conf.example`.
2. Place, under `deploy/fleet/secrets/` (git-ignored) for Compose, or as the
   named Kubernetes secrets:

   | Compose path | Kubernetes secret | Holds |
   |---|---|---|
   | `secrets/nats/operator.conf` | `hobo-fleet-nats-operator` (`operator.conf`) | Operator JWT, system account and its preload |
   | `secrets/nats/tls/{server.pem,server.key,ca.pem}` | `hobo-fleet-nats-tls` | The NATS certificate, naming every server URL in `natsUrls` |
   | `secrets/relay/tls/{relay.pem,relay.key}` | `hobo-fleet-relay-tls` | The relay certificate |
   | `secrets/{authority,witness,provisioner}.openbao-token` | projected service-account tokens | Each workload's OpenBao identity token |
   | — | `hobo-fleet-authority-tls` | The issuer origin's certificate, for the ingress |

   For a local trial, `scripts/dev-tls.sh` writes the TLS files.
3. Edit `config/*.json`: the issuer origin, tenant, NATS and relay URLs and
   the OpenBao address. The authority connects to the same `natsUrls` it
   publishes in discovery, so the Compose files give each NATS server a
   network alias equal to its public name.
4. Start NATS, then provision once:
   `docker compose -f deploy/fleet/compose.ha.yml run --rm provision`
   (Kubernetes: apply the kustomization; the `hobo-fleet-provision` job runs
   once). Provisioning is an operator task; no service holds the
   provisioner's credentials.
5. Start the rest. Images default to the locally built `:candidate` tags; set
   `HOBO_FLEET_VERSION` (and `HOBO_FLEET_IMAGE_PREFIX`) to run a release.

## Known limits

- `hobo-fleet-witness` refuses to start until `@hobo/fleet-nats` exposes the
  `fleet.audit.witness` publish path; the files compose it anyway.
- In `compose.standalone.yml` port 443 belongs to the relay, so the NATS
  WebSocket listener is published on 9443 (`HOBO_FLEET_NATS_WSS_PORT`). In
  `compose.ha.yml` the second and third servers and the second relay use the
  next free host ports, because the file puts everything on one host; split
  the services across hosts in production.
- Gateways between regions are off; a multi-region deployment adds them in its
  own configuration.
