#!/usr/bin/env node
// telegraph-escrow CLI. The private key is read from EVM_PRIVATE_KEY or a .env file in the current directory; it is never printed.
import { readFileSync, existsSync } from "node:fs";
import { ask, balance, verifyDelivery, fund, accountFrom } from "../src/index.mjs";

const key = () => process.env.EVM_PRIVATE_KEY
  || (existsSync(".env") ? readFileSync(".env", "utf8").match(/EVM_PRIVATE_KEY=(0x[0-9a-fA-F]{64})/)?.[1] : undefined);
const show = o => console.log(JSON.stringify(o, null, 2));
const [cmd, ...args] = process.argv.slice(2);

const usage = `usage:
  telegraph-escrow balance [address]                 escrow balance (default: your wallet)
  telegraph-escrow fund <usdc>                       mint test USDC, approve, deposit (needs a little Sepolia ETH)
  telegraph-escrow ask '<json body>' [maxBudgetUusdc] pay one ask from escrow, print answer + receipts
  telegraph-escrow verify <epoch> <receipt_hash>     is the charge recorded in the epoch ledger block?
env: EVM_PRIVATE_KEY (or .env), TELEGRAPH_NODE (default devnode), SEPOLIA_RPC`;

try {
  if (cmd === "balance") show(await balance(args[0] || accountFrom(key()).address));
  else if (cmd === "fund") show(await fund(Number(args[0]), { privateKey: key() }));
  else if (cmd === "ask") {
    const body = JSON.parse(args[0] || "null");
    if (!body) throw new Error("ask needs a JSON body, e.g. '{\"intent\":\"NEWS_SEARCH_GENERAL\",\"params\":{\"query\":\"Telegraph\"}}'");
    if (args[1]) body.max_budget_usdc = Number(args[1]);
    const r = await ask(body, { privateKey: key() });
    show(r);
    process.exitCode = r.ok ? 0 : 1;
  } else if (cmd === "verify") show(await verifyDelivery(args[0], args[1]));
  else { console.log(usage); process.exitCode = cmd ? 1 : 0; }
} catch (e) {
  console.error(`error: ${e.message}`);
  process.exitCode = 1;
}
