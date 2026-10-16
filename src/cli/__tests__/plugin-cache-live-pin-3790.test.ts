import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { chmod, cp, link, lstat, mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { describe, it } from "node:test";
import { once } from "node:events";
import {
	computeOmxPluginCacheClaimDigest,
	materializePackagedOmxPluginCache,
	omxPluginCacheBase,
	registerOmxPluginCacheLivePin,
	resolvePackagedOmxMarketplace,
	retireUnpinnedManagedSnapshots,
	setPluginCacheMutationHooksForTest,
} from "../plugin-marketplace.js";

const packageRoot = process.cwd();

async function withIsolatedUserHome<T>(
	wd: string,
	run: (codexHomeDir: string) => Promise<T>,
): Promise<T> {
	const previousHome = process.env.HOME;
	const previousCodexHome = process.env.CODEX_HOME;
	const homeDir = join(wd, "home");
	const codexHomeDir = join(homeDir, ".codex");
	await mkdir(codexHomeDir, { recursive: true });
	process.env.HOME = homeDir;
	process.env.CODEX_HOME = codexHomeDir;
	try {
		return await run(codexHomeDir);
	} finally {
		if (previousHome === undefined) delete process.env.HOME;
		else process.env.HOME = previousHome;
		if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
		else process.env.CODEX_HOME = previousCodexHome;
	}
}

async function seedManagedSnapshot(
	codexHomeDir: string,
	version: string,
): Promise<string> {
	const cacheDir = join(omxPluginCacheBase(codexHomeDir), version);
	await mkdir(dirname(cacheDir), { recursive: true });
	await cp(join(packageRoot, "plugins", "oh-my-codex"), cacheDir, {
		recursive: true,
	});
	const manifestPath = join(cacheDir, ".codex-plugin", "plugin.json");
	const manifest = JSON.parse(await readFile(manifestPath, "utf-8")) as Record<
		string,
		unknown
	>;
	manifest.version = version;
	await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
	await writeFile(
		join(cacheDir, "hooks", "omx-command.json"),
		`${JSON.stringify({
			command: process.execPath,
			argsPrefix: [join(packageRoot, "dist", "cli", "omx.js")],
		})}\n`,
	);
	await writeFile(join(cacheDir, ".omx-managed"), "managed\n");
	const claimDigest = await computeOmxPluginCacheClaimDigest(cacheDir);
	await writeFile(
		join(cacheDir, ".omx-complete"),
		`${JSON.stringify({ version, claimDigest })}\n`,
	);
	return cacheDir;
}

async function markAsPrePinManagedSnapshot(
	cacheDir: string,
	version: string,
	markerFormat: "legacy-record" | "legacy-pid",
): Promise<void> {
	const marker = markerFormat === "legacy-record"
		? `${JSON.stringify({ version: 1, cacheVersion: version, pid: process.pid, processStartHash: null })}\n`
		: `${process.pid}\n`;
	await writeFile(join(cacheDir, ".omx-managed"), marker);
	const claimDigest = await computeOmxPluginCacheClaimDigest(cacheDir);
	await writeFile(join(cacheDir, ".omx-complete"), `${JSON.stringify({ version, claimDigest })}\n`);
}

async function writeDeadLivePin(cacheDir: string): Promise<void> {
	const markerDir = join(cacheDir, ".omx-live-pin");
	await mkdir(markerDir, { recursive: true });
	const record = {
		version: 1,
		pid: 99_999_999,
		processStartHash: null,
		sessionHash: createHash("sha256").update("dead-session").digest("hex"),
	};
	await writeFile(join(markerDir, "dead.json"), `${JSON.stringify(record)}\n`);
}

function livePinMutationLockPath(codexHomeDir: string, version: string): string {
	const versionHash = createHash("sha256").update(version).digest("hex").slice(0, 24);
	return join(omxPluginCacheBase(codexHomeDir), `.omx-live-pin-${versionHash}.lock`);
}

function livePinIntentPath(codexHomeDir: string, version: string, sessionId: string): string {
	const versionHash = createHash("sha256").update(version).digest("hex").slice(0, 24);
	const sessionHash = createHash("sha256").update(sessionId).digest("hex");
	return join(omxPluginCacheBase(codexHomeDir), `.omx-live-pin-intent-${versionHash}-${sessionHash}.json`);
}

async function writeLivePinMutationLock(
	codexHomeDir: string,
	version: string,
	ownerPid: number,
	operation: "pin" | "retire",
	withStageLink = false,
): Promise<{ path: string; stagePath: string; content: string }> {
	const path = livePinMutationLockPath(codexHomeDir, version);
	const token = "11111111-1111-4111-8111-111111111111";
	const content = `${JSON.stringify({ version: 1, pid: ownerPid, operation, token })}\n`;
	const stagePath = `${path}.stage-${ownerPid}-${token}`;
	if (withStageLink) {
		await writeFile(stagePath, content);
		await link(stagePath, path);
	} else {
		await writeFile(path, content);
	}
	return { path, stagePath, content };
}

describe("issue 3790 live plugin cache pins", () => {
	it("writes a live pin from an uncorrelated SessionStart hook, not during publication", async () => {
		const wd = await mkdtemp(join(tmpdir(), "omx-3790-session-pin-"));
		try {
			await withIsolatedUserHome(wd, async (codexHomeDir) => {
				const packaged = await resolvePackagedOmxMarketplace(packageRoot);
				assert.ok(packaged);
				const materialized = await materializePackagedOmxPluginCache(
					codexHomeDir,
					packaged,
				);
				assert.equal(materialized.status, "materialized");
				const cacheDir = materialized.cacheDir!;
				const markerDir = join(cacheDir, ".omx-live-pin");
				const launcherPath = join(cacheDir, "hooks", "omx-command.json");
				const launcherContent = await readFile(launcherPath, "utf-8");
				await assert.rejects(lstat(markerDir), { code: "ENOENT" });

				const hookResult = spawnSync(
					process.execPath,
					[join(cacheDir, "hooks", "codex-native-hook.mjs")],
					{
						cwd: wd,
						input: JSON.stringify({
							hook_event_name: "SessionStart",
							session_id: "issue-3790-session",
							codex_pid: process.pid,
							cwd: wd,
						}),
						encoding: "utf-8",
						env: { ...process.env, CODEX_HOME: codexHomeDir },
					},
				);
				assert.equal(
					hookResult.status,
					0,
					hookResult.stderr || hookResult.stdout,
				);
				const markerStats = await lstat(markerDir);
				assert.equal(markerStats.isDirectory(), true);
				const entries = await readdir(markerDir);
				assert.equal(entries.length, 1);
				const pin = JSON.parse(
					await readFile(join(markerDir, entries[0]!), "utf-8"),
				) as {
					pid: number;
					sessionHash: string;
					processStartHash: string | null;
				};
				assert.equal(pin.pid, process.pid);
				assert.equal(
					pin.sessionHash,
					createHash("sha256").update("issue-3790-session").digest("hex"),
				);
				assert.ok(
					pin.processStartHash === null ||
						/^[0-9a-f]{24}$/.test(pin.processStartHash),
				);
				await assert.rejects(
					lstat(livePinIntentPath(codexHomeDir, materialized.version!, "issue-3790-session")),
					{ code: "ENOENT" },
				);
				const helperCalls = join(wd, "pin-helper-calls.txt");
				const fakeLauncher = join(wd, "fake-pin-launcher.mjs");
				await writeFile(
					fakeLauncher,
					`import { appendFileSync } from "node:fs";\nappendFileSync(process.env.OMX_PIN_HELPER_CALLS, "called\\n");\nprocess.stdout.write("{}\\n");\n`,
				);
				await writeFile(launcherPath, JSON.stringify({ command: process.execPath, argsPrefix: [fakeLauncher] }));
				const alreadyPinnedResult = spawnSync(
					process.execPath,
					[join(cacheDir, "hooks", "codex-native-hook.mjs")],
					{
						cwd: wd,
						input: JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: "issue-3790-session", codex_pid: process.pid, cwd: wd }),
						encoding: "utf-8",
						env: { ...process.env, CODEX_HOME: codexHomeDir, OMX_PIN_HELPER_CALLS: helperCalls },
					},
				);
				assert.equal(alreadyPinnedResult.status, 0, alreadyPinnedResult.stderr || alreadyPinnedResult.stdout);
				await assert.rejects(lstat(helperCalls), { code: "ENOENT" });
				await writeFile(launcherPath, launcherContent);
				await rm(join(markerDir, entries[0]!), { force: true });
				const retryResult = spawnSync(
					process.execPath,
					[join(cacheDir, "hooks", "codex-native-hook.mjs")],
					{
						cwd: wd,
						input: JSON.stringify({
							hook_event_name: "UserPromptSubmit",
							session_id: "issue-3790-session",
							codex_pid: process.pid,
							cwd: wd,
						}),
						encoding: "utf-8",
						env: { ...process.env, CODEX_HOME: codexHomeDir },
					},
				);
				assert.equal(retryResult.status, 0, retryResult.stderr || retryResult.stdout);
				assert.equal((await readdir(markerDir)).length, 1);
			});
		} finally {
			await rm(wd, { recursive: true, force: true });
		}
	});

	it("publishes post-pin hooks under a new cache version and retains every pre-pin snapshot", async () => {
		const wd = await mkdtemp(join(tmpdir(), "omx-3790-legacy-snapshot-upgrade-"));
		try {
			await withIsolatedUserHome(wd, async (codexHomeDir) => {
				const legacySnapshots = await Promise.all(
					["0.21.13", "0.21.14"].map((version) => seedManagedSnapshot(codexHomeDir, version)),
				);
				await Promise.all(
					legacySnapshots.map((snapshot, index) => markAsPrePinManagedSnapshot(
						snapshot,
						["0.21.13", "0.21.14"][index]!,
						index === 0 ? "legacy-record" : "legacy-pid",
					)),
				);
				const packaged = await resolvePackagedOmxMarketplace(packageRoot);
				assert.ok(packaged);
				const pluginManifest = JSON.parse(await readFile(packaged.pluginManifestPath, "utf-8")) as { version: string };
				assert.equal(pluginManifest.version, "0.21.15");

				const published = await materializePackagedOmxPluginCache(codexHomeDir, packaged);
				assert.equal(published.status, "materialized");
				assert.ok(legacySnapshots.every((snapshot) => published.cacheDir !== snapshot));
				await lstat(published.cacheDir!);
				await Promise.all(legacySnapshots.map((snapshot) => lstat(snapshot)));
			});
		} finally {
			await rm(wd, { recursive: true, force: true });
		}
	});

	it("uses the configured launcher to pin an unrouted session when the cache launcher is invalid", async () => {
		const wd = await mkdtemp(join(tmpdir(), "omx-3790-configured-pin-launcher-"));
		try {
			await withIsolatedUserHome(wd, async (codexHomeDir) => {
				const packaged = await resolvePackagedOmxMarketplace(packageRoot);
				assert.ok(packaged);
				const published = await materializePackagedOmxPluginCache(codexHomeDir, packaged);
				assert.equal(published.status, "materialized");
				const cacheDir = published.cacheDir!;
				await writeFile(join(cacheDir, "hooks", "omx-command.json"), "invalid launcher\n");

				const cliPath = join(packageRoot, "dist", "cli", "omx.js");
				const overrideName = "omx-hook-override";
				if (process.platform === "win32") {
					await writeFile(
						join(wd, `${overrideName}.cmd`),
						`@echo off\r\n"${process.execPath}" "${cliPath}" %*\r\n`,
					);
				} else {
					const overridePath = join(wd, overrideName);
					await writeFile(
						overridePath,
						`#!/usr/bin/env node\nimport { spawnSync } from "node:child_process";\nimport { readFileSync } from "node:fs";\nconst result = spawnSync(${JSON.stringify(process.execPath)}, [${JSON.stringify(cliPath)}, ...process.argv.slice(2)], { input: readFileSync(0), stdio: ["pipe", "inherit", "inherit"], env: process.env });\nprocess.exitCode = result.status ?? 1;\n`,
					);
					await chmod(overridePath, 0o755);
				}

				const sessionId = "configured-launcher-session";
				const hookResult = spawnSync(
					process.execPath,
					[join(cacheDir, "hooks", "codex-native-hook.mjs")],
					{
						cwd: wd,
						input: JSON.stringify({
							hook_event_name: "SessionStart",
							session_id: sessionId,
							codex_pid: process.pid,
							cwd: wd,
						}),
						encoding: "utf-8",
						env: {
							...process.env,
							CODEX_HOME: codexHomeDir,
							OMX_NATIVE_HOOK_COMMAND: overrideName,
							PATH: `${wd}${delimiter}${process.env.PATH ?? ""}`,
						},
					},
				);
				assert.equal(hookResult.status, 0, hookResult.stderr || hookResult.stdout);
				const markerDir = join(cacheDir, ".omx-live-pin");
				const entries = await readdir(markerDir);
				assert.equal(entries.length, 1);
				const pin = JSON.parse(await readFile(join(markerDir, entries[0]!), "utf-8")) as {
					pid: number;
					sessionHash: string;
				};
				assert.equal(pin.pid, process.pid);
				assert.equal(pin.sessionHash, createHash("sha256").update(sessionId).digest("hex"));
			});
		} finally {
			await rm(wd, { recursive: true, force: true });
		}
	});

	it("returns a no-op when an unrouted pin helper hangs", async () => {
		const wd = await mkdtemp(join(tmpdir(), "omx-3790-pin-helper-timeout-"));
		try {
			await withIsolatedUserHome(wd, async (codexHomeDir) => {
				const packaged = await resolvePackagedOmxMarketplace(packageRoot);
				assert.ok(packaged);
				const materialized = await materializePackagedOmxPluginCache(codexHomeDir, packaged);
				assert.equal(materialized.status, "materialized");
				const cacheDir = materialized.cacheDir!;
				const launcherPath = join(cacheDir, "hooks", "omx-command.json");
				const helperPath = join(wd, "hanging-pin-helper.mjs");
				await writeFile(
					helperPath,
					`
const parentPid = process.ppid;
process.on("SIGTERM", () => {});
setInterval(() => {
	try { process.kill(parentPid, 0); } catch { process.exit(0); }
}, 50);
setInterval(() => {}, 60_000);
`,
				);
				await writeFile(launcherPath, JSON.stringify({ command: process.execPath, argsPrefix: [helperPath] }));

				const hookResult = spawnSync(process.execPath, [join(cacheDir, "hooks", "codex-native-hook.mjs")], {
					cwd: wd,
					input: JSON.stringify({
						hook_event_name: "SessionStart",
						session_id: "hung-pin-helper-session",
						codex_pid: process.pid,
						cwd: wd,
					}),
					encoding: "utf-8",
					timeout: 12_000,
					env: { ...process.env, CODEX_HOME: codexHomeDir },
				});
				assert.equal(hookResult.status, 0, hookResult.stderr || hookResult.stdout);
				assert.equal(hookResult.stdout, "");
				assert.match(hookResult.stderr, /live plugin cache pin helper timed out/);
				const sessionHash = createHash("sha256").update("hung-pin-helper-session").digest("hex");
				assert.deepEqual(
					JSON.parse(await readFile(livePinIntentPath(codexHomeDir, materialized.version!, "hung-pin-helper-session"), "utf-8")),
					{ version: 1, cacheVersion: materialized.version, sessionHash },
				);
			});
		} finally {
			await rm(wd, { recursive: true, force: true });
		}
	});

	it("pins a running hook wrapper before it waits for stdin", async () => {
		const wd = await mkdtemp(join(tmpdir(), "omx-3790-startup-pin-"));
		try {
			await withIsolatedUserHome(wd, async (codexHomeDir) => {
				const snapshots = await Promise.all(
					["0.19.0", "0.20.0", "0.20.1"].map((version) => seedManagedSnapshot(codexHomeDir, version)),
				);
				const pluginRoot = snapshots[1]!;
				const pinDirectory = join(pluginRoot, ".omx-live-pin");
				const expiredAt = new Date(Date.now() - 60 * 60 * 1000);
				await utimes(pluginRoot, expiredAt, expiredAt);
				const hook = spawn(
					process.execPath,
					[join(pluginRoot, "hooks", "codex-native-hook.mjs")],
					{
						cwd: wd,
						stdio: ["pipe", "pipe", "pipe"],
						env: { ...process.env, CODEX_HOME: codexHomeDir },
					},
				);
				hook.stdout.resume();
				let hookStderr = "";
				hook.stderr.setEncoding("utf-8");
				hook.stderr.on("data", (chunk: string) => { hookStderr += chunk; });
				const closed = once(hook, "close");
				try {
					let pendingEntries: string[] = [];
					for (let attempt = 0; attempt < 100; attempt += 1) {
						try {
							pendingEntries = await readdir(pinDirectory);
							if (pendingEntries.length > 0) break;
						} catch {
						// The launcher may not have created its startup guard yet.
						}
						await new Promise((resolveWait) => setTimeout(resolveWait, 10));
					}
					assert.equal(pendingEntries.length, 1, "startup pin must exist while the wrapper waits for stdin");
					const pending = JSON.parse(await readFile(join(pinDirectory, pendingEntries[0]!), "utf-8")) as { pid: number };
					assert.equal(pending.pid, hook.pid);

					const retired = await retireUnpinnedManagedSnapshots(codexHomeDir, "0.20.2");
					assert.equal(retired.includes(pluginRoot), false);
					assert.equal(retired.includes(snapshots[0]!), true);
					await lstat(pluginRoot);
					await lstat(snapshots[2]!);
					await assert.rejects(lstat(snapshots[0]!), { code: "ENOENT" });

					hook.stdin.end(JSON.stringify({
						hook_event_name: "SessionStart",
						session_id: "startup-pin-session",
						codex_pid: process.pid,
						cwd: wd,
					}));
					const [code] = await closed as [number | null];
					assert.equal(code, 0, hookStderr);
					assert.equal((await readdir(pinDirectory)).length, 1);
				} finally {
					if (hook.exitCode === null) {
						hook.kill();
						await closed;
					}
				}
			});
		} finally {
			await rm(wd, { recursive: true, force: true });
		}
	});

	it("publishes a renewable startup intent before waiting for hook input", async () => {
		const wd = await mkdtemp(join(tmpdir(), "omx-3790-startup-intent-"));
		try {
			await withIsolatedUserHome(wd, async (codexHomeDir) => {
				const snapshots = await Promise.all(
					["0.20.0", "0.20.1", "0.20.2"].map((version) => seedManagedSnapshot(codexHomeDir, version)),
				);
				const pluginRoot = snapshots[0]!;
				const cacheBase = omxPluginCacheBase(codexHomeDir);
				const versionHash = createHash("sha256").update("0.20.0").digest("hex").slice(0, 24);
				const intentPrefix = `.omx-live-pin-intent-${versionHash}-`;
				const mutationLock = await writeLivePinMutationLock(codexHomeDir, "0.20.0", process.pid, "retire");
				const helperPath = join(wd, "codex-native-hook");
				await writeFile(helperPath, "process.stdin.resume();\nprocess.stdin.on('end', () => process.exit(0));\n");
				const hook = spawn(
					process.execPath,
					[join(pluginRoot, "hooks", "codex-native-hook.mjs")],
					{
						cwd: wd,
						stdio: ["pipe", "pipe", "pipe"],
						env: {
							...process.env,
							CODEX_HOME: codexHomeDir,
							OMX_NATIVE_HOOK_COMMAND: process.execPath,
						},
					},
				);
				hook.stdout.resume();
				let hookStderr = "";
				hook.stderr.setEncoding("utf-8");
				hook.stderr.on("data", (chunk: string) => { hookStderr += chunk; });
				const closed = once(hook, "close");
				try {
					let startupIntents: string[] = [];
					for (let attempt = 0; attempt < 100; attempt += 1) {
						startupIntents = (await readdir(cacheBase)).filter((name) => name.startsWith(intentPrefix));
						if (startupIntents.length > 0) break;
						await new Promise((resolveWait) => setTimeout(resolveWait, 10));
					}
					assert.equal(startupIntents.length, 1, "startup intent must exist before the wrapper reads stdin");
					const startupIntentPath = join(cacheBase, startupIntents[0]!);
					const startupIntent = JSON.parse(await readFile(startupIntentPath, "utf-8")) as {
						version: number;
						cacheVersion: string;
						sessionHash: string;
					};
					assert.deepEqual(
						{ version: startupIntent.version, cacheVersion: startupIntent.cacheVersion },
						{ version: 1, cacheVersion: "0.20.0" },
					);
					assert.match(startupIntent.sessionHash, /^[0-9a-f]{64}$/);

					await rm(mutationLock.path);
					const retired = await retireUnpinnedManagedSnapshots(codexHomeDir, "0.20.3");
					assert.equal(retired.includes(pluginRoot), false);
					assert.equal(retired.includes(snapshots[1]!), true);
					await lstat(pluginRoot);
					await assert.rejects(lstat(snapshots[1]!), { code: "ENOENT" });

					hook.stdin.end(JSON.stringify({
						hook_event_name: "SessionStart",
						session_id: "startup-intent-session",
						codex_pid: process.pid,
						cwd: wd,
					}));
					const [code] = await closed as [number | null];
					assert.equal(code, 0, hookStderr);
					await assert.rejects(lstat(startupIntentPath), { code: "ENOENT" });
				} finally {
					await rm(mutationLock.path, { force: true });
					if (hook.exitCode === null) {
						hook.kill();
						await closed;
					}
				}
			});
		} finally {
			await rm(wd, { recursive: true, force: true });
		}
	});

	it("does not publish a startup pin after the snapshot is quarantined", {
		skip: process.platform !== "linux",
	}, async () => {
		const wd = await mkdtemp(join(tmpdir(), "omx-3790-quarantine-pin-race-"));
		try {
			await withIsolatedUserHome(wd, async (codexHomeDir) => {
				const pluginRoot = await seedManagedSnapshot(codexHomeDir, "0.20.0");
				const quarantinePath = join(wd, "quarantined-snapshot");
				const preloadPath = join(wd, "rename-before-pin-write.mjs");
				await writeFile(preloadPath, `
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
const originalWriteFileSync = fs.writeFileSync;
let renamed = false;
fs.writeFileSync = function (path, ...args) {
	if (!renamed && typeof path === "string" && path.includes("/.omx-live-pin/.stage-")) {
		fs.renameSync(process.env.OMX_TEST_PLUGIN_ROOT, process.env.OMX_TEST_QUARANTINE);
		renamed = true;
	}
	return originalWriteFileSync.call(this, path, ...args);
};
syncBuiltinESMExports();
`);
				const hookResult = spawnSync(
					process.execPath,
					[
						"--import",
						preloadPath,
						join(pluginRoot, "hooks", "codex-native-hook.mjs"),
					],
					{
						cwd: wd,
						input: JSON.stringify({
							hook_event_name: "SessionStart",
							session_id: "quarantine-race-session",
							codex_pid: process.pid,
							cwd: wd,
						}),
						encoding: "utf-8",
						env: {
							...process.env,
							CODEX_HOME: codexHomeDir,
							OMX_TEST_PLUGIN_ROOT: pluginRoot,
							OMX_TEST_QUARANTINE: quarantinePath,
						},
					},
				);
				assert.equal(hookResult.status, 0, hookResult.stderr || hookResult.stdout);
				await assert.rejects(lstat(pluginRoot), { code: "ENOENT" });
				assert.deepEqual(await readdir(join(quarantinePath, ".omx-live-pin")), []);
			});
		} finally {
			await rm(wd, { recursive: true, force: true });
		}
	});

	it("keeps a session intent visible when snapshot rename races its publication", async () => {
		const wd = await mkdtemp(join(tmpdir(), "omx-3790-intent-rename-race-"));
		try {
			await withIsolatedUserHome(wd, async (codexHomeDir) => {
				const snapshots = await Promise.all(
					["0.20.0", "0.20.1", "0.20.2"].map((version) => seedManagedSnapshot(codexHomeDir, version)),
				);
				const pluginRoot = snapshots[0]!;
				const quarantinePath = join(wd, "snapshot-during-intent-publication");
				const raceMarkerPath = join(wd, "intent-publication-raced-rename");
				const helperPath = join(wd, "codex-native-hook");
				const preloadPath = join(wd, "rename-during-intent-link.mjs");
				const sessionId = "snapshot-rename-race-session";
				const mutationLock = await writeLivePinMutationLock(
					codexHomeDir,
					"0.20.0",
					process.pid,
					"pin",
				);
				await writeFile(helperPath, "process.stdin.resume();\nprocess.stdin.on('end', () => process.exit(0));\n");
				await writeFile(preloadPath, `
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
const originalLinkSync = fs.linkSync;
const originalRenameSync = fs.renameSync;
const originalWriteFileSync = fs.writeFileSync;
let raced = false;
fs.linkSync = function (source, destination, ...args) {
	if (!raced && typeof destination === "string" && destination.includes(".omx-live-pin-intent-")) {
		originalRenameSync.call(this, process.env.OMX_TEST_PLUGIN_ROOT, process.env.OMX_TEST_QUARANTINE);
		try {
			const result = originalLinkSync.call(this, source, destination, ...args);
			raced = true;
			originalWriteFileSync.call(this, process.env.OMX_TEST_RACE_MARKER, "renamed during publication\\n");
			return result;
		} finally {
			originalRenameSync.call(this, process.env.OMX_TEST_QUARANTINE, process.env.OMX_TEST_PLUGIN_ROOT);
		}
	}
	return originalLinkSync.call(this, source, destination, ...args);
};
syncBuiltinESMExports();
`);
				const hookResult = spawnSync(
					process.execPath,
					["--import", preloadPath, join(pluginRoot, "hooks", "codex-native-hook.mjs")],
					{
						cwd: wd,
						input: JSON.stringify({
							hook_event_name: "SessionStart",
							session_id: sessionId,
							codex_pid: process.pid,
							cwd: wd,
						}),
						encoding: "utf-8",
						timeout: 15_000,
						env: {
							...process.env,
							CODEX_HOME: codexHomeDir,
							OMX_NATIVE_HOOK_COMMAND: process.execPath,
							OMX_TEST_PLUGIN_ROOT: pluginRoot,
							OMX_TEST_QUARANTINE: quarantinePath,
							OMX_TEST_RACE_MARKER: raceMarkerPath,
						},
					},
				);
				assert.equal(hookResult.status, 0, hookResult.stderr || hookResult.stdout);
				await lstat(raceMarkerPath);
				await lstat(pluginRoot);
				await lstat(livePinIntentPath(codexHomeDir, "0.20.0", sessionId));

				await rm(mutationLock.path);
				const retired = await retireUnpinnedManagedSnapshots(codexHomeDir, "0.20.3");
				assert.equal(retired.includes(pluginRoot), false);
				assert.equal(retired.includes(snapshots[1]!), true);
				await lstat(pluginRoot);
				await lstat(snapshots[2]!);
				await assert.rejects(lstat(snapshots[1]!), { code: "ENOENT" });
			});
		} finally {
			await rm(wd, { recursive: true, force: true });
		}
	});

	it("serializes startup pin publication with quarantine deletion", {
		skip: process.platform !== "linux",
	}, async () => {
		const wd = await mkdtemp(join(tmpdir(), "omx-3790-retirement-gate-race-"));
		try {
			await withIsolatedUserHome(wd, async (codexHomeDir) => {
				const snapshots = await Promise.all(
					["0.20.0", "0.20.1", "0.20.2"].map((version) => seedManagedSnapshot(codexHomeDir, version)),
				);
				const pluginRoot = snapshots[0]!;
				const pinDirectory = join(pluginRoot, ".omx-live-pin");
				await mkdir(pinDirectory);
				const expiredAt = new Date(Date.now() - 6 * 60 * 1000);
				await utimes(pinDirectory, expiredAt, expiredAt);

				const mutationLockPath = join(
					omxPluginCacheBase(codexHomeDir),
					`.omx-live-pin-${createHash("sha256").update("0.20.0").digest("hex").slice(0, 24)}.lock`,
				);

				const readyPath = join(wd, "pin-writer-ready");
				const releasePath = join(wd, "pin-writer-release");
				const preloadPath = join(wd, "pause-before-pin-write.mjs");
				await writeFile(
					preloadPath,
					`
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
const originalWriteFileSync = fs.writeFileSync;
let paused = false;
fs.writeFileSync = function (path, ...args) {
	if (!paused && typeof path === "string" && path.includes("/.omx-live-pin/.stage-")) {
		paused = true;
		originalWriteFileSync.call(this, process.env.OMX_TEST_PIN_READY, "ready\\n");
		const wait = new Int32Array(new SharedArrayBuffer(4));
		while (!fs.existsSync(process.env.OMX_TEST_PIN_RELEASE)) Atomics.wait(wait, 0, 0, 10);
	}
	return originalWriteFileSync.call(this, path, ...args);
};
syncBuiltinESMExports();
`,
				);
				const hook = spawn(
					process.execPath,
					["--import", preloadPath, join(pluginRoot, "hooks", "codex-native-hook.mjs")],
					{
						cwd: wd,
						stdio: ["pipe", "pipe", "pipe"],
						env: {
							...process.env,
							CODEX_HOME: codexHomeDir,
							OMX_TEST_PIN_READY: readyPath,
							OMX_TEST_PIN_RELEASE: releasePath,
						},
					},
				);
				hook.stdout.resume();
				let hookStderr = "";
				hook.stderr.setEncoding("utf-8");
				hook.stderr.on("data", (chunk: string) => {
					hookStderr += chunk;
				});
				const closed = once(hook, "close");
				let retirement: Promise<string[]> | undefined;
				try {
					hook.stdin.end(
						JSON.stringify({
							hook_event_name: "SessionStart",
							session_id: "retirement-gate-session",
							codex_pid: process.pid,
							cwd: wd,
						}),
					);
					let writerPaused = false;
					for (let attempt = 0; attempt < 500; attempt += 1) {
						try {
							await lstat(readyPath);
							writerPaused = true;
							break;
						} catch {
							await new Promise((resolveWait) => setTimeout(resolveWait, 10));
						}
					}
					assert.equal(writerPaused, true, hookStderr || "pin writer did not reach the interposed stage write");

					retirement = retireUnpinnedManagedSnapshots(codexHomeDir, "0.20.3");
					const retiredWhileWriterPaused = await retirement;
					assert.equal(retiredWhileWriterPaused.includes(pluginRoot), false);
					assert.equal(retiredWhileWriterPaused.includes(snapshots[1]!), true);
					await lstat(pluginRoot);
					const mutationLock = JSON.parse(await readFile(mutationLockPath, "utf-8")) as { operation: string };
					assert.equal(mutationLock.operation, "pin");
					await writeFile(releasePath, "release\n");
					let closeTimeout: NodeJS.Timeout | undefined;
					let closeResult: unknown[];
					try {
						closeResult = await Promise.race([
							closed,
							new Promise<never>((_resolve, reject) => {
								closeTimeout = setTimeout(
									() => reject(new Error("startup hook did not finish after releasing the pin writer")),
									5000,
								);
							}),
						]);
					} finally {
						if (closeTimeout) clearTimeout(closeTimeout);
					}
					const [hookCode] = closeResult as [number | null];
					assert.equal(hookCode, 0, hookStderr);
					const pinRecords = await Promise.all(
						(await readdir(pinDirectory)).map(
							async (name) => JSON.parse(await readFile(join(pinDirectory, name), "utf-8")) as { sessionHash: string },
						),
					);
					assert.deepEqual(
						pinRecords.map((record) => record.sessionHash),
						[createHash("sha256").update("retirement-gate-session").digest("hex")],
					);
					const retiredAfterPin = await retireUnpinnedManagedSnapshots(codexHomeDir, "0.20.3");
					assert.equal(retiredAfterPin.includes(pluginRoot), false);
					await lstat(pluginRoot);
					await assert.rejects(lstat(snapshots[1]!), { code: "ENOENT" });
				} finally {
					await writeFile(releasePath, "release\n").catch(() => undefined);
					if (hook.exitCode === null) hook.kill();
					await closed.catch(() => undefined);
					await retirement?.catch(() => undefined);
				}
			});
		} finally {
			await rm(wd, { recursive: true, force: true });
		}
	});

	it("registers a live pin before concurrent publication retires an older snapshot", async () => {
		const wd = await mkdtemp(join(tmpdir(), "omx-3790-pin-lock-retry-"));
		try {
			await withIsolatedUserHome(wd, async (codexHomeDir) => {
				const oldSnapshot = await seedManagedSnapshot(codexHomeDir, "0.20.0");
				const olderSnapshots = await Promise.all(
					["0.20.1", "0.20.2"].map((version) => seedManagedSnapshot(codexHomeDir, version)),
				);
				const packaged = await resolvePackagedOmxMarketplace(packageRoot);
				assert.ok(packaged);
				let signalPrepared!: () => void;
				let releasePublication!: () => void;
				const prepared = new Promise<void>((resolvePrepared) => { signalPrepared = resolvePrepared; });
				const publicationGate = new Promise<void>((resolvePublication) => { releasePublication = resolvePublication; });
				const publication = materializePackagedOmxPluginCache(codexHomeDir, packaged, {
					onCacheDirPrepared: async () => {
						signalPrepared();
						await publicationGate;
					},
				});
				try {
					await prepared;
					assert.equal(await registerOmxPluginCacheLivePin(
						oldSnapshot,
						"lock-contention-session",
						process.pid,
					), true);
					releasePublication();
					const published = await publication;
					assert.equal(published.status, "materialized");
					assert.equal(published.retiredDirs?.includes(olderSnapshots[0]!), true);
					assert.equal(published.retiredDirs?.includes(oldSnapshot), false);
					await lstat(oldSnapshot);
					await assert.rejects(lstat(olderSnapshots[0]!), { code: "ENOENT" });
				} finally {
					releasePublication();
				}
			});
		} finally {
			await rm(wd, { recursive: true, force: true });
		}
	});

	it("preserves a snapshot while its live-pin directory is being initialized", async () => {
		const wd = await mkdtemp(join(tmpdir(), "omx-3790-pin-directory-race-"));
		try {
			await withIsolatedUserHome(wd, async (codexHomeDir) => {
				const snapshots = await Promise.all(
					["0.20.0", "0.20.1", "0.20.2"].map((version) => seedManagedSnapshot(codexHomeDir, version)),
				);
				const pinDirectory = join(snapshots[0]!, ".omx-live-pin");
				await mkdir(pinDirectory);

				const retired = await retireUnpinnedManagedSnapshots(codexHomeDir, "0.20.3");

				assert.equal(retired.includes(snapshots[0]!), false);
				assert.equal(retired.includes(snapshots[1]!), true);
				await lstat(snapshots[0]!);
				assert.deepEqual(await readdir(pinDirectory), []);
				await assert.rejects(lstat(snapshots[1]!), { code: "ENOENT" });
			});
		} finally {
			await rm(wd, { recursive: true, force: true });
		}
	});

	it("reclaims an abandoned empty live-pin directory after its initialization lease", async () => {
		const wd = await mkdtemp(join(tmpdir(), "omx-3790-expired-empty-pin-"));
		try {
			await withIsolatedUserHome(wd, async (codexHomeDir) => {
				const snapshots = await Promise.all(
					["0.20.0", "0.20.1", "0.20.2"].map((version) => seedManagedSnapshot(codexHomeDir, version)),
				);
				const pinDirectory = join(snapshots[0]!, ".omx-live-pin");
				await mkdir(pinDirectory);
				const expiredAt = new Date(Date.now() - 6 * 60 * 1000);
				await utimes(pinDirectory, expiredAt, expiredAt);

				const retired = await retireUnpinnedManagedSnapshots(codexHomeDir, "0.20.3");

				assert.equal(retired.includes(snapshots[0]!), true);
				await assert.rejects(lstat(snapshots[0]!), { code: "ENOENT" });
			});
		} finally {
			await rm(wd, { recursive: true, force: true });
		}
	});

	it("does not steal an aged mutation lock from a live owner", async () => {
		const wd = await mkdtemp(join(tmpdir(), "omx-3790-live-mutation-lock-"));
		try {
			await withIsolatedUserHome(wd, async (codexHomeDir) => {
				const snapshots = await Promise.all(
					["0.20.0", "0.20.1", "0.20.2"].map((version) => seedManagedSnapshot(codexHomeDir, version)),
				);
				const lock = await writeLivePinMutationLock(codexHomeDir, "0.20.0", process.pid, "pin");
				const expiredAt = new Date(Date.now() - 6 * 60 * 1000);
				await utimes(lock.path, expiredAt, expiredAt);

				const retired = await retireUnpinnedManagedSnapshots(codexHomeDir, "0.20.3");

				assert.equal(retired.includes(snapshots[0]!), false);
				assert.equal(retired.includes(snapshots[1]!), true);
				await lstat(snapshots[0]!);
				assert.equal(await readFile(lock.path, "utf-8"), lock.content);
			});
		} finally {
			await rm(wd, { recursive: true, force: true });
		}
	});

	it("leaves an expired pending marker intact until lock-owning retirement", async () => {
		const wd = await mkdtemp(join(tmpdir(), "omx-3790-expired-pending-marker-"));
		try {
			await withIsolatedUserHome(wd, async (codexHomeDir) => {
				const snapshots = await Promise.all(
					["0.20.0", "0.20.1", "0.20.2"].map((version) => seedManagedSnapshot(codexHomeDir, version)),
				);
				const sessionHash = createHash("sha256").update("expired-pending-session").digest("hex");
				const pinDirectory = join(snapshots[0]!, ".omx-live-pin");
				await mkdir(pinDirectory);
				const pendingPath = join(pinDirectory, `.pending-${sessionHash}.json`);
				await writeFile(pendingPath, `${JSON.stringify({ version: 1, sessionHash })}\n`);
				const expiredAt = new Date(Date.now() - 6 * 60 * 1000);
				await utimes(pendingPath, expiredAt, expiredAt);
				let observedBeforeDestruction = false;
				const resetHooks = setPluginCacheMutationHooksForTest({
					beforeRemove: async (quarantinePath) => {
						if (!quarantinePath.includes(".0.20.0.reclaim-")) return;
						await lstat(join(quarantinePath, ".omx-live-pin", `.pending-${sessionHash}.json`));
						observedBeforeDestruction = true;
					},
				});
				try {
					const retired = await retireUnpinnedManagedSnapshots(codexHomeDir, "0.20.3");
					assert.equal(observedBeforeDestruction, true);
					assert.equal(retired.includes(snapshots[0]!), true);
					await assert.rejects(lstat(snapshots[0]!), { code: "ENOENT" });
				} finally {
					resetHooks();
				}
			});
		} finally {
			await rm(wd, { recursive: true, force: true });
		}
	});

	it("recovers a dead-owner lock left between publication and stage cleanup", {
		skip: process.platform !== "linux",
	}, async () => {
		const wd = await mkdtemp(join(tmpdir(), "omx-3790-dead-mutation-lock-"));
		try {
			await withIsolatedUserHome(wd, async (codexHomeDir) => {
				const snapshots = await Promise.all(
					["0.20.0", "0.20.1", "0.20.2"].map((version) => seedManagedSnapshot(codexHomeDir, version)),
				);
				const lock = await writeLivePinMutationLock(codexHomeDir, "0.20.0", 2_147_483_647, "pin", true);

				assert.equal(
					await registerOmxPluginCacheLivePin(snapshots[0]!, "dead-lock-recovery-session", process.pid),
					true,
				);

				await assert.rejects(lstat(lock.path), { code: "ENOENT" });
				await assert.rejects(lstat(lock.stagePath), { code: "ENOENT" });
				const pinDirectory = join(snapshots[0]!, ".omx-live-pin");
				const sessionHash = createHash("sha256").update("dead-lock-recovery-session").digest("hex");
				const records = await Promise.all(
					(await readdir(pinDirectory)).map(
						async (name) => JSON.parse(await readFile(join(pinDirectory, name), "utf-8")) as { sessionHash: string },
					),
				);
				assert.ok(records.some((record) => record.sessionHash === sessionHash));
			});
		} finally {
			await rm(wd, { recursive: true, force: true });
		}
	});

	it("keeps a session pending pin when a live retirement lock blocks startup pinning", async () => {
		const wd = await mkdtemp(join(tmpdir(), "omx-3790-retirement-lock-wins-"));
		try {
			await withIsolatedUserHome(wd, async (codexHomeDir) => {
				const snapshots = await Promise.all(
					["0.20.0", "0.20.1", "0.20.2"].map((version) => seedManagedSnapshot(codexHomeDir, version)),
				);
				const pluginRoot = snapshots[0]!;
				const lock = await writeLivePinMutationLock(codexHomeDir, "0.20.0", process.pid, "retire");
				const expiredAt = new Date(Date.now() - 6 * 60 * 1000);
				await utimes(lock.path, expiredAt, expiredAt);
				const preloadPath = join(wd, "assert-no-unlocked-snapshot-read.mjs");
				const violationPath = join(wd, "launcher-read-while-retiring");
				await writeFile(
					preloadPath,
					`
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
const root = process.env.OMX_TEST_SNAPSHOT_ROOT;
const originalLstatSync = fs.lstatSync;
const originalReadFileSync = fs.readFileSync;
const originalWriteFileSync = fs.writeFileSync;
function checkSnapshotPath(path) {
	if (typeof path !== "string" || !path.startsWith(root) || !path.endsWith("/hooks/omx-command.json")) return;
	try { originalWriteFileSync.call(fs, process.env.OMX_TEST_VIOLATION_PATH, path); } catch {}
}
fs.lstatSync = function (path, ...args) { checkSnapshotPath(path); return originalLstatSync.call(this, path, ...args); };
fs.readFileSync = function (path, ...args) { checkSnapshotPath(path); return originalReadFileSync.call(this, path, ...args); };
syncBuiltinESMExports();
`,
				);

				const hookResult = spawnSync(
					process.execPath,
					["--import", preloadPath, join(pluginRoot, "hooks", "codex-native-hook.mjs")],
					{
						cwd: wd,
						input: JSON.stringify({
							hook_event_name: "SessionStart",
							session_id: "retirement-lock-session",
							cwd: wd,
						}),
						encoding: "utf-8",
						env: {
							...process.env,
							CODEX_HOME: codexHomeDir,
							OMX_TEST_SNAPSHOT_ROOT: pluginRoot,
							OMX_TEST_VIOLATION_PATH: violationPath,
						},
					},
				);

				assert.equal(hookResult.status, 0, hookResult.stderr || hookResult.stdout);
				await assert.rejects(lstat(violationPath), { code: "ENOENT" });
				assert.equal(await readFile(lock.path, "utf-8"), lock.content);
				const sessionHash = createHash("sha256").update("retirement-lock-session").digest("hex");
				const pendingPath = livePinIntentPath(codexHomeDir, "0.20.0", "retirement-lock-session");
				assert.deepEqual(JSON.parse(await readFile(pendingPath, "utf-8")), {
					version: 1,
					cacheVersion: "0.20.0",
					sessionHash,
				});
				await rm(lock.path);
				const retired = await retireUnpinnedManagedSnapshots(codexHomeDir, "0.20.3");
				assert.equal(retired.includes(pluginRoot), false);
				assert.equal(retired.includes(snapshots[1]!), true);
				await lstat(pluginRoot);
				await assert.rejects(lstat(snapshots[1]!), { code: "ENOENT" });
			});
		} finally {
			await rm(wd, { recursive: true, force: true });
		}
	});

	it("does not create live pins for doctor hook smoke runs", async () => {
		const wd = await mkdtemp(join(tmpdir(), "omx-3790-doctor-smoke-pin-"));
		try {
			await withIsolatedUserHome(wd, async (codexHomeDir) => {
				const pluginRoot = await seedManagedSnapshot(codexHomeDir, "0.20.0");
				const hookResult = spawnSync(process.execPath, [join(pluginRoot, "hooks", "codex-native-hook.mjs")], {
					cwd: wd,
					input: JSON.stringify({
						hook_event_name: "UserPromptSubmit",
						session_id: "omx-doctor-plugin-hook-smoke",
						cwd: wd,
					}),
					encoding: "utf-8",
					env: {
						...process.env,
						CODEX_HOME: codexHomeDir,
						OMX_NATIVE_HOOK_DOCTOR_SMOKE: "1",
					},
				});

				assert.equal(hookResult.status, 0, hookResult.stderr || hookResult.stdout);
				await assert.rejects(lstat(join(pluginRoot, ".omx-live-pin")), { code: "ENOENT" });
				await assert.rejects(
					lstat(livePinIntentPath(codexHomeDir, "0.20.0", "omx-doctor-plugin-hook-smoke")),
					{ code: "ENOENT" },
				);
			});
		} finally {
			await rm(wd, { recursive: true, force: true });
		}
	});

	it("recovers a dead sidecar lock before the wrapper opens its snapshot", {
		skip: process.platform !== "linux",
	}, async () => {
		const wd = await mkdtemp(join(tmpdir(), "omx-3790-wrapper-dead-lock-"));
		try {
			await withIsolatedUserHome(wd, async (codexHomeDir) => {
				const snapshots = await Promise.all(
					["0.20.0", "0.20.1", "0.20.2"].map((version) => seedManagedSnapshot(codexHomeDir, version)),
				);
				const pluginRoot = snapshots[0]!;
				const lock = await writeLivePinMutationLock(codexHomeDir, "0.20.0", 2_147_483_647, "retire", true);
				const sessionId = "wrapper-dead-lock-session";

				const hookResult = spawnSync(process.execPath, [join(pluginRoot, "hooks", "codex-native-hook.mjs")], {
					cwd: wd,
					input: JSON.stringify({
						hook_event_name: "SessionStart",
						session_id: sessionId,
						codex_pid: process.pid,
						cwd: wd,
					}),
					encoding: "utf-8",
					env: { ...process.env, CODEX_HOME: codexHomeDir },
				});

				assert.equal(hookResult.status, 0, hookResult.stderr || hookResult.stdout);
				await assert.rejects(lstat(lock.path), { code: "ENOENT" });
				await assert.rejects(lstat(lock.stagePath), { code: "ENOENT" });
				const pinDirectory = join(pluginRoot, ".omx-live-pin");
				const sessionHash = createHash("sha256").update(sessionId).digest("hex");
				const records = await Promise.all(
					(await readdir(pinDirectory)).map(
						async (name) => JSON.parse(await readFile(join(pinDirectory, name), "utf-8")) as { sessionHash: string },
					),
				);
				assert.ok(records.some((record) => record.sessionHash === sessionHash));
			});
		} finally {
			await rm(wd, { recursive: true, force: true });
		}
	});

	it("restores a snapshot if a live pin appears after it is quarantined", async () => {
		const wd = await mkdtemp(join(tmpdir(), "omx-3790-late-pin-restore-"));
		try {
			await withIsolatedUserHome(wd, async (codexHomeDir) => {
				const snapshots = await Promise.all(
					["0.20.0", "0.20.1", "0.20.2"].map((version) => seedManagedSnapshot(codexHomeDir, version)),
				);
				let interposed = false;
				const resetHooks = setPluginCacheMutationHooksForTest({
					beforeRemove: async (quarantinePath) => {
						if (interposed || !quarantinePath.includes(".0.20.0.reclaim-")) return;
						interposed = true;
						const pinDirectory = join(quarantinePath, ".omx-live-pin");
						await mkdir(pinDirectory);
						await writeFile(
							join(pinDirectory, "late-pin.json"),
							`${JSON.stringify({
								version: 1,
								pid: process.pid,
								processStartHash: null,
								sessionHash: createHash("sha256").update("late-session").digest("hex"),
							})}\n`,
						);
					},
				});
				try {
					const retired = await retireUnpinnedManagedSnapshots(codexHomeDir, "0.20.3");
					assert.equal(interposed, true);
					assert.equal(retired.includes(snapshots[0]!), false);
					assert.equal(retired.includes(snapshots[1]!), true);
					await lstat(snapshots[0]!);
					await assert.rejects(lstat(snapshots[1]!), { code: "ENOENT" });
				} finally {
					resetHooks();
				}
			});
		} finally {
			await rm(wd, { recursive: true, force: true });
		}
	});

	it("preserves active old-session roots and retires roots whose pin owner exited", async () => {
		const activeWd = await mkdtemp(join(tmpdir(), "omx-3790-active-pin-"));
		try {
			await withIsolatedUserHome(activeWd, async (codexHomeDir) => {
				const snapshots = await Promise.all(
					["0.20.0", "0.20.1", "0.20.2"].map((version) =>
						seedManagedSnapshot(codexHomeDir, version),
					),
				);
				assert.equal(
					await registerOmxPluginCacheLivePin(
						snapshots[0]!,
						"active-old-session",
						process.pid,
					),
					true,
				);
				const retired = await retireUnpinnedManagedSnapshots(
					codexHomeDir,
					"0.20.3",
				);
				assert.equal(retired.includes(snapshots[0]!), false);
				assert.equal(retired.includes(snapshots[1]!), true);
				await lstat(snapshots[0]!);
				await lstat(snapshots[2]!);
				await assert.rejects(lstat(snapshots[1]!), { code: "ENOENT" });
			});
		} finally {
			await rm(activeWd, { recursive: true, force: true });
		}

		const staleWd = await mkdtemp(join(tmpdir(), "omx-3790-stale-pin-"));
		try {
			await withIsolatedUserHome(staleWd, async (codexHomeDir) => {
				const snapshots = await Promise.all(
					["0.20.0", "0.20.1", "0.20.2"].map((version) =>
						seedManagedSnapshot(codexHomeDir, version),
					),
				);
				await writeDeadLivePin(snapshots[0]!);
				const retired = await retireUnpinnedManagedSnapshots(
					codexHomeDir,
					"0.20.3",
				);
				assert.equal(retired.includes(snapshots[0]!), true);
				await assert.rejects(lstat(snapshots[0]!), { code: "ENOENT" });
				await lstat(snapshots[2]!);
			});
		} finally {
			await rm(staleWd, { recursive: true, force: true });
		}
	});

	it("repairs manifest version drift from verified publication ownership without removing live pins", async () => {
		const wd = await mkdtemp(join(tmpdir(), "omx-3790-manifest-version-drift-"));
		try {
			await withIsolatedUserHome(wd, async (codexHomeDir) => {
				const packaged = await resolvePackagedOmxMarketplace(packageRoot);
				assert.ok(packaged);
				const published = await materializePackagedOmxPluginCache(codexHomeDir, packaged);
				assert.equal(published.status, "materialized");
				const cacheDir = published.cacheDir!;
				const manifestPath = join(cacheDir, ".codex-plugin", "plugin.json");
				const manifest = JSON.parse(await readFile(manifestPath, "utf-8")) as Record<string, unknown>;
				const expectedVersion = String(manifest.version);
				assert.equal(expectedVersion, published.version);
				assert.equal(await registerOmxPluginCacheLivePin(cacheDir, "drifted-manifest-session", process.pid), true);

				manifest.version = "corrupted-version";
				await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
				const blocked = await materializePackagedOmxPluginCache(codexHomeDir, packaged, { repairCache: true });
				assert.equal(blocked.status, "stale-launcher");
				assert.match(blocked.reason ?? "", /pinned by a live Codex session/);
				assert.equal(JSON.parse(await readFile(manifestPath, "utf-8")).version, "corrupted-version");

				await rm(join(cacheDir, ".omx-live-pin"), { recursive: true, force: true });
				const repaired = await materializePackagedOmxPluginCache(codexHomeDir, packaged, { repairCache: true });
				assert.equal(repaired.status, "materialized", JSON.stringify(repaired));
				assert.equal(repaired.version, expectedVersion);
				assert.equal(JSON.parse(await readFile(manifestPath, "utf-8")).version, expectedVersion);
			});
		} finally {
			await rm(wd, { recursive: true, force: true });
		}
	});

	it("retries pin registration on later hooks when a same-session PID has stale identity", async () => {
		const wd = await mkdtemp(join(tmpdir(), "omx-3790-stale-later-hook-pin-"));
		try {
			await withIsolatedUserHome(wd, async (codexHomeDir) => {
				const snapshots = await Promise.all(
					["0.20.0", "0.20.1", "0.20.2"].map((version) => seedManagedSnapshot(codexHomeDir, version)),
				);
				const sessionId = "resumed-session";
				const sessionHash = createHash("sha256").update(sessionId).digest("hex");
				const staleProcessStartHash = "000000000000000000000000";
				const pinDirectory = join(snapshots[0]!, ".omx-live-pin");
				await mkdir(pinDirectory, { recursive: true });
				await writeFile(
					join(pinDirectory, "stale-reused-pid.json"),
					`${JSON.stringify({
						version: 1,
						pid: process.pid,
						processStartHash: staleProcessStartHash,
						sessionHash,
					})}\n`,
				);

				const failedStart = spawnSync(process.execPath, [join(snapshots[0]!, "hooks", "codex-native-hook.mjs")], {
					cwd: wd,
					input: JSON.stringify({
						hook_event_name: "SessionStart",
						session_id: sessionId,
						codex_pid: process.pid,
						cwd: wd,
					}),
					encoding: "utf-8",
					env: {
						...process.env,
						CODEX_HOME: codexHomeDir,
						OMX_NATIVE_HOOK_COMMAND: process.execPath,
					},
				});
				assert.equal(failedStart.status, 0, failedStart.stderr || failedStart.stdout);
				const pendingPath = livePinIntentPath(codexHomeDir, "0.20.0", sessionId);
				assert.equal(JSON.parse(await readFile(pendingPath, "utf-8")).sessionHash, sessionHash);
				const expiredAt = new Date(Date.now() - 6 * 60 * 1000);
				await utimes(pendingPath, expiredAt, expiredAt);

				const hookResult = spawnSync(process.execPath, [join(snapshots[0]!, "hooks", "codex-native-hook.mjs")], {
					cwd: wd,
					input: JSON.stringify({
						hook_event_name: "UserPromptSubmit",
						session_id: sessionId,
						codex_pid: process.pid,
						cwd: wd,
					}),
					encoding: "utf-8",
					env: { ...process.env, CODEX_HOME: codexHomeDir },
				});
				assert.equal(hookResult.status, 0, hookResult.stderr || hookResult.stdout);
				await assert.rejects(lstat(pendingPath), { code: "ENOENT" });
				const pinRecords = await Promise.all(
					(await readdir(pinDirectory)).map(
						async (name) =>
							JSON.parse(await readFile(join(pinDirectory, name), "utf-8")) as {
								pid: number;
								processStartHash: string | null;
								sessionHash: string;
							},
					),
				);
				assert.ok(
					pinRecords.some(
						(record) =>
							record.pid === process.pid &&
							record.sessionHash === sessionHash &&
							record.processStartHash !== staleProcessStartHash,
					),
				);
			});
		} finally {
			await rm(wd, { recursive: true, force: true });
		}
	});

	it("refreshes a resumed SessionStart pin when its prior process identity is stale", async () => {
		const wd = await mkdtemp(join(tmpdir(), "omx-3790-resumed-session-pin-"));
		try {
			await withIsolatedUserHome(wd, async (codexHomeDir) => {
				const snapshots = await Promise.all(
					["0.20.0", "0.20.1", "0.20.2"].map((version) => seedManagedSnapshot(codexHomeDir, version)),
				);
				const sessionId = "resumed-session";
				const sessionHash = createHash("sha256").update(sessionId).digest("hex");
				const staleProcessStartHash = "000000000000000000000000";
				const pinDirectory = join(snapshots[0]!, ".omx-live-pin");
				await mkdir(pinDirectory, { recursive: true });
				await writeFile(
					join(pinDirectory, "stale-reused-pid.json"),
					`${JSON.stringify({
						version: 1,
						pid: process.pid,
						processStartHash: staleProcessStartHash,
						sessionHash,
					})}\n`,
				);

				const hookResult = spawnSync(
					process.execPath,
					[join(snapshots[0]!, "hooks", "codex-native-hook.mjs")],
					{
						cwd: wd,
						input: JSON.stringify({
							hook_event_name: "SessionStart",
							session_id: sessionId,
							codex_pid: process.pid,
							cwd: wd,
						}),
						encoding: "utf-8",
						env: { ...process.env, CODEX_HOME: codexHomeDir },
					},
				);
				assert.equal(hookResult.status, 0, hookResult.stderr || hookResult.stdout);
				const pinRecords = await Promise.all(
					(await readdir(pinDirectory)).map(async (name) =>
						JSON.parse(await readFile(join(pinDirectory, name), "utf-8")) as {
							pid: number;
							processStartHash: string | null;
							sessionHash: string;
						},
					),
				);
				assert.ok(pinRecords.some((record) =>
					record.pid === process.pid
					&& record.sessionHash === sessionHash
					&& record.processStartHash !== staleProcessStartHash,
				));

				const retired = await retireUnpinnedManagedSnapshots(codexHomeDir, "0.20.3");
				assert.equal(retired.includes(snapshots[0]!), false);
				assert.equal(retired.includes(snapshots[1]!), true);
				await lstat(snapshots[0]!);
				await assert.rejects(lstat(snapshots[1]!), { code: "ENOENT" });
			});
		} finally {
			await rm(wd, { recursive: true, force: true });
		}
	});

	it("repairs a missing manifest from the legacy numeric managed marker", async () => {
		const wd = await mkdtemp(join(tmpdir(), "omx-3790-legacy-managed-marker-"));
		try {
			await withIsolatedUserHome(wd, async (codexHomeDir) => {
				const packaged = await resolvePackagedOmxMarketplace(packageRoot);
				assert.ok(packaged);
				const published = await materializePackagedOmxPluginCache(codexHomeDir, packaged);
				assert.equal(published.status, "materialized");
				const cacheDir = published.cacheDir!;
				await writeFile(join(cacheDir, ".omx-managed"), `${process.pid}\n`);
				const manifestPath = join(cacheDir, ".codex-plugin", "plugin.json");
				await rm(manifestPath);
				await writeFile(join(cacheDir, "hooks", "omx-command.json"), "stale launcher\n");

				const repaired = await materializePackagedOmxPluginCache(codexHomeDir, packaged, { repairCache: true });
				assert.equal(repaired.status, "materialized", JSON.stringify(repaired));
				const ownership = JSON.parse(await readFile(join(cacheDir, ".omx-managed"), "utf-8")) as { cacheVersion: string };
				assert.equal(ownership.cacheVersion, published.version);
				assert.equal(JSON.parse(await readFile(manifestPath, "utf-8")).version, published.version);
			});
		} finally {
			await rm(wd, { recursive: true, force: true });
		}
	});
});
