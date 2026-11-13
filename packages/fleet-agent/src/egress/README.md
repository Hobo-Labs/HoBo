# Egress proxy (L38)

`createEgressProxyFactory({ fleetAllow, log })` answers an
`EgressProxyFactory`; each `open(allow)` starts one HTTP proxy on
`127.0.0.1:<random port>` for one order and answers its `url` and `close`.
Design: ADR-0182, §6.11 "Egress" of the fleet design.

- **What it serves.** `CONNECT host:port` tunnels and absolute-form requests
  (`GET http://host/…` and `GET https://host/…`, which busybox wget sends for
  HTTPS through a proxy; the proxy makes the TLS connection upstream). It
  keeps answering a client that half-closes after its request.
- **Allowlist.** Exactly the order's hosts plus `fleetAllow()`, which is read
  on every request, so a host the fleet drops stops at once. Names are
  compared lower-cased without a trailing dot; no wildcard or suffix match.
- **Always refused**, by name and after resolution (every resolved address
  is checked, and the proxy connects to the address it vetted, never to a
  second lookup): metadata addresses (`169.254.169.254`, `100.100.100.200`,
  `fd00:ec2::254`, `metadata.google.internal` and similar names), link-local
  (`169.254.0.0/16`, `fe80::/10`), loopback, unspecified and multicast
  addresses, including IPv4-mapped IPv6 forms. Loopback is refused too so
  that a sandbox cannot reach the agent's own host services, its control
  endpoints included, through its proxy.
- **Refusal** is `403` and one log line `hobo_fleet_sandbox_unavailable` with
  `component: "egress"`, the host and the reason; paths, headers and bodies
  are never logged.

Tests: `test/egress/proxy.test.ts`.
