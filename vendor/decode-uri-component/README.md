# CommonJS URI decoder compatibility patch

This local package adapts the MIT-licensed upstream
[`decode-uri-component` v0.5.1](https://github.com/SamVerschueren/decode-uri-component/tree/v0.5.1).
The original license is included in `license`. Source retrieved on 2026-10-28 from
the tagged [`index.js`](https://raw.githubusercontent.com/SamVerschueren/decode-uri-component/v0.5.1/index.js).

Expo Router 57 uses CommonJS `query-string` 7, which expects
`require('decode-uri-component')` to return a function. The installed upstream 0.2.2
decoder had unbounded recursive work for malformed URLs
([GHSA-vcc3-ghjq-m6fr](https://github.com/SamVerschueren/decode-uri-component/security/advisories/GHSA-vcc3-ghjq-m6fr)).
Upstream 0.5.1 contains the linear scanner and avoids rescanning decoded output,
but publishes an ESM default export that does not satisfy that CommonJS contract.

The adapted source preserves upstream 0.5.1 with two compatibility changes:

- Replace the default ESM export with `module.exports` in `index.cjs`.
- Preserve 0.2.2's conversion of literal `+` to space before decoding. Encoded
  `%2B` still decodes to `+`, and percent-encoded output is not decoded twice.

The root file dependency and `$decode-uri-component` override install this package
for every dependency using the decoder. The direct dependency also anchors the
lockfile's local path at the repository root so fresh `npm ci` installs resolve it
correctly. It does not replace Expo Router or change the Expo SDK. The package
version includes `+drivemate.cjs.1` to identify the local adaptation.

`src/domain/uriDecoder.test.ts` exercises the installed dependency, the actual
`query-string` consumer, valid Korean text, malformed UTF-8, percent escaping,
and bounded execution of a large malformed query in a separate process.

Remove the override when the supported Expo Router dependency chain consumes a
fixed compatible upstream decoder. Re-run the decoder tests, Expo checks, and
web/native exports when changing it. This patch does not resolve the separate
development-tool advisories for Zod or deepmerge.
