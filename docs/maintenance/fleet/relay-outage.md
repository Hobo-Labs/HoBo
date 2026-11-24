---
type: Runbook
title: "Fleet runbook: relay outage"
description: "The HoBo Fleet peer-to-peer relays are down: transport falls back to the overlay and then to the bus relay; restore them."
tags: [hobo, fleet, runbook, maintenance, networking]
---

# Relay outage

The peer-to-peer transport dials devices by the endpoint id in their key
bundles, punches holes where it can, and relays through HoBo's own relays
(`deploy/fleet/relay/iroh-relay.toml`) where it cannot. Public relays are
never used.

**Signals:** `hobo_fleet_transport_selected` choosing `overlay` or
`bus-relay` where it used to choose `p2p`; `hobo fleet doctor` failing its
transport self-dial; relay metrics on its loopback port.

## What still works

Every session still opens: transport falls to the overlay (where the tenant
runs one) and then to the bus relay, which is always available and
end-to-end encrypted. Sessions are slower; coordination is unaffected,
because coordination never needs a direct connection.

## Steps

1. Check each relay process and its TLS certificate (`relay.pem`); an
   expired certificate is the usual cause.
2. Check the relay's public port is reachable from outside; the high
   availability profile runs two or more relays in different regions, so one
   loss should only shift traffic.
3. Restart or redeploy the relay from the release image
   ([release service images](./release-service-images.md)).
4. Verify: `hobo fleet doctor` on a device passes its self-dial and new
   sessions select `p2p` again.
