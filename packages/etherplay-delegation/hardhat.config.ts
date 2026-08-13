import type {HardhatUserConfig} from 'hardhat/config';

import HardhatNodeTestRunner from '@nomicfoundation/hardhat-node-test-runner';
import HardhatViem from '@nomicfoundation/hardhat-viem';

// This package deploys nothing, so there is no deployment plugin, no network
// list and no accounts configuration here: `hardhat test` runs the suite
// against an in-process EDR chain and that is the whole of it. See the README
// for why a shared deployment of this library would defeat its design.
const config: HardhatUserConfig = {
	plugins: [HardhatNodeTestRunner, HardhatViem],
	test: {
		solidity: {
			fsPermissions: {
				readFile: ['vectors.json'],
			},
		},
	},
	solidity: {
		profiles: {
			default: {
				version: '0.8.28',
			},
			production: {
				version: '0.8.28',
				settings: {
					optimizer: {
						enabled: true,
						runs: 999999,
					},
				},
			},
		},
	},
	paths: {
		// `contracts` is the published Solidity, and nothing else. Tests live
		// under `test`, split by the language they are written in: Solidity tests
		// exercise the library from inside the EVM (cheatcodes, storage slots,
		// fuzzing), TypeScript ones exercise it across the ABI boundary, the way
		// an app does.
		sources: ['contracts'],
		tests: {
			solidity: 'test/solidity',
			nodejs: 'test/js',
		},
	},
	generateTypedArtifacts: {
		destinations: [
			{
				folder: './generated',
				mode: 'typescript',
			},
		],
	},
};

export default config;
