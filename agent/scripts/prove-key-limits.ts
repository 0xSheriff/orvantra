// npm run prove-key-limits
// Using ONLY the agent's function-call key, try things a stolen agent key would want to do. Each must FAIL.
// Prints a PASS table (PASS = the attempt was refused). Demo material for the Security track.
// Nothing here can succeed with a correctly restricted key; with a full-access key the self-transfer of 1 yoctoNEAR
// would succeed (harmless) and the table would say FAIL.
import '../src/env.ts';
import { checkKeyPermission, keyPath, loadKey } from '../src/keys.ts';
import * as near from '../src/near.ts';
import { explorerTxUrl, signAndSend, TGAS, type TxSpec } from '../src/tx.ts';

const cfg = near.nearConfig();
const config = await near.getConfig(cfg);
const agent = process.env.AGENT_ID ?? config.agent;
const { key, keyPair } = loadKey(keyPath(cfg.network, agent));
const ak = await near.getAccessKey(cfg, agent, key.public_key);
const perm = checkKeyPermission(ak.permission, cfg.treasuryId);
console.log(`agent ${agent}, key ${key.public_key}`);
console.log(`on-chain permission: ${JSON.stringify(ak.permission)}`);
console.log(perm ? `WARNING: ${perm}` : `OK: function-call key, receiver ${cfg.treasuryId}, methods [propose_payment]`);

const attempts: { name: string; why: string; spec: TxSpec }[] = [
  {
    name: `treasury.set_limits (raise caps)`,
    why: 'method not in the key\'s allow-list (and owner-only + 1 yocto)',
    spec: { receiverId: cfg.treasuryId, methodName: 'set_limits', args: { auto_pay_threshold: '340282366920938463463374607431768211455', monthly_cap: '340282366920938463463374607431768211455', min_payout_age_sec: 0 }, gas: 30n * TGAS, deposit: 0n },
  },
  {
    name: `treasury.withdraw 1 unit to ${agent}`,
    why: 'function-call keys cannot attach deposits; method not allowed; owner-only',
    spec: { receiverId: cfg.treasuryId, methodName: 'withdraw', args: { amount: '1', receiver: agent }, gas: 50n * TGAS, deposit: 1n },
  },
  {
    name: `${config.token}.ft_transfer 1 unit`,
    why: `key receiver is ${cfg.treasuryId}, not the token contract`,
    spec: { receiverId: config.token, methodName: 'ft_transfer', args: { receiver_id: agent, amount: '1' }, gas: 30n * TGAS, deposit: 1n },
  },
  {
    name: `NEAR transfer 1 yocto to ${agent}`,
    why: 'function-call keys can only sign FunctionCall actions',
    spec: { receiverId: agent, transfer: 1n },
  },
];

const rows: { name: string; result: string; pass: boolean }[] = [];
for (const a of attempts) {
  process.stdout.write(`trying: ${a.name} ... `);
  try {
    const out = await signAndSend(cfg, agent, keyPair, a.spec);
    if (out.failure) {
      rows.push({ name: a.name, result: `failed in execution: ${out.failure.slice(0, 90)} (${explorerTxUrl(cfg.network, out.tx_hash)})`, pass: true });
    } else {
      rows.push({ name: a.name, result: `SUCCEEDED (${explorerTxUrl(cfg.network, out.tx_hash)})`, pass: false });
    }
  } catch (err) {
    const msg = (err as Error).message;
    const kind = msg.match(/MethodNameMismatch|ReceiverMismatch|DepositWithFunctionCall|RequiresFullAccess|NotEnoughAllowance|InvalidAccessKeyError|AccessKeyNotFound|UNKNOWN_ACCESS_KEY/)?.[0];
    rows.push({ name: a.name, result: `refused by the network: ${kind ?? msg.slice(0, 120)}`, pass: true });
  }
  console.log(rows.at(-1)!.pass ? 'refused' : 'SUCCEEDED (!)');
}

console.log(`\n${'attempt'.padEnd(46)} ${'result'.padEnd(6)} details`);
console.log(`${'-'.repeat(46)} ${'-'.repeat(6)} ${'-'.repeat(60)}`);
for (const [i, r] of rows.entries()) {
  console.log(`${r.name.padEnd(46).slice(0, 46)} ${(r.pass ? 'PASS' : 'FAIL').padEnd(6)} ${r.result}`);
  console.log(`${''.padEnd(53)} expected: ${attempts[i].why}`);
}
const allPass = rows.every((r) => r.pass);
console.log(`\n${allPass ? 'PASS' : 'FAIL'}: ${rows.filter((r) => r.pass).length}/${rows.length} attempts refused. The agent key can only call ${cfg.treasuryId}.propose_payment.`);
process.exit(allPass && !perm ? 0 : 1);
