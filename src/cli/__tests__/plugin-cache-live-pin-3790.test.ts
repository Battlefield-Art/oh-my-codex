import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import {
	cp,
	lstat,
	mkdir,
	mkdtemp,
	readFile,
	readdir,
	rm,
	utimes,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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
});
