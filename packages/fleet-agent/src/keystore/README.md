# Key stores (L10)

The two shipped `KeyStore`s of design §6.4. Both pass `runKeyStoreConformance`.

| Entry point | What it does |
|---|---|
| `createFileKeyStore(home)` | An EC P-256 identity key, an Ed25519 `SIGN` key and an X25519 `SEAL` key, all generated with `node:crypto` and kept in the key directory. `heldKey` is `false` (tier `T0`) |
| `createExternalSignerKeyStore(home, command)` | The identity key stays behind `command`. The operational keys and the state stay in the key directory. `heldKey` is `true` (tier `T1`, self-declared) |

## The key directory (`HOBO_FLEET_HOME`)

- **Location.** A directory inside a git checkout is refused. The store looks for a `.git` directory or file at the key directory or at any directory above it.
- **Permissions.** The directory is created with mode `0700`. A directory that group or others can write is refused, and so is one owned by another user. An existing directory that nobody else can write is tightened to `0700`.
- **Files.** Every file is `0600`. A key file that group or others can read or write is refused. Each file is replaced atomically: the store writes a temporary file, flushes it, then renames it over the old one.
- **Windows.** POSIX modes do not apply. Only the git-checkout rule is checked, and the directory inherits the ACL of the user profile.

| File | Holds |
|---|---|
| `identity.pem` | The identity key as PKCS#8 PEM. Only the file store writes it |
| `operational.json` | The `SIGN` and `SEAL` private keys as PKCS#8 PEM. `rotateOperational` replaces the whole file in one atomic write |
| `state.json` | `AgentState`: the generation, the pending refresh nonce, the pinned trust record, the last sequence of each stream, the seen order ids and `pendingReceipts` (F4). Records are stored as base64 protobuf binary. A file that does not parse is refused with the name of the bad field |

`destroy` deletes all three files (for the external signer, it asks the command to delete the identity key). The next `open` creates new keys.

## The external-signer protocol

The store runs the command once per request with no shell, and closes standard error. It writes one JSON line to the command's standard input and reads one JSON line back from its standard output. The payload always goes through standard input. It never appears in the command's arguments or environment.

| Request | Answer |
|---|---|
| `{"op":"public"}` | `{"jwk":{…}}`: a public P-256 or Ed25519 JWK. A JWK with any other member, such as a private `d`, is refused |
| `{"op":"sign","payloadB64":"<base64>"}` | `{"signatureB64":"<base64>"}`: ES256 in IEEE P1363 form, or EdDSA. The store checks every signature against the public key before using it |
| `{"op":"destroy"}` | `{"ok":true}`: delete the identity key; the next `public` creates a new one |
| (any request, on failure) | `{"error":"<reason>"}` |

The design names only `public` and `sign`. This lane added `destroy` because `KeyStore.destroy` must remove the identity key, and only the helper holds it. A request times out after 120 seconds, which leaves time to touch a hardware token. An answer is limited to 64 KiB.
