# telegraph-escrow

Pay Telegraph asks from the **escrow ledger** and **verify each charge** in the epoch ledger block. One small module (`viem` is the only dependency), a CLI, and offline tests.

**Why:** on the devnode, the per-request x402 `exact` rails can fail with `settlement failed` or time out at the facilitator
([#214](https://github.com/telegraphprotocol/bounties/issues/214), [#215](https://github.com/telegraphprotocol/bounties/issues/215)), and failed asks on those rails can still settle, which breaks spending caps ([#228](https://github.com/telegraphprotocol/bounties/issues/228)).
The escrow rail avoids both: you deposit once on the Ethereum Sepolia Diamond, each ask is authorised with an EIP-191 signature, it is charged in the next ledger block, and **a failed ask is not charged**. The catch is that the signature has to be exactly right, and that is where most of the time goes. This package does that part.

> Disclosure: written by a Telegraph Hackathon Season II participant (Escalation Ledger, mission 05), extracted from that app. MIT licence. Testnet only.

## 5-minute quick start

```sh
git clone https://github.com/a2taka-sourse/telegraph-escrow && cd telegraph-escrow && npm install
echo "EVM_PRIVATE_KEY=0x<a throwaway testnet key>" > .env   # never a key that holds real funds

node bin/cli.mjs fund 5          # mint 5 test USDC, approve, deposit (needs ~0.0005 Sepolia ETH for gas)
node bin/cli.mjs balance         # wait until deposit_not_yet_in_root is false (next ledger root, see notes)
node bin/cli.mjs ask '{"intent":"NEWS_SEARCH_GENERAL","params":{"query":"Telegraph protocol testnet"}}' 30000
node bin/cli.mjs verify <epoch_id> <receipt_hash>   # from the ask output; "pending" until the epoch block is recorded
```

Real output from 2026-11-24 (trimmed): the ask authorised up to 30,000 uUSDC, the node used one miner and charged 10,000.

```json
{ "ok": true, "status": 200, "latency_ms": 41494, "authorized_uusdc": 30000, "charged_uusdc": 10000,
  "verify": [{ "epoch_id": 48, "receipt_hash": "0x2c71200676db109109a98693d858c8be6fc8874f83f8c3fb9e399c523b63d992",
               "url": "https://devnode.telegraphprotocol.com/v1/blocks/48/deliveries/0x2c71…d992" }] }
```

An older charge, already in its block:

```sh
node bin/cli.mjs verify 26 0x050afcf916f3e96d9faccd69e4c9a8289813d3c07f6d4d82e08f2dfe44e7a989
# -> "status": "recorded", payer / intent NEWS_SEARCH_GENERAL / usdc 10000 / miner 6119
```

## Library

```js
import { ask, balance, verifyDelivery, fund } from "./src/index.mjs";   // or the package name once installed

const r = await ask({ intent: "NEWS_SEARCH_GENERAL", params: { query: "..." }, max_budget_usdc: 30000 },
                    { privateKey: process.env.EVM_PRIVATE_KEY, maxPerCallUusdc: 50000 });
if (!r.ok) console.log("not charged:", r.error);          // never throws on network/payment failure
else {
  console.log(r.answer, r.charged_uusdc);                 // charged = sum of the receipt rows (one per miner answer used)
  for (const v of r.verify) console.log(await verifyDelivery(v.epoch_id, v.receipt_hash, { payer: r.payer }));
}
```

| Function | Returns |
|---|---|
| `ask(body, { privateKey, node, timeoutMs, maxPerCallUusdc })` | `{ ok, status, answer, authorized_uusdc, charged_uusdc, receipts, verify[], error }` |
| `balance(address)` | `{ deposited, charged, available, in_active_root, active_root_epoch, deposit_not_yet_in_root }` (uUSDC) |
| `verifyDelivery(epoch, receiptHash, { payer, intent, usdc })` | `{ status: recorded \| mismatch \| pending \| error, delivery, deliveries_root, proof_length }` |
| `fund(usdc, { privateKey, rpc })` | `{ deposited_uusdc, txs: { mint?, approve, deposit } }` |
| `signEscrow(option, account)` | the signed authorisation and the `X-PAYMENT` header (for your own HTTP client) |

## What the signature must look like (the parts that cost us hours)

1. Ask once without payment; the 402 lists an `escrow` option whose `extra.message` is a template.
2. Fill `{from}` with your address **in lowercase** (the node lowercases before checking), a **fresh nonce** (never reuse), and a validity window **under 2 minutes**.
3. Sign the filled text with `personal_sign` (EIP-191), not EIP-712.
4. Send `X-PAYMENT: base64({ x402Version: 2, scheme: "escrow", network, payload: { signature, authorization } })`.
5. The amount in the template is what you authorise. With `max_budget_usdc` the node may route to several ranked miners and bills one row per answer used, so `charged` can be lower than `authorized`. `maxPerCallUusdc` (default 50,000 = $0.05) makes the client refuse to sign anything larger.

## Known issues (upstream)

- **A new deposit is not spendable right away.** It can show in `available` while asks are refused until the next ledger root (about 1.5 h in our case). `balance()` reports `deposit_not_yet_in_root`. [#232](https://github.com/telegraphprotocol/bounties/issues/232)
- **The ledger proof cannot be re-derived locally**: the Merkle leaf encoding is not published, so `verifyDelivery` checks the recorded row against your purchase and returns the proof without recomputing the root. [#231](https://github.com/telegraphprotocol/bounties/issues/231)
- Answers served by the generic LLM fallback, and empty verdicts, can still be charged. Check `answer.miner_id` and the answer itself. [#233](https://github.com/telegraphprotocol/bounties/issues/233), [#234](https://github.com/telegraphprotocol/bounties/issues/234)

## Tests

`npm test` runs 7 offline checks with a throwaway key: the signature verifies against the filled template, `from` is lowercase, the window is under 2 minutes, the nonce is fresh, the header decodes, the per-call cap refuses, and a malformed key is rejected without being echoed.

Issues and "it didn't work for me" reports are welcome: https://github.com/a2taka-sourse/telegraph-escrow/issues
