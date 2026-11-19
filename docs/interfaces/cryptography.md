# Cryptography

The `effect/crypto` modules split cryptography into one service per job: `SecureRandom`, `Digest`, `Mac`, `Aead`, `Cipher`, `Kdf`, `Signature`, `KeyAgreement`, and `KeyWrap`. `KeyFormat` reads and writes keys, `CryptoError` is the only error they fail with, and `WebCrypto` is the reference that the WebCrypto-backed layers run on. Each service is an ordinary `Context.Service`, so a program asks for only the services it uses and a test replaces just those. The [`effect/jose`](#jose-tokens-and-keys) modules build JSON Web Keys, signatures, encryption, and tokens on top of these services.

Choose by the job, not by the algorithm:

| You need | Use | Not |
| --- | --- | --- |
| Random bytes, UUIDs, ULIDs, dice rolls, shuffles that must not be guessable | [`SecureRandom`](#securerandom) | `effect/Random`, which is seedable and not secure |
| A checksum, content hash, or pseudonymous lookup key | [`Digest`](#digest) | a MAC, unless a secret is involved |
| Proof that a message came from someone holding a shared secret (webhooks, signed cookies) | [`Mac`](#mac) | comparing digests with `===` |
| Encrypt data so tampering is detected | [`Aead`](#aead) | [`Cipher`](#cipher) |
| A protocol that pairs AES-CTR or AES-CBC with its own MAC | [`Cipher`](#cipher) | — |
| Turn a password or shared secret into key bytes | [`Kdf`](#kdf) | using the secret as a key directly |
| Public-key signatures (release signing, custom protocols) | [`Signature`](#signature) | hand-built JWS; use [`Jws`](#jws) |
| Issue or verify JWTs (access tokens, ID tokens, session tokens) | [`Jwt`](#jwt) | `decodeUnverified` for any authorization decision |
| Verify tokens against an identity provider's JWKS endpoint | [`Jwks.layerRemote`](#jwks) with `Jwt.verifyWithKeySet` | fetching the key set by hand per request |
| Two parties agreeing on a secret (ECDH, X25519) | [`KeyAgreement`](#keyagreement), then `Kdf` | — |
| Encrypting a key with another key | [`KeyWrap`](#keywrap) | `Aead` over exported key bytes |
| PEM, SPKI, PKCS#8, or JWK in and out | [`KeyFormat`](#keyformat) | hand-written DER parsing |

Every module is unstable. Keys are opaque values: they print only their algorithm, compare by reference, and carry their algorithm in their type, so passing an Ed25519 key where an ECDSA key is expected is a type error.

**Providing the services.** The runtime aggregates (`NodeServices.layer`, `BunServices.layer`, `DenoServices.layer`) do **not** include any crypto service; provide crypto separately. Each host package has a crypto module with one layer per family and a combined `layer`, and none of them has requirements:

| Host | Module | Notes |
| --- | --- | --- |
| Node.js | `NodeCrypto` from `@effect/platform-node` | `layerDigest` and `layerMac` run synchronously on `node:crypto`; `layerAead` runs ChaCha20-Poly1305 on `node:crypto`; `layerKdf` adds Argon2id (Node.js 24.7+ with OpenSSL 3.2) |
| Bun | `BunCrypto` from `@effect/platform-bun` | Re-exports `NodeCrypto`; ChaCha20-Poly1305 falls back to the pure TypeScript implementation, and Argon2id needs Bun 1.4 |
| Deno | `DenoCrypto` from `@effect/platform-deno` | The core WebCrypto layers with `SecureRandom` already provided |
| Browser | `BrowserCrypto` from `@effect/platform-browser` | Same as Deno; `crypto.subtle` exists only in secure contexts |

Portable code can use each module's own `layerWebCrypto` instead. Those layers run on the [`WebCrypto`](#webcrypto) reference, and every family except `Digest` and `Kdf` needs `SecureRandom` for key generation, so provide `SecureRandom.layerWebCrypto` underneath.

```ts
import { Effect, Layer } from "effect"
import { Digest, Mac, SecureRandom } from "effect/crypto"
import { NodeCrypto, NodeRuntime, NodeServices } from "@effect/platform-node"

declare const app: Effect.Effect<void, never, Digest.Digest | Mac.Mac | SecureRandom.SecureRandom>

// Node entrypoint: platform services and crypto are separate layers.
app.pipe(
  Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
  NodeRuntime.runMain
)

// Portable alternative: only the families this program uses, on WebCrypto.
export const PortableCrypto = Layer.mergeAll(
  Digest.layerWebCrypto,
  Mac.layerWebCrypto
).pipe(Layer.provideMerge(SecureRandom.layerWebCrypto))
```

**Testing.** There is no `TestCrypto` module. Replace the services a test touches with `Layer.mock`, which accepts a partial implementation and makes any unimplemented method die with an `UnimplementedError`. For reproducible random output, build a service with `SecureRandom.make` from a deterministic byte source; Ed25519 and X25519 key generation, and every family's symmetric `generateKey`, draw from that `SecureRandom`, but ECDSA, ECDH, and RSA keys use WebCrypto's own randomness and cannot be seeded, so test those with round trips such as `verify(sign(data))`.

```ts
import { Effect, Layer } from "effect"
import { SecureRandom } from "effect/crypto"

// Only the method the code under test calls.
export const FixedIds = Layer.mock(SecureRandom.SecureRandom, {
  uuidV4: () => Effect.succeed("00000000-0000-4000-8000-000000000000")
})

// A deterministic byte source: every operation derives from it.
let counter = 0
export const SeededRandom = Layer.succeed(SecureRandom.SecureRandom)(
  SecureRandom.make((size) => Uint8Array.from({ length: size }, () => (counter++ * 31) & 255))
)
```

**Migration:** `effect/Crypto` and `effect/testing/TestCrypto` were removed. Map old calls as follows:

| Old `Crypto.Crypto` call | Replacement |
| --- | --- |
| `randomBytes(n)` | `SecureRandom.randomBytes(n)` — no error channel; a bad size is a defect |
| `randomUUIDv4()` / `randomUUIDv7()` | `uuidV4()` / `uuidV7()`; the default format is now `"string"` (was `"hex"`), and `{ format: "bytes" }` is unchanged |
| `randomULID` | `ulid` (monotonic within a millisecond) |
| `randomIntBetween(min, max, { halfOpen })` | `intBetween(min, max, { halfOpen })` |
| `randomShuffle(xs)` | `shuffle(xs)` |
| `random`, `randomBetween`, `randomBoolean`, `randomInt`, `nextDoubleUnsafe` | No secure equivalents: use `effect/Random` for non-secret numbers, or derive a bit from `randomBytes(1)` |
| `digest("SHA-256", data)` | `Digest.digest(Digest.sha256, data)`, or `digestHex` for lowercase hex instead of converting by hand |
| `Crypto.make(...)` / `TestCrypto.layer(seed)` | `SecureRandom.make(randomBytes)` or `Layer.mock(...)` for the services a test needs |
| `NodeServices.layer` providing `Crypto` | Add `NodeCrypto.layer` (or a single family layer such as `NodeCrypto.layerDigest`) |

Code that passed `Crypto.Crypto` to cluster `SqlMessageStorage` or `SingleRunner` now provides `Digest.Digest`, and `EventLogEncryption` takes `Aead`, `Digest`, `Signature`, and `SecureRandom` from context. Stored workflow IDs, idempotency keys, and encrypted event-log data are unchanged.

## SecureRandom

`effect/crypto/SecureRandom` — unstable

The `SecureRandom` service generates `randomBytes(size)`, uniform integers with `intBetween(min, max, { halfOpen? })` (exactly uniform, by rejection sampling), Fisher–Yates `shuffle`, `uuidV4()`, `uuidV7()`, and the `ulid` Effect. Every operation has a `never` error channel; a negative size or an empty range dies with a `RangeError`. `uuidV4` and `uuidV7` are functions returning Effects: by default they return the lowercase hyphenated string, and `{ format: "bytes" }` returns the 16 bytes.

UUIDv7 and ULID read the timestamp from `Clock`, so `TestClock` controls their time prefix. Values from one service instance are strictly increasing, even within one millisecond or when the clock moves back; there is no ordering across separate services, processes, or workers. Because consecutive values reveal their order, never use them as secrets.

`SecureRandom.make(randomBytes)` builds the service from any byte source, and `layerWebCrypto` uses `getRandomValues` (which also works in insecure browser contexts). `randomBytesUnsafe`, `uuidV4Unsafe`, `uuidV7Unsafe`, and `ulidUnsafe` draw synchronously from `globalThis.crypto` for constructors and model defaults that cannot read a service; a mocked `SecureRandom` does not affect them.

There are no float, boolean, or full-range integer helpers. Insecure random numbers belong to `effect/Random`.

```ts
import { Effect } from "effect"
import { SecureRandom } from "effect/crypto"

export const newGrant = Effect.gen(function*() {
  const random = yield* SecureRandom.SecureRandom
  const grantId = yield* random.uuidV7() // time-ordered primary key
  const exportName = yield* random.ulid // 26 sortable characters for file names
  const token = yield* random.randomBytes(32) // secret material
  const reviewer = yield* random.intBetween(0, 4) // inclusive on both ends
  return { grantId, exportName, token, reviewer }
})
```

## Digest

`effect/crypto/Digest` — unstable

The `Digest` service computes `digest(algorithm, data)` as bytes and `digestHex(algorithm, data)` as lowercase hex. Algorithms are values: `Digest.md5`, `Digest.sha1`, `Digest.sha256`, `Digest.sha384`, and `Digest.sha512`. Output is stable byte for byte, so digests can be persisted. `layerWebCrypto` runs SHA on `crypto.subtle` and MD5 on a vendored pure TypeScript implementation; `NodeCrypto.layerDigest` runs both synchronously on `node:crypto`, which is faster for small inputs.

MD5 and SHA-1 are broken for collision resistance; use them only for compatibility with existing checksums and protocols. A digest of a low-entropy value such as a national ID can be reversed by guessing; use a [`Mac`](#mac) with a server-side key when the input is guessable.

```ts
import { Effect } from "effect"
import { Digest } from "effect/crypto"

export const contentHash = (bytes: Uint8Array) =>
  Effect.gen(function*() {
    const digest = yield* Digest.Digest
    return yield* digest.digestHex(Digest.sha256, bytes)
  })
```

## Mac

`effect/crypto/Mac` — unstable

HMAC with `Mac.hmacSha1`, `hmacSha256`, `hmacSha384`, or `hmacSha512`. The service has `generateKey(algorithm)`, `sign(key, data)`, and `verify(key, tag, data)`, which returns a `boolean` and compares in constant time. Build keys with `Mac.key(algorithm, bytes)` (any non-empty length; an empty key fails with `InvalidKey`) or `Mac.fromCryptoKey` for a non-extractable WebCrypto key, and export with `Mac.toBytes`. `Mac.timingSafeEqual(a, b)` compares fixed-length secrets you computed elsewhere; arrays of different lengths return `false` immediately.

```ts
import { Effect } from "effect"
import { Mac } from "effect/crypto"

declare const webhookSecret: Uint8Array

// Verify a payroll provider's webhook signature.
export const verifyWebhook = (body: Uint8Array, signature: Uint8Array) =>
  Effect.gen(function*() {
    const mac = yield* Mac.Mac
    const key = yield* Mac.key(Mac.hmacSha256, webhookSecret)
    return yield* mac.verify(key, signature, body)
  })
```

`Schema.MacKeyFromBytes(algorithm)` decodes key bytes (base64 under `Config.schema`) into a `Mac.Key`, so a secret can be read straight from configuration. Key schemas exist for every family (`Schema.AeadKeyFromBytes`, `Schema.SignaturePublicKeyFromFormat`, `Schema.KeyWrapKeyFromFormat`, …). Encoding a secret or private key back to bytes fails with a `Forbidden` issue unless the schema was built with `{ allowEncode: true }`, and the plain key schemas refuse JSON serialization.

## Aead

`effect/crypto/Aead` — unstable

Authenticated encryption with `Aead.aes128Gcm`, `aes256Gcm`, `chacha20Poly1305`, or `xchacha20Poly1305`. The service has `generateKey(algorithm)`, `encrypt(key, plaintext, { nonce, aad? })`, and `decrypt(key, ciphertext, { nonce, aad? })`. Ciphertext is `ciphertext‖tag` with a 16-byte tag. Any tampering with the ciphertext, tag, or additional data fails `decrypt` with a detail-free `DecryptionFailed` reason. `Aead.key` validates the key length (a wrong length fails with `InvalidKey`; AES-192 is not supported), and `Aead.fromCryptoKey` accepts AES-GCM `CryptoKey`s only.

Never reuse a nonce with the same key. Random 12-byte nonces are safe up to roughly 2³² messages per key; past that, use a counter, or XChaCha20-Poly1305 whose 24-byte nonce can be random. ChaCha20 variants run a vendored pure TypeScript implementation unless the layer supplies a native one (`NodeCrypto.layerAead` does on Node.js; `Aead.layerWebCryptoWith({ implementations })` lets you supply your own).

```ts
import { Effect } from "effect"
import { Aead, SecureRandom } from "effect/crypto"

export const sealSalaryFile = (key: Aead.Key, plaintext: Uint8Array, employeeId: string) =>
  Effect.gen(function*() {
    const aead = yield* Aead.Aead
    const random = yield* SecureRandom.SecureRandom
    const nonce = yield* random.randomBytes(24) // XChaCha20 nonces may be random
    const aad = new TextEncoder().encode(employeeId) // bound to the record, not secret
    const ciphertext = yield* aead.encrypt(key, plaintext, { nonce, aad })
    return { nonce, ciphertext }
  })

export const openSalaryFile = (key: Aead.Key, nonce: Uint8Array, ciphertext: Uint8Array, employeeId: string) =>
  Effect.gen(function*() {
    const aead = yield* Aead.Aead
    return yield* aead.decrypt(key, ciphertext, { nonce, aad: new TextEncoder().encode(employeeId) })
  }).pipe(
    // Collapse every decryption failure to one response; detail leaks oracles.
    Effect.catchReason("CryptoError", "DecryptionFailed", () => Effect.succeed(undefined))
  )
```

## Cipher

`effect/crypto/Cipher` — unstable

Unauthenticated AES-CTR (`Cipher.aes128Ctr`, `aes256Ctr`) and AES-CBC with PKCS#7 padding (`aes128Cbc`, `aes256Cbc`), with the same `generateKey` / `encrypt` / `decrypt` shape as `Aead` but an `{ iv }` option. Use it only for protocols that pair these modes with their own MAC (SSH, SRTP, JWE, CMS); otherwise use [`Aead`](#aead). An attacker can change the ciphertext undetected, AES-CTR decryption never fails, and AES-CBC reports bad padding and bad length as the same `DecryptionFailed`. Verify a MAC before decrypting (encrypt-then-MAC), and never reuse an IV with one key.

## Kdf

`effect/crypto/Kdf` — unstable

The `Kdf` service has one method, `derive(algorithm, secret, { salt, length, info? })`, which returns plain bytes. Turn them into a typed key with the target family's constructor, such as `Aead.key` or `Mac.key`. Algorithms are `Kdf.hkdfSha1` … `hkdfSha512` (or `Kdf.hkdf(Digest.sha256)`), `Kdf.pbkdf2Sha256` (600,000 iterations) or `Kdf.pbkdf2({ hash, iterations })`, and `Kdf.argon2id({ memory?, passes?, parallelism? })`, which defaults to 64 MiB, 3 passes, and 4 lanes.

The secret is bytes, so encode passwords yourself, normalizing Unicode first when users type on different platforms. `Kdf.layerWebCrypto` cannot run Argon2id and fails with an `Unsupported` reason, so a portable program can fall back to PBKDF2; `NodeCrypto.layerKdf` supports it on Node.js 24.7+ and Bun 1.4.

```ts
import { Effect } from "effect"
import { Kdf } from "effect/crypto"

export const passwordKey = (password: string, salt: Uint8Array) =>
  Effect.gen(function*() {
    const kdf = yield* Kdf.Kdf
    const secret = new TextEncoder().encode(password.normalize("NFKC"))
    return yield* kdf.derive(Kdf.argon2id(), secret, { salt, length: 32 }).pipe(
      Effect.catchReason("CryptoError", "Unsupported", () =>
        kdf.derive(Kdf.pbkdf2Sha256, secret, { salt, length: 32 }))
    )
  })
```

## Signature

`effect/crypto/Signature` — unstable

Digital signatures with `Signature.ed25519`, `ecdsaP256` / `ecdsaP384` / `ecdsaP521` (hashed with SHA-256/384/512, as JOSE ES256/384/512), and RSA-PSS or RSASSA-PKCS1-v1_5 (`rsaPssSha256`, `rsaPkcs1v15Sha256`, … at 3072 bits, or `Signature.rsaPss({ hash, modulusLength })`). The service has `generateKeyPair(algorithm)`, `sign(privateKey, data)`, `verify(publicKey, signature, data)` (a `boolean`), and `publicKeyOf(privateKey)`.

Only Ed25519 private keys (the 32-byte seed) and Ed25519 or uncompressed-point ECDSA public keys have raw constructors (`Signature.privateKey`, `Signature.publicKey`); other keys come from `generateKeyPair`, `privateKeyFromCryptoKey` / `publicKeyFromCryptoKey`, or [`KeyFormat`](#keyformat). Ed25519 needs Chrome 137, Firefox 129, or Safari 17 in browsers.

```ts
import { Effect } from "effect"
import { KeyFormat, Signature } from "effect/crypto"

declare const publicKeyPem: string

export const verifyRelease = (artifact: Uint8Array, signature: Uint8Array) =>
  Effect.gen(function*() {
    const signatures = yield* Signature.Signature
    const publicKey = yield* KeyFormat.decodePublic(KeyFormat.pem(KeyFormat.spki), Signature.ed25519, publicKeyPem)
    return yield* signatures.verify(publicKey, signature, artifact)
  })
```

## KeyAgreement

`effect/crypto/KeyAgreement` — unstable

X25519 (`KeyAgreement.x25519`) and ECDH on P-256, P-384, and P-521 (`ecdhP256`, …). The service has `generateKeyPair`, `deriveSharedSecret(privateKey, publicKey)`, and `publicKeyOf`. Both keys must use the same algorithm, which the types enforce. The shared secret is raw bytes: pass it through [`Kdf`](#kdf) (HKDF) before using it as a key. X25519 needs Chrome 133, Firefox 130, or Safari 17 in browsers.

```ts
import { Effect } from "effect"
import { Aead, Kdf, KeyAgreement } from "effect/crypto"

export const sessionKey = (
  mine: KeyAgreement.PrivateKey<KeyAgreement.X25519>,
  theirs: KeyAgreement.PublicKey<KeyAgreement.X25519>,
  salt: Uint8Array
) =>
  Effect.gen(function*() {
    const agreement = yield* KeyAgreement.KeyAgreement
    const kdf = yield* Kdf.Kdf
    const shared = yield* agreement.deriveSharedSecret(mine, theirs)
    const bytes = yield* kdf.derive(Kdf.hkdfSha256, shared, {
      salt,
      info: new TextEncoder().encode("payroll-sync v1"),
      length: 32
    })
    return yield* Aead.key(Aead.xchacha20Poly1305, bytes)
  })
```

## KeyWrap

`effect/crypto/KeyWrap` — unstable

AES-KW (`KeyWrap.aes128Kw`, `aes256Kw`) and RSA-OAEP (`rsaOaepSha256`, `rsaOaepSha1`, or `KeyWrap.rsaOaep({ hash, modulusLength })`). The service has `generateKey` (AES-KW), `generateKeyPair` (RSA-OAEP), `wrap(wrapKey, key)`, and `unwrap(unwrapKey, algorithm, wrapped)`, which returns a typed key of the given algorithm. `wrap` takes an `Aead`, `Cipher`, `Mac`, or `KeyWrap` key, never raw bytes. AES-KW wraps keys whose length is a multiple of 8 and at least 16 bytes; other lengths fail with `InvalidArgument`. A key-encryption key is the key most worth keeping non-extractable, so in browsers build it with `KeyWrap.fromCryptoKey`.

## KeyFormat

`effect/crypto/KeyFormat` — unstable

Plain functions, not a service, that run on the [`WebCrypto`](#webcrypto) reference and require nothing: `decodePublic(format, algorithm, data)`, `decodePrivate(...)`, `decodeSecret(...)`, and `encode(format, key)`. Formats are `KeyFormat.spki` (public DER), `pkcs8` (private DER), `jwk` (every role), import-only `pkcs1` (RSA) and `sec1` (EC), and `KeyFormat.pem(format)` for PEM text with 64-column lines. The algorithm decides the family of the result: decoding with `Signature.ecdsaP256` gives a `Signature` key, with `KeyAgreement.ecdhP256` a `KeyAgreement` key. Secret keys are read and written only as JWK.

Malformed data or a key of another algorithm fails with `InvalidKey`; encoding a non-extractable `CryptoKey` fails with `NotExtractable`. EC private keys must include their public point, written JWKs contain only `kty`, `crv`, and the key material, and callers parse and stringify JSON themselves. JWK data is typed as `KeyFormat.JsonWebKey`, the module's own declaration of the RFC 7517 members, so code that reads or writes JWKs type-checks without the DOM library. For JWKs that carry `kid`, `alg`, and `use`, use [`Jwk`](#jwk).

```ts
import { Effect } from "effect"
import { KeyFormat, Signature } from "effect/crypto"

// Publish a freshly generated signing key as a JWK for a JWKS endpoint.
export const newSigningKey = Effect.gen(function*() {
  const signatures = yield* Signature.Signature
  const { privateKey, publicKey } = yield* signatures.generateKeyPair(Signature.ecdsaP256)
  const jwk = yield* KeyFormat.encode(KeyFormat.jwk, publicKey) // { kty: "EC", crv: "P-256", x, y }
  const pkcs8Pem = yield* KeyFormat.encode(KeyFormat.pem(KeyFormat.pkcs8), privateKey)
  return { jwk, pkcs8Pem }
})
```

## CryptoError

`effect/crypto/CryptoError` — unstable

Every `effect/crypto` failure is one `CryptoError` whose `module` and `method` name the operation (`"Aead"`, `"decrypt"`) and whose `reason` is `InvalidArgument`, `InvalidKey`, `DecryptionFailed`, `Unsupported`, or `NotExtractable`. The message reads `"Aead.decrypt: <reason message>"`. Match reasons with `Effect.catchReason("CryptoError", "DecryptionFailed", ...)`, and narrow unknown values with `CryptoError.isCryptoError` / `isCryptoErrorReason`. `SecureRandom` and `Digest` never fail this way.

The error is not a schema, so it cannot be a typed failure in an `HttpApi` or `Rpc` contract. Map it at the boundary to a deliberately vague response (for example `DecryptionFailed` to 401); sending crypto failure detail to clients is how oracles leak.

## WebCrypto

`effect/crypto/WebCrypto` — unstable

`WebCrypto.WebCrypto` is a `Context.Reference` to the WebCrypto `Crypto` object (typed as `typeof globalThis.crypto`), defaulting to `globalThis.crypto`. Every `layerWebCrypto`, the `KeyFormat` functions, and key functions that touch `crypto.subtle` (such as `Mac.toBytes` on a `CryptoKey`) read it. `WebCrypto.layer(crypto)` swaps it for a polyfill, a worker's object, or a test double. A `CryptoKey` passed to `fromCryptoKey` must come from that same object. In a browser's insecure context, operations that need `crypto.subtle` die with `crypto.subtle is unavailable`, while layers still build and `SecureRandom` and the pure TypeScript algorithms (MD5, ChaCha20) keep working.

The `fromCryptoKey`, `privateKeyFromCryptoKey`, and `publicKeyFromCryptoKey` constructors of `Aead`, `Cipher`, `KeyAgreement`, `KeyWrap`, `Mac`, and `Signature` accept `WebCrypto.CryptoKey`, a structural type (`algorithm.name`, `extractable`, `type`, `usages`) that keys from both the browser's `crypto.subtle` and Node's `webcrypto` satisfy, so the declarations compile with only `@types/node` or only the DOM library. Satisfying the type proves nothing at runtime: the constructor checks the key's type, algorithm, and usages and fails with `InvalidKey` when they do not fit.

## JOSE: tokens and keys

The `effect/jose` modules implement compact JSON Web Keys, Signatures, Encryption, and Tokens on the services above: HMAC runs on [`Mac`](#mac), asymmetric signatures on [`Signature`](#signature), encryption on [`Aead`](#aead) with IVs from `SecureRandom`, thumbprints on [`Digest`](#digest), and key import and export on [`KeyFormat`](#keyformat). Each function's requirements name only the services it uses (verifying with an HMAC key needs `Mac`, with a public key `Signature`), so provide the same crypto layers as for direct use. Import them from the barrel: `import { Jwk, Jwks, Jwt } from "effect/jose"`.

The supported profile is deliberately small, and everything outside it is rejected rather than ignored:

| | Allowed |
| --- | --- |
| JWS algorithms | `HS256`, `HS384`, `HS512`; `RS256`/`RS384`/`RS512` (RSASSA-PKCS1-v1_5) and `PS256`/`PS384`/`PS512` (RSA-PSS), RSA keys of at least 2048 bits; `ES256`/`ES384`/`ES512` on P-256/P-384/P-521; `EdDSA` with Ed25519 only |
| JWE | `dir` key management with `A256GCM` content encryption only: no RSA-OAEP, AES key wrap, ECDH-ES, or password-based key management, so both sides share one 32-byte key |
| Serialization | compact only; the JSON serializations and the `crit`, `b64`, and (JWE) `zip` header parameters fail as `InvalidToken` |

`alg: "none"` is not an algorithm here. An unsecured token, or a token whose `alg` is not in the table, fails with `InvalidToken` before any key is used, in every function including `Jwt.decodeUnverified`.

- **The key chooses the algorithm.** A key is imported for exactly one algorithm (`Jwk.importPublic(jwk, "ES256")`), signing writes that algorithm into the protected header, and verifying a token whose `alg` differs from the key's fails with `AlgorithmNotAllowed`. An HS256 token is never checked with an RSA public key as the HMAC secret.
- **Key sets require an allow-list.** `Jws.verifyWithKeySet` and `Jwt.verifyWithKeySet` take a non-empty `algorithms` list of asymmetric algorithms. The token's `alg` is checked against it before any key lookup, and an HMAC token never verifies through a key set.
- **Nothing bounds token size.** Reject over-long input, such as an oversized `Authorization` header, before verifying, decrypting, or decoding it.
- **Secrets stay redacted.** `sign` and `encrypt` return `Redacted<string>`, the verify and decrypt functions accept a string or a `Redacted`, generated private and secret JWKs are `Redacted`, and the crypto key inside an imported key prints only its algorithm.
- **Key sets are services.** Verification by `kid` reads a [`Jwks`](#jwks) service: a fixed set from `Jwks.layerLocal`, or an HTTPS endpoint from `Jwks.layerRemote`. The remote layer fetches on first use, caches the set for `timeToLive` (10 minutes), refetches for an unknown key at most once per `cooldown` (30 seconds), and fails lookups with `KeySetUnavailable` when an expired set cannot be refreshed. It never falls back to the expired set.

## Jwk

`effect/jose/Jwk` — unstable

Imports keys and binds each to one algorithm. Imports need no services, because they run on [`KeyFormat`](#keyformat):

| Function | Input → result |
| --- | --- |
| `importPublic(jwk, algorithm)` | `PublicJwk` → `PublicKey`, for verification. Private members are rejected; decode untrusted JSON with the `Jwk.PublicJwk` schema first |
| `importPrivate(jwk, algorithm)` | `Redacted<PrivateJwk>` → `PrivateKey`, for signing; RSA keys need their CRT members |
| `importSecret(jwk, algorithm)` | `Redacted<SecretJwk>` → `SecretKey<A>` for `HS256`/`HS384`/`HS512` (at least 32, 48, or 64 bytes) or `"dir"` (exactly 32 bytes) |
| `importSpki(derOrPem, algorithm, { kid? })`, `importPkcs8(Redacted<derOrPem>, algorithm, { kid? })` | DER bytes or PEM text → `PublicKey` / `PrivateKey` |
| `exportPublic`, `exportPrivate`, `exportSpki(key, { format? })`, `exportPkcs8(key, { format? })` | back to a JWK carrying `alg`, `kid`, and `use: "sig"`, or to DER (default) or `{ format: "pem" }`; private output is `Redacted` |

An import fails with `InvalidKey` when the key's family or curve does not fit the algorithm, when its `alg`, `use`, or `key_ops` members forbid the use (`use` must be `"sig"`, or `"enc"` for `dir`; `key_ops` must include `verify` for a public key, `sign` for a private key, and both operations of a secret key: `sign` and `verify`, or `encrypt` and `decrypt` for `dir`), when an RSA modulus is shorter than 2048 bits, or when a key member is not canonical unpadded base64url. Failures on private and secret material use a fixed message and drop the backend's diagnostic.

`generateKeyPair({ algorithm, kid?, modulusLength? })` (needs `Signature`) returns `{ publicKey, privateKey }` as JWKs that both carry `alg`, `use: "sig"`, and the `kid` when one is given, with the private half redacted; RSA defaults to and requires at least 2048 bits. `generateSecret(algorithm, { kid? })` (needs `SecureRandom`) returns a redacted secret JWK of 32, 48, or 64 random bytes for HMAC and 32 for `dir`. `thumbprint(input, hash?)` computes an RFC 7638 thumbprint (SHA-256 by default, SHA-384 and SHA-512 allowed) and `thumbprintUri` its RFC 9278 URN; both need `Digest`, hash only the required members, and give a private key the same thumbprint as its public key. A secret key's thumbprint is derived from the secret, so treat it as sensitive.

```ts
import { Effect } from "effect"
import { Jwk, type Jwks } from "effect/jose"

// Rotate in a new signing key; publish only the public half.
export const rotateSigningKey = (kid: string) =>
  Effect.gen(function*() {
    const pair = yield* Jwk.generateKeyPair({ algorithm: "ES256", kid })
    const signingKey = yield* Jwk.importPrivate(pair.privateKey, "ES256")
    const fingerprint = yield* Jwk.thumbprint(pair.publicKey)
    // Serve as /.well-known/jwks.json; KeySet rejects private members.
    const document: Jwks.KeySet = { keys: [pair.publicKey] }
    return { signingKey, document, fingerprint, privateJwk: pair.privateKey }
  })
```

## Jws

`effect/jose/Jws` — unstable

Compact JSON Web Signatures over raw bytes. `Jws.sign(payload, key, header?)` returns a `Redacted<string>`. The header may set `typ`, `cty`, a `kid` (defaulting to the key's), and further JSON-valued parameters; `alg` comes from the key, and `crit` and `b64` cannot be set (a runtime attempt fails with `InvalidArgument`). `Jws.verify(token, key)` returns `{ protectedHeader, payload }`. Both require `Jws.KeyRequirements<K>`: `Mac` for an HMAC `SecretKey`, `Signature` for a `PrivateKey` or `PublicKey`.

`Jws.verifyWithKeySet(token, { algorithms })` reads the token's `alg` and `kid`, resolves a public key from the [`Jwks`](#jwks) service, and also returns the `key` it used; it requires `Jwks | Signature`. A resolved key whose algorithm differs from the token's is rejected with `AlgorithmNotAllowed`, even from a custom `Jwks` implementation.

| Failure | Reason |
| --- | --- |
| Wrong number of segments, non-canonical base64url, a header that is not a JSON object, an unsupported or malformed parameter, `alg: "none"` | `InvalidToken` |
| The token's `alg` is not the key's, is outside `algorithms`, or is HMAC through a key set | `AlgorithmNotAllowed` |
| The signature does not match | `SignatureVerificationFailed` |
| Key set lookup | `KeyNotFound`, `AmbiguousKey`, `KeySetUnavailable` |

Use `Jws` for signed non-JSON payloads; for JSON claims use [`Jwt`](#jwt). On Node.js and Bun, `NodeCrypto.layerMac` computes HMAC signatures synchronously on `node:crypto`.

## Jwt

`effect/jose/Jwt` — unstable

Signed and encrypted JWTs whose claims are a `Schema`. `Jwt.sign(schema, claims, key, header?)` encodes the claims through the schema and signs them; the encoded value must be a JSON object whose registered claims have the right shapes, or `sign` fails with a `Schema.SchemaError`. `Jwt.verify(schema, token, key, options?)`, `Jwt.verifyWithKeySet(schema, token, { algorithms, ...options })`, and, for encrypted tokens, `Jwt.encrypt` / `Jwt.decrypt` (see [`Jwe`](#jwe)) complete the set. The error type is `Jwt.JwtError`, which is `JoseError | Schema.SchemaError`. A verified result is `{ claims, registeredClaims, protectedHeader }`, plus `key` from `verifyWithKeySet` and `decrypt`.

Verification works in a fixed order: the options are validated, the token is authenticated, the registered claims are checked against the policy, and only then is the payload decoded with the application schema. A schema never sees an unauthenticated or expired payload, so its `SchemaError` always concerns an authentic token.

| Check | Default and rule |
| --- | --- |
| `exp` | Checked whenever present: the token is `expired` once the current second reaches `exp`, beyond `clockTolerance`. Not required unless listed in `requiredClaims` |
| `nbf` | Checked whenever present: `notYetValid` while it is later than now plus `clockTolerance` |
| `iat` | Ignored unless `maxTokenAge` is set; then it is required, fails `future` when later than now plus the tolerance, and `tooOld` when older than the maximum age |
| `iss`, `sub`, `aud` | Checked only when `issuer` (one value or a list), `subject`, or `audience` is given. A missing claim then fails `missing`; `aud`, a string or an array, must contain at least one accepted audience |
| `typ` header | Checked only when `typ` is given; compared case-insensitively, with the `application/` prefix optional, so `"at+jwt"` matches `"application/at+jwt"` |
| `jti` | Never checked beyond presence through `requiredClaims` |
| `clockTolerance` | Zero. A number is milliseconds; a negative, `NaN`, or infinite duration (here or in `maxTokenAge`) fails with `InvalidArgument` before any cryptography |
| Claim shapes | A registered claim of the wrong type, such as a string `exp`, fails `invalid` whether or not a policy reads it |

The current time comes from `Clock` in whole seconds, so `TestClock` drives expiry in tests. For access tokens, pass `requiredClaims: ["exp"]`; without it a token with no `exp` never expires.

`Jwt.decodeUnverified(token)` returns the protected header and the raw JSON claims of a signed JWT, and requires nothing. It still rejects a malformed token and an unsupported `alg` (including `none`), but it checks no signature, no time, and no claim shapes, and the claims are not schema-decoded. Use it only to choose how to verify, for example to read `iss` and pick the issuer's key set; never authorize from it.

```ts
import { Effect, Layer, Redacted, Schema } from "effect"
import { SecureRandom, Signature } from "effect/crypto"
import { FetchHttpClient } from "effect/http"
import { Jwks, Jwt } from "effect/jose"

class Unauthorized extends Schema.TaggedError<Unauthorized>()("Unauthorized", {}) {}

const AccessClaims = Schema.Struct({
  sub: Schema.String,
  scope: Schema.optionalKey(Schema.String)
})

// Every rejection becomes the same 401; the reason is logged server-side only.
export const authenticate = (bearer: string) =>
  Jwt.verifyWithKeySet(AccessClaims, Redacted.make(bearer), {
    algorithms: ["RS256", "ES256"],
    issuer: "https://login.example.com/",
    audience: "payroll-api",
    requiredClaims: ["exp"],
    clockTolerance: "30 seconds"
  }).pipe(
    Effect.map(({ claims }) => claims),
    Effect.tapError((error) => Effect.logDebug("token rejected", error.message)),
    Effect.mapError(() => new Unauthorized())
  )

// A fetch client that reports a redirect instead of following it.
const NoRedirectFetch = FetchHttpClient.layer.pipe(
  Layer.provide(Layer.succeed(FetchHttpClient.RequestInit, { redirect: "manual" }))
)

export const AuthLive = Layer.mergeAll(
  Jwks.layerRemote({ url: "https://login.example.com/.well-known/jwks.json" }).pipe(
    Layer.provide(NoRedirectFetch)
  ),
  Signature.layerWebCrypto.pipe(Layer.provide(SecureRandom.layerWebCrypto))
)
```

## Jwe

`effect/jose/Jwe` — unstable

Compact JSON Web Encryption with a shared key: `dir` key management and `A256GCM` content encryption. `Jwe.encrypt(plaintext, key, header?)` takes a `SecretKey<"dir">` from `Jwk.importSecret(jwk, "dir")`, draws a random 96-bit IV, and requires `Aead | SecureRandom`. `alg` and `enc` are fixed, `kid` defaults to the key's, and `crit` and `zip` are rejected. The protected header is the AEAD's additional data, so a modified header fails decryption.

`Jwe.decrypt(token, keyOrResolver)` returns `{ protectedHeader, plaintext, key }` and requires `Aead`. To rotate keys, pass a resolver `(header) => Effect<SecretKey<"dir">, E, R>` instead of a key: it runs after the structural checks, its errors and requirements are added to the result, and it receives an **unauthenticated** header, so use it only to select a key, for example by `kid`. A tampered token or the wrong key fails with a detail-free `DecryptionFailed`. `Jwt.encrypt` and `Jwt.decrypt` add schema-typed claims and the same claim policy as `Jwt.verify`, applied after authenticated decryption.

`dir` tokens are for one party, or for services that already share a secret. To encrypt for a recipient's public key, combine [`KeyAgreement`](#keyagreement), [`Kdf`](#kdf), and [`Aead`](#aead) yourself; JWE has no public-key key management in this profile.

## Jwks

`effect/jose/Jwks` — unstable

The `Jwks.Jwks` service resolves a verification key for a `Selection` of `{ algorithm, kid?, protectedHeader? }`. `Jwks.makeLocal(keySet)` and `Jwks.layerLocal(keySet)` serve a fixed set; `Jwks.makeRemote(options)` (requires `HttpClient | Scope`) and `Jwks.layerRemote(options)` (a `Layer<Jwks, JoseError, HttpClient>`) fetch one. The `Jwks.KeySet` schema accepts public JWKs, keeps keys of other families or curves without ever selecting them, and fails on a private or symmetric member anywhere in the set. A custom service built with `Jwks.Jwks.of({ resolve })` can select keys another way, for example from an extra header parameter; the `protectedHeader` it receives is unauthenticated.

**Key selection.** A key is a candidate when its family and curve fit the algorithm (`RSA` for `RS*` and `PS*`, `EC` on the matching curve for `ES*`, `OKP` Ed25519 for `EdDSA`), its `alg`, `use`, and `key_ops` members (when present) allow verification with that algorithm, and, when the token has a `kid`, its `kid` is equal. A key without `kid` never matches a token that has one. No candidate fails with `KeyNotFound`; more than one fails with `AmbiguousKey`, which is what a token without `kid` meets in a set holding two keys of one type. Issue tokens with a `kid`: `Jws.sign` copies the key's into the header. Each selected JWK is imported once per algorithm and cached.

**Remote key sets.** `layerRemote` validates its options when the layer is built and fails with `InvalidArgument` for a URL that is not HTTPS or that carries credentials or a fragment, a negative or non-finite duration, a zero `timeToLive` or `timeout`, or a limit that is not a positive integer. It does not fetch until the first lookup.

| Option | Default | Behavior |
| --- | --- | --- |
| `url` | required | Take it from configuration, never from a token. Only a `200` response from exactly this URL is accepted |
| `timeToLive` | 10 minutes | How long a fetched set is used. Concurrent lookups share one request |
| `cooldown` | 30 seconds | Minimum time since the last fetch attempt before refetching for an unknown key or retrying after a failure |
| `timeout` | 5 seconds | Covers the request and reading the body |
| `maxResponseBytes` | 131072 | A larger body fails the fetch |
| `maxKeys` | 64 | Counts every key in the document, including unsupported ones |

A lookup that finds no key in a fresh set refetches, unless the last attempt was within `cooldown`; then it fails with `KeyNotFound`. Unknown `kid`s cannot drive one request per token, and a key published seconds after a fetch is found only once the cooldown has passed. When there is no fresh set (first use, or after `timeToLive`), a failed fetch (non-`200` status, another URL, invalid document, size or key limits, timeout, transport error) fails every waiting lookup with `KeySetUnavailable`, and later lookups fail fast with the same reason until `cooldown` passes. There is no fallback to the expired set. A failed refetch for an unknown key fails only that lookup and keeps the fresh set in use. Closing the layer's scope interrupts a fetch in flight, and later lookups fail with `KeySetUnavailable`.

The URL check runs on the response, so it cannot stop a client from sending the redirected request. Give the layer a client that does not follow redirects: `FetchHttpClient` follows them unless its layer is given `FetchHttpClient.RequestInit` with `{ redirect: "manual" }` (as in the [`Jwt` example](#jwt)), and a client wrapped with `HttpClient.followRedirects` follows them too.

## JoseError

`effect/jose/JoseError` — unstable

Every `effect/jose` failure is one `JoseError` whose `reason` says what went wrong. Configuration, transport, and import reasons carry a `description` (and a `cause` when there is one); authentication reasons carry nothing about the token, its claims, the plaintext, or the key.

| Reason | Raised when |
| --- | --- |
| `InvalidToken` | The compact serialization, protected header, or payload is malformed, or uses an unsupported parameter or algorithm |
| `InvalidKey` | Key material cannot be imported or does not fit the algorithm or operation |
| `InvalidArgument` | An option is rejected before any work: empty `algorithms`, an unusable key-set URL, an invalid duration, a forbidden header parameter |
| `AlgorithmNotAllowed` | The token's `alg` is not the key's or is outside the allow-list |
| `SignatureVerificationFailed` / `DecryptionFailed` | Authentication failed |
| `KeyNotFound` / `AmbiguousKey` | No key, or more than one key, matches the algorithm and `kid` |
| `KeySetUnavailable` | A remote key set cannot be fetched or read, is cooling down after a failed fetch, or belongs to a closed layer |
| `ClaimValidationFailed` | `claim` is one of `iss`, `sub`, `aud`, `exp`, `nbf`, `iat`, `jti`, or `typ`, and `reason` is `invalid`, `missing`, `mismatch`, `expired`, `notYetValid`, `tooOld`, or `future` |

Match reasons with `Effect.catchReason("JoseError", "ClaimValidationFailed", ...)` and narrow unknown values with `JoseError.isJoseError` / `isJoseErrorReason`. Like `CryptoError`, it is not a schema; map it at the boundary to one vague response, such as a 401 for every authentication and claim failure, because telling a client which check failed helps an attacker.
