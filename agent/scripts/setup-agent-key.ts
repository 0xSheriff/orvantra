// npm run setup-agent-key -- --account <agent> --contract <treasury> [--network testnet] [--allowance 0.25] [--force]
// Generates the agent's ed25519 key OUTSIDE the repo (~/.orvantra/keys/<network>/<account>.json, mode 600) and prints
// the near-cli-rs command that adds it as a FUNCTION-CALL key (receiver = treasury, method = propose_payment only).
// It never touches the chain itself and never prints the private key.
import { addKeyCommand, DEFAULT_ALLOWANCE_NEAR, generateAgentKey, keyPath, saveKey } from '../src/keys.ts';

const argv = process.argv.slice(2);
const arg = (name: string, def?: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : def;
};
const account = arg('account');
const contract = arg('contract');
const network = arg('network', 'testnet')!;
const allowance = arg('allowance', DEFAULT_ALLOWANCE_NEAR)!;
if (!account || !contract) {
  console.error('usage: npm run setup-agent-key -- --account <agent> --contract <treasury> [--network testnet] [--allowance 0.25] [--force]');
  process.exit(2);
}
if (network === 'mainnet' && !argv.includes('--i-understand-mainnet')) {
  console.error('mainnet keys need --i-understand-mainnet (the add-key command must then be signed by the mainnet owner)');
  process.exit(2);
}

const path = keyPath(network, account);
const key = generateAgentKey(account, contract, network);
saveKey(path, key, argv.includes('--force'));

console.log(`Saved new agent key -> ${path} (mode 600, outside the repo; private key not printed)`);
console.log(`public key: ${key.public_key}\n`);
console.log(`Add it on-chain as a FUNCTION-CALL key (run as the owner of ${account}):\n`);
console.log(addKeyCommand({ account, contract, publicKey: key.public_key, network, allowanceNear: allowance }));
console.log(`\nCheck:  near account list-keys ${account} network-config ${network} now`);
console.log(`        -> ${key.public_key} with "function call" permission: receiver ${contract}, method propose_payment, allowance ${allowance} NEAR`);
console.log('Then:   npm run prove-key-limits   (shows the key cannot do anything else)');
