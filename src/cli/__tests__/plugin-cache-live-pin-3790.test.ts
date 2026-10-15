import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
	cp,
	lstat,
	mkdir,
	mkdtemp,
	readFile,
	readdir,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import {
	computeOmxPluginCacheClaimDigest,
	materializePackagedOmxPluginCache,
	omxPluginCacheBase,
	registerOmxPluginCacheLivePin,
	resolvePackagedOmxMarketplace,
	retireUnpinnedManagedSnapshots,
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
});
