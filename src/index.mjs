// telegraph-escrow: pay Telegraph asks from the escrow ledger and verify each charge in the epoch ledger block.
// Works when the per-request x402 `exact` rails fail ("settlement failed"): you deposit once on the Ethereum Sepolia Diamond, then each
// request is authorised with an EIP-191 signature and charged in the next ledger block. Failed requests are not charged.
import { randomUUID } from "node:crypto";
import { privateKeyToAccount } from "viem/accounts";

export const DEFAULT_NODE = "https://devnode.telegraphprotocol.com";
export const SEPOLIA = { USDC: "0xcc194e1a843B658526D0D5C431f670028582Ae17", DIAMOND: "0x72a70e949362670Bf8bceAd24eFC5b8f950aa08b" };
const UA = { "User-Agent": "telegraph-escrow/0.1 (+https://github.com/a2taka-sourse/telegraph-escrow)" };
const nodeOf = o => (o?.node || process.env.TELEGRAPH_NODE || DEFAULT_NODE).replace(/\/$/, "");

/** viem account from an explicit key or EVM_PRIVATE_KEY. The key is never logged or returned. */
export function accountFrom(privateKey = process.env.EVM_PRIVATE_KEY) {
  if (!/^0x[0-9a-fA-F]{64}$/.test(privateKey || "")) throw new Error("private key missing or malformed (expected 0x + 64 hex)");
  return privateKeyToAccount(privateKey);
}

/** the escrow option of a 402 challenge, or null */
export function escrowOption(challenge) {
  return challenge?.accepts?.find(a => a.scheme === "escrow") ?? null;
}

/**
 * Build and sign the escrow authorisation for one request (pure apart from the clock and nonce; exported for testing).
 * The node's rules, learned the hard way: `from` must be lowercase, the validity window must stay under 2 minutes, and the nonce must be fresh.
 */
export async function signEscrow(option, account, { now = Math.floor(Date.now() / 1000), nonce = randomUUID(), maxPerCallUusdc = 50_000 } = {}) {
  const template = option?.extra?.message;
  if (!template) throw new Error("challenge has no escrow message template");
  const amount = template.match(/Amount:\s*(\d+)\s*uUSDC/)?.[1];
  if (!amount) throw new Error("cannot read the amount from the escrow template");
  if (Number(amount) > maxPerCallUusdc) throw new Error(`refusing to sign ${amount} uUSDC: above maxPerCallUusdc ${maxPerCallUusdc}`);
  const authorization = {
    from: account.address.toLowerCase(),
    to: option.payTo,
    value: amount,
    validAfter: String(now - 5),
    validBefore: String(now + 100),
    nonce,
  };
  const message = template.replace("{from}", authorization.from).replace("{nonce}", authorization.nonce)
    .replace("{validAfter}", authorization.validAfter).replace("{validBefore}", authorization.validBefore);
  const signature = await account.signMessage({ message });
  const header = Buffer.from(JSON.stringify({ x402Version: 2, scheme: "escrow", network: option.network, payload: { signature, authorization } })).toString("base64");
  return { header, message, authorization, signature };
}

const b64json = h => { try { return h ? JSON.parse(Buffer.from(h, "base64").toString()) : null; } catch { return null; } };

/**
 * Ask the node and pay from escrow.
 * body: what you would POST to /engine/v1/ask, e.g. { intent: "NEWS_SEARCH_GENERAL", params: { query: "..." } }.
 *       Add max_budget_usdc (in uUSDC) to let the node use several ranked miners; you are billed one row per answer used.
 * Never throws on network or payment failure: check `ok`. A failed request (ok=false) is not charged on this rail.
 */
export async function ask(body, { privateKey, node, timeoutMs = 60_000, maxPerCallUusdc = 50_000 } = {}) {
  const N = nodeOf({ node });
  const account = accountFrom(privateKey);
  const raw = JSON.stringify(body);
  const json = { "Content-Type": "application/json", ...UA };
  let challenge;
  try {
    const r = await fetch(`${N}/engine/v1/ask`, { method: "POST", headers: json, body: raw, signal: AbortSignal.timeout(20_000) });
    challenge = await r.json();
  } catch (e) { return { ok: false, stage: "challenge", error: e.message }; }
  const option = escrowOption(challenge);
  if (!option) return { ok: false, stage: "challenge", error: `no escrow option in the 402 challenge: ${JSON.stringify(challenge).slice(0, 200)}` };
  let signed;
  try { signed = await signEscrow(option, account, { maxPerCallUusdc }); }
  catch (e) { return { ok: false, stage: "sign", error: e.message }; }

  const t0 = Date.now();
  let res, answer;
  try {
    res = await fetch(`${N}/engine/v1/ask`, { method: "POST", headers: { ...json, "X-PAYMENT": signed.header }, body: raw, signal: AbortSignal.timeout(timeoutMs) });
    answer = await res.json().catch(() => null);
  } catch (e) { return { ok: false, stage: "ask", error: e.message, authorized_uusdc: signed.authorization.value }; }
  const first = b64json(res.headers.get("x-payment-response"));
  const receipts = answer?.fulfillment?.payments ?? (first ? [first] : []);
  const out = {
    ok: res.status === 200, status: res.status, latency_ms: Date.now() - t0, answer,
    payer: account.address, network: option.network, diamond: option.payTo,
    authorized_uusdc: Number(signed.authorization.value),
    charged_uusdc: receipts.reduce((a, r) => a + Number(r.amount_uusdc ?? r.amount ?? 0), 0),
    receipts,
    verify: receipts.filter(r => r.epoch_id != null && r.receipt_hash).map(r => ({ epoch_id: r.epoch_id, receipt_hash: r.receipt_hash, url: `${N}/v1/blocks/${r.epoch_id}/deliveries/${r.receipt_hash}` })),
  };
  if (!out.ok) out.error = answer?.reason || answer?.error || `HTTP ${res.status}`;
  return out;
}

/**
 * Escrow balance as the node sees it (amounts in uUSDC, as numbers).
 * Note: a fresh deposit can show in `available` before it is spendable; asks may be refused until the next ledger root
 * (https://github.com/telegraphprotocol/bounties/issues/232). `in_active_root` is the balance in the root asks are checked against.
 */
export async function balance(address, { node } = {}) {
  const N = nodeOf({ node });
  const r = await fetch(`${N}/v1/ledger/account/${address}`, { headers: UA, signal: AbortSignal.timeout(15_000) });
  if (!r.ok) throw new Error(`ledger account HTTP ${r.status}`);
  const j = await r.json();
  const n = v => (v == null ? null : Number(v));
  return {
    address: j.address, deposited: n(j.deposited), charged: n(j.charged), withdrawn: n(j.withdrawn), available: n(j.available),
    in_active_root: n(j.active_root?.balance), active_root_epoch: j.active_root?.epoch_id ?? null, charge_limit: n(j.charge_limit),
    deposit_not_yet_in_root: n(j.available) != null && n(j.active_root?.balance) != null && n(j.available) > n(j.active_root?.balance),
  };
}

/**
 * Was this charge recorded in the node's epoch ledger block? status: recorded | mismatch | pending (block not recorded yet) | error.
 * expect: { payer, intent, usdc } to compare the recorded row with what you paid for.
 * Limitation: the Merkle leaf encoding is not published (https://github.com/telegraphprotocol/bounties/issues/231), so the proof is returned
 * but not re-derived locally.
 */
export async function verifyDelivery(epoch, receiptHash, expect = {}, { node } = {}) {
  if (!/^\d{1,9}$/.test(String(epoch)) || !/^0x[0-9a-fA-F]{64}$/.test(String(receiptHash))) return { status: "error", error: "bad epoch or receipt hash" };
  const url = `${nodeOf({ node })}/v1/blocks/${epoch}/deliveries/${receiptHash}`;
  let r, j;
  try {
    r = await fetch(url, { headers: UA, signal: AbortSignal.timeout(15_000) });
    j = await r.json().catch(() => null);
  } catch (e) { return { status: "error", error: e.message, url }; }
  if (r.status === 404) return { status: "pending", url, note: j?.error || "epoch block not recorded yet (can take about an hour on testnet)" };
  if (!r.ok || !j?.delivery) return { status: "error", error: `HTTP ${r.status}`, url };
  const d = j.delivery, problems = [];
  if (d.receipt_hash?.toLowerCase() !== receiptHash.toLowerCase()) problems.push("receipt_hash");
  if (expect.payer && d.payer?.toLowerCase() !== expect.payer.toLowerCase()) problems.push("payer");
  if (expect.intent && d.intent !== expect.intent) problems.push("intent");
  if (expect.usdc != null && Number(d.usdc) !== Math.round(Number(expect.usdc) * 1e6)) problems.push("amount");
  return { status: problems.length ? "mismatch" : "recorded", problems, url, epoch_id: j.epoch_id, delivery: d,
    deliveries_root: j.deliveries_root, proof_length: (j.proof || []).length };
}

/**
 * One-time funding on Ethereum Sepolia: mint test USDC (anyone can), approve the Diamond, LedgerFacet.depositUSDC.
 * Needs a little Sepolia ETH for gas (three transactions). usdc: whole test USDC, e.g. 5.
 */
export async function fund(usdc, { privateKey, rpc = process.env.SEPOLIA_RPC || "https://ethereum-sepolia-rpc.publicnode.com", log = console.log } = {}) {
  const { createPublicClient, createWalletClient, http, parseAbi, formatEther } = await import("viem");
  const { sepolia } = await import("viem/chains");
  const account = accountFrom(privateKey);
  const amount = BigInt(Math.round(Number(usdc) * 1e6));
  if (amount <= 0n) throw new Error("amount must be positive");
  const pub = createPublicClient({ chain: sepolia, transport: http(rpc) });
  const wal = createWalletClient({ account, chain: sepolia, transport: http(rpc) });
  const erc20 = parseAbi(["function mint(address,uint256)", "function approve(address,uint256) returns (bool)", "function balanceOf(address) view returns (uint256)"]);
  const ledger = parseAbi(["function depositUSDC(uint256)"]);
  const eth = await pub.getBalance({ address: account.address });
  if (eth < 500_000_000_000_000n) throw new Error(`not enough Sepolia ETH for gas (${formatEther(eth)}; need ~0.0005). Use a Sepolia faucet first.`);
  const send = async (label, req) => {
    const hash = await wal.writeContract(req);
    const rc = await pub.waitForTransactionReceipt({ hash });
    log(`${label} ${rc.status} ${hash}`);
    if (rc.status !== "success") throw new Error(`${label} failed`);
    return hash;
  };
  const bal = await pub.readContract({ address: SEPOLIA.USDC, abi: erc20, functionName: "balanceOf", args: [account.address] });
  const txs = {};
  if (bal < amount) txs.mint = await send("mint   ", { address: SEPOLIA.USDC, abi: erc20, functionName: "mint", args: [account.address, amount - bal] });
  txs.approve = await send("approve", { address: SEPOLIA.USDC, abi: erc20, functionName: "approve", args: [SEPOLIA.DIAMOND, amount] });
  txs.deposit = await send("deposit", { address: SEPOLIA.DIAMOND, abi: ledger, functionName: "depositUSDC", args: [amount] });
  return { address: account.address, deposited_uusdc: Number(amount), txs };
}
