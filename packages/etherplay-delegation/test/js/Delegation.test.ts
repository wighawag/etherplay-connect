import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {network} from 'hardhat';
import {privateKeyToAccount, generatePrivateKey} from 'viem/accounts';
import {getContract} from 'viem';
import {DELEGATION_ABI, delegationMessage, delegationDigest} from '../../src/index.js';

/**
 * The seam between the contract and the library that produces the signature, exercised the way
 * production exercises it: a message built in TypeScript, signed by a key that never sends, and
 * submitted by somebody else through the ABI this package exports.
 *
 * The vectors (test/js/vectors.test.ts, test/solidity/Vectors.t.sol) pin the bytes. This pins that
 * the bytes are the ones the contract will actually accept, over the ABI boundary, with a real
 * signature and a real transaction - the part a fixture cannot fake.
 */
describe('Delegation, across the ABI boundary', () => {
	async function deployed() {
		const connection = await network.create();
		const {viem} = connection;
		const adopter = await viem.deployContract('PlainAdopter');
		const publicClient = await viem.getPublicClient();
		const [submitter] = await viem.getWalletClients();
		const chainId = await publicClient.getChainId();

		// The contract reached through the EXPORTED ABI rather than the compiled artifact, so a
		// hand-written entry that drifted from the Solidity fails here as a decode or a revert, and
		// not only in the ABI comparison next door.
		const contract = getContract({
			address: adopter.address,
			abi: DELEGATION_ABI,
			client: {public: publicClient, wallet: submitter},
		});

		return {contract, publicClient, submitter, chainId, address: adopter.address};
	}

	it('builds the same message in both languages, for a live deployment', async () => {
		const {contract, chainId, address} = await deployed();
		const delegate = privateKeyToAccount(generatePrivateKey()).address;

		// The contract and the chain come from the deployment, not from us: the TypeScript builder
		// has to be told them, and telling it the wrong thing is exactly the failure this catches.
		const terms = {delegate, contract: address, chainId, deadline: 0} as const;

		assert.equal(await contract.read.delegationMessage([delegate, 0n]), delegationMessage(terms));
		assert.equal(await contract.read.delegationDigest([delegate, 0n]), delegationDigest(terms));
	});

	it('renders the delegate lowercase, whichever casing it is given', async () => {
		const {contract, chainId, address} = await deployed();
		// viem hands out EIP-55 checksummed addresses, so this is the casing the builder actually
		// receives from an app. Both sides have to lowercase it.
		const checksummed = privateKeyToAccount(generatePrivateKey()).address;
		const lowercased = checksummed.toLowerCase() as `0x${string}`;
		assert.notEqual(checksummed, lowercased);

		const onchain = await contract.read.delegationMessage([checksummed, 0n]);
		assert.ok(onchain.includes(lowercased));
		assert.ok(!onchain.includes(checksummed));
		assert.equal(onchain, delegationMessage({delegate: checksummed, contract: address, chainId, deadline: 0}));
	});

	it('accepts a signature built and made off-chain, submitted and paid for by somebody else', async () => {
		const {contract, publicClient, chainId, address} = await deployed();

		// The owner: a key that signs and never sends. It holds nothing, and nothing here ever asks
		// it to, which is the whole point of this path.
		const owner = privateKeyToAccount(generatePrivateKey());
		const delegate = privateKeyToAccount(generatePrivateKey());
		const deadline = BigInt(Math.floor(Date.now() / 1000) + 30 * 24 * 3600);

		const signature = await owner.signMessage({
			message: delegationMessage({delegate: delegate.address, contract: address, chainId, deadline}),
		});

		const value = 10n ** 16n; // 0.01
		const hash = await contract.write.registerDelegateViaSignature(
			[owner.address, delegate.address, deadline, signature],
			{value},
		);
		await publicClient.waitForTransactionReceipt({hash});

		const [allowed, withdrawn] = await contract.read.delegationStatus([owner.address, delegate.address]);
		assert.equal(allowed, true);
		assert.equal(withdrawn, false);

		// Registered AND able to act: a delegate with no gas is registered in name only, which is
		// the state funding-on-registration exists to skip.
		assert.equal(await publicClient.getBalance({address: delegate.address}), value);
		// The owner paid nothing and sent nothing, which is the point.
		assert.equal(await publicClient.getBalance({address: owner.address}), 0n);
	});

	it('reports a revocation as withdrawn, which is what tells an app a signature cannot fix it', async () => {
		const {contract, publicClient, submitter} = await deployed();
		const owner = submitter.account.address; // an owner that can send, so it can revoke
		const delegate = privateKeyToAccount(generatePrivateKey()).address;

		await publicClient.waitForTransactionReceipt({
			hash: await contract.write.registerDelegate([delegate, delegate]),
		});
		assert.deepEqual(await contract.read.delegationStatus([owner, delegate]), [true, false]);

		await publicClient.waitForTransactionReceipt({hash: await contract.write.revokeDelegate([delegate])});

		// The two flags an app needs from one call: it cannot act, AND no signature will put it
		// back, so the remedy is a transaction from the owner rather than another credential.
		assert.deepEqual(await contract.read.delegationStatus([owner, delegate]), [false, true]);
	});

	it('refuses a signature made for another contract', async () => {
		const {contract, chainId} = await deployed();
		const owner = privateKeyToAccount(generatePrivateKey());
		const delegate = privateKeyToAccount(generatePrivateKey()).address;

		// The bound the whole design rests on: same owner, same delegate, same chain, different
		// contract. An app that stored the contract wrong ends up here, and so does a hostile one
		// trying to reuse a credential granted elsewhere.
		const signature = await owner.signMessage({
			message: delegationMessage({
				delegate,
				contract: '0x000000000000000000000000000000000000dead',
				chainId,
				deadline: 0,
			}),
		});

		await assert.rejects(
			contract.simulate.registerDelegateViaSignature([owner.address, delegate, 0n, signature]),
			/InvalidSignature/,
		);
	});

	it('refuses a credential whose deadline has passed', async () => {
		const {contract, chainId, address} = await deployed();
		const owner = privateKeyToAccount(generatePrivateKey());
		const delegate = privateKeyToAccount(generatePrivateKey()).address;
		const deadline = 1n; // one second past the epoch

		const signature = await owner.signMessage({
			message: delegationMessage({delegate, contract: address, chainId, deadline}),
		});

		await assert.rejects(
			contract.simulate.registerDelegateViaSignature([owner.address, delegate, deadline, signature]),
			/SignatureExpired/,
		);
	});

	it('emits the change as the enumeration API, both addresses filterable', async () => {
		const {contract, publicClient, chainId, address} = await deployed();
		const owner = privateKeyToAccount(generatePrivateKey());
		const first = privateKeyToAccount(generatePrivateKey()).address;
		const second = privateKeyToAccount(generatePrivateKey()).address;

		for (const delegate of [first, second]) {
			const signature = await owner.signMessage({
				message: delegationMessage({delegate, contract: address, chainId, deadline: 0}),
			});
			await publicClient.waitForTransactionReceipt({
				hash: await contract.write.registerDelegateViaSignature([owner.address, delegate, 0n, signature]),
			});
		}

		// There is no onchain list, so this is how an app learns an account has TWO delegates: one
		// filter, one decode, replayed in order.
		const logs = await publicClient.getContractEvents({
			address,
			abi: DELEGATION_ABI,
			eventName: 'DelegationChanged',
			args: {owner: owner.address},
			fromBlock: 0n,
		});

		assert.deepEqual(
			logs.map((log) => [log.args.delegate, log.args.allowed]),
			[
				[first, true],
				[second, true],
			],
		);
	});
});
