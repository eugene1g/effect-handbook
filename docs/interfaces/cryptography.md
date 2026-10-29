# Cryptography

The `effect/crypto` modules split cryptography into one service per job: `SecureRandom`, `Digest`, `Mac`, `Aead`, `Cipher`, `Kdf`, `Signature`, `KeyAgreement`, and `KeyWrap`. `KeyFormat` reads and writes keys, `CryptoError` is the only error they fail with, and `WebCrypto` is the reference that the WebCrypto-backed layers run on. Each service is an ordinary `Context.Service`, so a program asks for only the services it uses and a test replaces just those.

Choose by the job, not by the algorithm:

| You need | Use | Not |
| --- | --- | --- |
| Random bytes, UUIDs, ULIDs, dice rolls, shuffles that must not be guessable | [`SecureRandom`](#securerandom) | `effect/Random`, which is seedable and not secure |
| A checksum, content hash, or pseudonymous lookup key | [`Digest`](#digest) | a MAC, unless a secret is involved |
| Proof that a message came from someone holding a shared secret (webhooks, signed cookies) | [`Mac`](#mac) | comparing digests with `===` |
| Encrypt data so tampering is detected | [`Aead`](#aead) | [`Cipher`](#cipher) |
| A protocol that pairs AES-CTR or AES-CBC with its own MAC | [`Cipher`](#cipher) | — |
| Turn a password or shared secret into key bytes | [`Kdf`](#kdf) | using the secret as a key directly |
| Public-key signatures (JWS, release signing) | [`Signature`](#signature) | — |
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

Malformed data or a key of another algorithm fails with `InvalidKey`; encoding a non-extractable `CryptoKey` fails with `NotExtractable`. EC private keys must include their public point, written JWKs contain only `kty`, `crv`, and the key material, and callers parse and stringify JSON themselves.

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

`WebCrypto.WebCrypto` is a `Context.Reference` to the WebCrypto `Crypto` object, defaulting to `globalThis.crypto`. Every `layerWebCrypto`, the `KeyFormat` functions, and key functions that touch `crypto.subtle` (such as `Mac.toBytes` on a `CryptoKey`) read it. `WebCrypto.layer(crypto)` swaps it for a polyfill, a worker's object, or a test double. A `CryptoKey` passed to `fromCryptoKey` must come from that same object. In a browser's insecure context, operations that need `crypto.subtle` die with `crypto.subtle is unavailable`, while layers still build and `SecureRandom` and the pure TypeScript algorithms (MD5, ChaCha20) keep working.
