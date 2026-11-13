#!/usr/bin/env bash
# Writes throwaway TLS material for trying the Compose profiles on one host:
# a private CA, a NATS server certificate naming every server of both
# profiles, and a relay certificate. Never use it for a real deployment: the
# CA key stays beside the certificates.
#
#   deploy/fleet/scripts/dev-tls.sh [output directory, default deploy/fleet/secrets]
#
# Writes <out>/nats/tls/{ca.pem,server.pem,server.key} and
# <out>/relay/tls/{relay.pem,relay.key}. Needs openssl.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
out="${1:-${here}/../secrets}"
days="${HOBO_FLEET_DEV_TLS_DAYS:-30}"

umask 077
mkdir -p "${out}/ca" "${out}/nats/tls" "${out}/relay/tls"
work="$(mktemp -d)"
trap 'rm -rf "${work}"' EXIT

if [[ ! -f "${out}/ca/ca.key" ]]; then
  openssl req -x509 -newkey ed25519 -nodes -days "${days}" \
    -subj "/CN=hobo-fleet-dev-ca" \
    -keyout "${out}/ca/ca.key" -out "${out}/ca/ca.pem" 2>/dev/null
fi

issue() {
  local name="$1" san="$2" key="$3" cert="$4"
  openssl req -newkey ed25519 -nodes -subj "/CN=${name}" \
    -keyout "${key}" -out "${work}/${name}.csr" 2>/dev/null
  printf 'subjectAltName=%s\nextendedKeyUsage=serverAuth,clientAuth\n' "${san}" > "${work}/${name}.ext"
  openssl x509 -req -in "${work}/${name}.csr" -days "${days}" \
    -CA "${out}/ca/ca.pem" -CAkey "${out}/ca/ca.key" -CAcreateserial \
    -extfile "${work}/${name}.ext" -out "${cert}" 2>/dev/null
}

nats_san="DNS:nats.fleet.example.com,DNS:nats-1.fleet.example.com,DNS:nats-2.fleet.example.com,DNS:nats-3.fleet.example.com"
nats_san="${nats_san},DNS:*.hobo-fleet-nats.hobo-fleet.svc.cluster.local,DNS:localhost"
nats_san="${nats_san},IP:127.0.0.1,IP:172.30.53.11,IP:172.30.53.12,IP:172.30.53.13"
issue nats "${nats_san}" "${out}/nats/tls/server.key" "${out}/nats/tls/server.pem"
cp "${out}/ca/ca.pem" "${out}/nats/tls/ca.pem"

issue relay "DNS:relay.fleet.example.com,DNS:relay-1.fleet.example.com,DNS:relay-2.fleet.example.com,DNS:localhost,IP:127.0.0.1" \
  "${out}/relay/tls/relay.key" "${out}/relay/tls/relay.pem"

# The containers run as uid 1000 (and the NATS server as a capability-less
# root); the keys must be readable inside them. The CA key stays private.
chmod 0755 "${out}" "${out}/nats" "${out}/nats/tls" "${out}/relay" "${out}/relay/tls"
chmod 0644 "${out}/nats/tls/"*.pem "${out}/relay/tls/relay.pem"
chmod 0644 "${out}/nats/tls/server.key" "${out}/relay/tls/relay.key"
echo "wrote ${out}/nats/tls and ${out}/relay/tls (CA: ${out}/ca/ca.pem)"
