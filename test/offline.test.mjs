// Offline tests: no network, a throwaway key generated per run.
import { test } from "node:test";
import assert from "node:assert/strict";
import { generatePrivateKey } from "viem/accounts";
import { verifyMessage } from "viem";
import { signEscrow, escrowOption, accountFrom } from "../src/index.mjs";

// shape of a real devnode 402 challenge (2026-11-24)
const CHALLENGE = { error: "payment required", accepts: [
  { scheme: "exact", price: "$0.01", network: "eip155:84532", payTo: "0xC0A3FB6d3F1f4B54617d29ffbdA4663Af5F96e2e" },
  { scheme: "escrow", price: "$0.01", network: "eip155:11155111", payTo: "0x72a70e949362670bf8bcead24efc5b8f950aa08b",
    extra: { signWith: "personal_sign (EIP-191)", resource: "/v1/ask",
      message: "Telegraph Escrow Payment\n\nWallet: {from}\nPay To: 0x72a70e949362670bf8bcead24efc5b8f950aa08b\nNetwork: eip155:11155111\nAmount: 10000 uUSDC\nResource: /v1/ask\nNonce: {nonce}\nValid After: {validAfter}\nValid Before: {validBefore}" } },
] };
const account = accountFrom(generatePrivateKey());
const option = escrowOption(CHALLENGE);

test("finds the escrow option", () => assert.equal(option.scheme, "escrow"));

test("signature verifies against the filled template", async () => {
  const s = await signEscrow(option, account);
  assert.ok(await verifyMessage({ address: account.address, message: s.message, signature: s.signature }));
  assert.ok(!/\{(from|nonce|validAfter|validBefore)\}/.test(s.message), "all placeholders filled");
});

test("from is lowercase, window under 2 minutes, amount read from template", async () => {
  const s = await signEscrow(option, account, { now: 1_800_000_000 });
  assert.equal(s.authorization.from, account.address.toLowerCase());
  assert.ok(Number(s.authorization.validBefore) - Number(s.authorization.validAfter) < 120);
  assert.equal(s.authorization.value, "10000");
});

test("fresh nonce every call", async () => {
  const a = await signEscrow(option, account), b = await signEscrow(option, account);
  assert.notEqual(a.authorization.nonce, b.authorization.nonce);
});

test("X-PAYMENT header decodes to x402 v2 escrow payload", async () => {
  const s = await signEscrow(option, account);
  const p = JSON.parse(Buffer.from(s.header, "base64").toString());
  assert.equal(p.x402Version, 2); assert.equal(p.scheme, "escrow"); assert.equal(p.network, "eip155:11155111");
  assert.equal(p.payload.signature, s.signature);
});

test("per-call cap refuses to sign above the limit", async () => {
  await assert.rejects(signEscrow(option, account, { maxPerCallUusdc: 5_000 }), /refusing to sign/);
});

test("rejects a malformed key without echoing it", () => {
  assert.throws(() => accountFrom("0x1234"), e => /malformed/.test(e.message) && !e.message.includes("0x1234"));
});
