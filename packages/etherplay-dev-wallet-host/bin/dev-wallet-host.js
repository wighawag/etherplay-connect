#!/usr/bin/env node
/**
 * Serve the prebuilt development sign-in host.
 *
 * This file is only ever the entry point, so it just runs. The server itself is in ../lib/server.js,
 * where the tests reach it without spawning anything: deciding "am I the entry point" from
 * `process.argv[1]` is a question with a wrong answer when the bin is reached through the `.bin`
 * symlink an install creates, which is every real use of this.
 */
import {readFile, stat} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {createHost, DEFAULT_DIR, DEFAULT_PORT} from '../lib/server.js';

const HELP = `
  dev-wallet-host - the Etherplay sign-in host, prebuilt, for development and e2e

  DEVELOPMENT ONLY. This build accepts its configuration at runtime and is unfit for
  real accounts by construction. Do not deploy it.

  Usage
    dev-wallet-host [options]

  Options
    -p, --port <number>   port to listen on              (default ${DEFAULT_PORT})
    -H, --host <address>  address to bind                (default 127.0.0.1)
    -c, --config <file>   serve this file as /config.json, read fresh on every request
    -d, --dir <path>      serve this directory instead of the bundled one
    -v, --version         print the version
    -h, --help            print this

  Notes
    Signing in by mnemonic needs no key, no account and no network: it defaults to the
    standard hardhat test phrase, and the only input is which account index to use.

    Binding to 0.0.0.0 so another device can reach this gives up secure-context status,
    which the optional domain-redirect bridge needs. The ordinary popup flow is fine.
`;

function parseArgs(argv) {
	const options = {port: DEFAULT_PORT, host: '127.0.0.1', dir: DEFAULT_DIR, config: undefined};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		const next = () => {
			const value = argv[++i];
			if (value === undefined) {
				throw new Error(`${arg} needs a value`);
			}
			return value;
		};
		if (arg === '--help' || arg === '-h') return {...options, help: true};
		else if (arg === '--version' || arg === '-v') return {...options, version: true};
		else if (arg === '--port' || arg === '-p') options.port = Number(next());
		else if (arg === '--host' || arg === '-H') options.host = next();
		else if (arg === '--dir' || arg === '-d') options.dir = resolve(next());
		else if (arg === '--config' || arg === '-c') options.config = resolve(next());
		else throw new Error(`unknown option: ${arg}`);
	}
	if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65535) {
		throw new Error(`--port must be a port number, got "${options.port}"`);
	}
	return options;
}

/**
 * Which spelling to tell the developer to use.
 *
 * Binding the loopback interface answers to `localhost` AND `127.0.0.1`, and those are the SAME
 * server at TWO origins. Printing the bind address would hand out `127.0.0.1` while the app almost
 * certainly says `localhost`, which is the exact confusion this artefact exists to stop, so the
 * banner names one spelling and says plainly that the other is a different origin.
 */
function displayHost(host) {
	return host === '127.0.0.1' || host === '::1' || host === '0.0.0.0' || host === '::' ? 'localhost' : host;
}

function banner(origin, options, version) {
	const config = options.config ? options.config : 'none (built-in defaults, which are enough to sign in)';
	const alias = displayHost(options.host) === 'localhost' ? `http://127.0.0.1:${options.port}` : undefined;
	return [
		``,
		`  etherplay dev wallet host ${version}  -  DEVELOPMENT ONLY, not for real accounts`,
		``,
		`    serving   ${origin}`,
		`    from      ${options.dir}`,
		`    config    ${config}`,
		``,
		`    point your app at EXACTLY this origin:  walletHost: '${origin}'`,
		...(alias
			? [
					`    the same server also answers at ${alias}, which is a DIFFERENT ORIGIN.`,
					`    pick one spelling and use it for the app and for walletHost, both: a`,
					`    mismatch completes the sign-in and delivers the result to nobody.`,
				]
			: [
					`    a different spelling of the same machine, or the wrong port, completes the`,
					`    sign-in and delivers the result to nobody.`,
				]),
		``,
	].join('\n');
}

let options;
try {
	options = parseArgs(process.argv.slice(2));
} catch (err) {
	console.error(`[dev-wallet-host] ${err.message}`);
	console.error(HELP);
	process.exit(1);
}

const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf-8'));

if (options.help) {
	console.log(HELP);
} else if (options.version) {
	console.log(manifest.version);
} else {
	try {
		await stat(join(options.dir, 'login', 'index.html'));
	} catch {
		console.error(
			`[dev-wallet-host] no sign-in host at ${options.dir}: expected ${join(options.dir, 'login', 'index.html')}.\n` +
				`If you are running this from a checkout, build it first: pnpm --filter @etherplay/dev-wallet-host build`,
		);
		process.exit(1);
	}

	if (options.config) {
		try {
			JSON.parse(await readFile(options.config, 'utf-8'));
		} catch (err) {
			// Said now rather than as a puzzling default at sign-in time.
			console.error(`[dev-wallet-host] ${options.config} is not readable JSON: ${err.message}`);
			process.exit(1);
		}
	}

	const server = createHost(options);
	server.on('error', (err) => {
		if (err.code === 'EADDRINUSE') {
			console.error(
				`[dev-wallet-host] port ${options.port} is already in use. Something else is on it; ` +
					`use --port to pick another rather than assuming it is a stale copy of this.`,
			);
		} else {
			console.error(`[dev-wallet-host] ${err.message}`);
		}
		process.exit(1);
	});

	server.listen(options.port, options.host, () => {
		options.port = server.address().port;
		console.log(banner(`http://${displayHost(options.host)}:${options.port}`, options, manifest.version));
	});

	for (const signal of ['SIGINT', 'SIGTERM']) {
		process.on(signal, () => {
			server.close(() => process.exit(0));
			// A dev script that will not die on ctrl-c is its own kind of annoying.
			setTimeout(() => process.exit(0), 500).unref();
		});
	}
}
