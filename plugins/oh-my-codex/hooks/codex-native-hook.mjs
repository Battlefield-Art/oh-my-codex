#!/usr/bin/env node
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { extname } from 'node:path';
import { closeSync, constants as fsConstants, existsSync, fstatSync, futimesSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const hookDir = dirname(fileURLToPath(import.meta.url));
// sync-plugin-mirror verifies this stable marker; runtime behavior is tested separately.
const OMX_PLUGIN_HOOK_LAUNCHER_CONTRACT_MARKER = 'omx-plugin-hook-launcher:v1';
const OMX_PLUGIN_HOOK_ROUTING_ONLY_MARKER = 'omx-plugin-hook-routing-only:v1';
const MAX_WRAPPER_STDIN_BYTES = 1024 * 1024;
const RAW_EVENT_SCAN_BYTES = 64 * 1024;
const MAX_BUFFERED_HOOK_STDOUT_BYTES = 1024 * 1024;
const MAX_ROUTING_RECORD_BYTES = 4 * 1024;
const LIVE_PIN_HELPER_TIMEOUT_MS = 5_000;
const LIVE_PIN_HELPER_KILL_GRACE_MS = 250;
const LIVE_PIN_PENDING_PREFIX = '.pending-';
const LIVE_PIN_INTENT_PREFIX = '.omx-live-pin-intent-';
const LIVE_PIN_INTENT_STAGE_PREFIX = '.stage-omx-live-pin-intent-';
const CODEX_HOOK_EVENT_NAMES = new Set([
  'SessionStart',
  'PreToolUse',
  'PostToolUse',
  'UserPromptSubmit',
  'PreCompact',
  'PostCompact',
  'SubagentStop',
  'Stop',
]);

function skipJsonWhitespace(raw, index) {
  while (index < raw.length && /\s/.test(raw[index] ?? '')) index += 1;
  return index;
}

function readJsonStringLiteral(raw, quoteIndex) {
  if (raw[quoteIndex] !== '"') return null;
  let value = '';
  for (let index = quoteIndex + 1; index < raw.length; index += 1) {
    const char = raw[index];
    if (char === '"') return { value, endIndex: index + 1 };
    if (char !== '\\') {
      value += char;
      continue;
    }

    index += 1;
    if (index >= raw.length) return null;
    const escaped = raw[index];
    switch (escaped) {
      case '"':
      case '\\':
      case '/':
        value += escaped;
        break;
      case 'b':
        value += '\b';
        break;
      case 'f':
        value += '\f';
        break;
      case 'n':
        value += '\n';
        break;
      case 'r':
        value += '\r';
        break;
      case 't':
        value += '\t';
        break;
      case 'u': {
        const hex = raw.slice(index + 1, index + 5);
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) return null;
        value += String.fromCharCode(Number.parseInt(hex, 16));
        index += 4;
        break;
      }
      default:
        return null;
    }
  }
  return null;
}

function extractTopLevelStringField(rawInput, fieldNames) {
  const raw = rawInput.slice(0, RAW_EVENT_SCAN_BYTES);
  const wanted = new Set(fieldNames);
  let depth = 0;
  let index = 0;

  while (index < raw.length) {
    const char = raw[index];
    if (char === '"') {
      const key = readJsonStringLiteral(raw, index);
      if (!key) return null;
      index = key.endIndex;
      const afterKey = skipJsonWhitespace(raw, index);
      if (depth === 1 && raw[afterKey] === ':' && wanted.has(key.value)) {
        const valueStart = skipJsonWhitespace(raw, afterKey + 1);
        const value = readJsonStringLiteral(raw, valueStart);
        return value?.value ?? null;
      }
      continue;
    }
    if (char === '{') depth += 1;
    else if (char === '}') depth = Math.max(0, depth - 1);
    index += 1;
  }

  return null;
}

function extractTopLevelHookEventName(rawInput) {
  const eventName = extractTopLevelStringField(rawInput, ['hook_event_name', 'hookEventName', 'event', 'name']);
  return CODEX_HOOK_EVENT_NAMES.has(eventName) ? eventName : null;
}

function detectStopHookInput(input) {
  const text = input.toString('utf8');
  try {
    const parsed = JSON.parse(text);
    const eventName = parsed?.hook_event_name ?? parsed?.hookEventName ?? parsed?.event ?? parsed?.name;
    return eventName === 'Stop';
  } catch {
    return extractTopLevelHookEventName(text) === 'Stop';
  }
}

function detectCompactHookInput(input) {
  const text = input.toString('utf8');
  try {
    const parsed = JSON.parse(text);
    const eventName = parsed?.hook_event_name ?? parsed?.hookEventName ?? parsed?.event ?? parsed?.name;
    return eventName === 'PreCompact' || eventName === 'PostCompact';
  } catch {
    const eventName = extractTopLevelHookEventName(text);
    return eventName === 'PreCompact' || eventName === 'PostCompact';
  }
}

function parseHookPayload(input) {
  try {
    const parsed = JSON.parse(input.toString('utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function sanitizeLaunchId(value) {
  return String(value ?? '').trim().replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 128);
}

function resolveLaunchRoutingPath(payload, launchId) {
  const cwd = typeof payload.cwd === 'string' && payload.cwd.trim() ? payload.cwd : process.cwd();
  const stateRoot = typeof process.env.OMX_ROOT === 'string' && process.env.OMX_ROOT.trim()
    ? process.env.OMX_ROOT.trim()
    : join(cwd, '.omx');
  return join(stateRoot, 'state', 'plugin-hook-routing', `${sanitizeLaunchId(launchId)}.json`);
}

function hookPayloadSessionId(input, payload) {
  const candidate = payload?.session_id ?? payload?.sessionId;
  const parsedSessionId = typeof candidate === 'string' ? candidate.trim() : '';
  if (parsedSessionId) return parsedSessionId;
  return input && typeof input.toString === 'function'
    ? extractTopLevelStringField(input.toString('utf8'), ['session_id', 'sessionId'])?.trim() ?? ''
    : '';
}

function isSafeRoutingSessionId(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 256;
}

function isChildRoutingSessionStart(payload, ownerSessionId) {
  if ((payload?.hook_event_name ?? payload?.hookEventName) !== 'SessionStart' || !ownerSessionId) return false;
  const childSessionId = hookPayloadSessionId(null, payload);
  const transcriptCandidate = payload?.transcript_path ?? payload?.transcriptPath;
  const transcriptPath = typeof transcriptCandidate === 'string' ? transcriptCandidate.trim() : '';
  if (!childSessionId || !transcriptPath) return false;
  let fd;
  try {
    fd = openSync(transcriptPath, 'r');
    const buffer = Buffer.alloc(64 * 1024);
    const bytes = readSync(fd, buffer, 0, buffer.length, 0);
    const newline = buffer.subarray(0, bytes).indexOf(0x0a);
    const firstLine = buffer.subarray(0, newline >= 0 ? newline : bytes).toString('utf8').trim();
    const record = JSON.parse(firstLine);
    const metadata = record?.type === 'session_meta' && record?.payload && typeof record.payload === 'object' ? record.payload : null;
    const spawn = metadata?.source?.subagent?.thread_spawn;
    const metadataIds = [metadata?.id, metadata?.session_id].filter((value) => value !== undefined);
    return metadataIds.length > 0
      && metadataIds.every((value) => value === childSessionId)
      && spawn && typeof spawn === 'object'
      && spawn.parent_thread_id === ownerSessionId;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) try { closeSync(fd); } catch {}
  }
}

function isTrackedSubagentInSessionTree(tracking, rootSessionId, targetThreadId) {
  const pendingSessionIds = [rootSessionId];
  const visitedSessionIds = new Set();
  while (pendingSessionIds.length > 0) {
    const sessionId = pendingSessionIds.pop();
    if (!sessionId || visitedSessionIds.has(sessionId)) continue;
    visitedSessionIds.add(sessionId);
    const threads = tracking?.sessions?.[sessionId]?.threads;
    if (!threads || typeof threads !== 'object' || Array.isArray(threads)) continue;
    if (threads[targetThreadId]?.kind === 'subagent') return true;
    for (const [threadId, thread] of Object.entries(threads)) {
      if (thread?.kind !== 'subagent' || !isSafeRoutingSessionId(threadId)) continue;
      if (tracking?.sessions?.[threadId] && !visitedSessionIds.has(threadId)) pendingSessionIds.push(threadId);
    }
  }
  return false;
}

function isChildRoutingSubagentStop(payload, ownerSessionId) {
  if ((payload?.hook_event_name ?? payload?.hookEventName) !== 'SubagentStop' || !ownerSessionId) return false;
  const cwd = typeof payload.cwd === 'string' && payload.cwd.trim() ? payload.cwd : process.cwd();
  const stateDir = listAuthoritativeStateBaseDirs(cwd)[0];
  const parentSessionId = hookPayloadSessionId(null, payload);
  if (!isSafeRoutingSessionId(parentSessionId)) return false;
  const tracking = readJsonFile(join(stateDir, 'subagent-tracking.json'));
  if (isTrackedSubagentInSessionTree(tracking, ownerSessionId, parentSessionId)) return true;
  const session = readJsonFile(join(stateDir, 'session.json'));
  if (!isSessionStateAuthoritativeForCwd(session, cwd)
    || ![session.session_id, session.native_session_id, session.owner_omx_session_id, session.owner_codex_session_id, session.codex_session_id].includes(ownerSessionId)) return false;
  return isTrackedSubagentInSessionTree(tracking, session.session_id, parentSessionId);
}

function readPinnedRoutingRecord(routingPath) {
  let fd;
  try {
    const initial = lstatSync(routingPath);
    if (!initial.isFile() || initial.isSymbolicLink() || initial.nlink !== 1 || initial.size <= 0 || initial.size > MAX_ROUTING_RECORD_BYTES) return null;
    fd = openSync(routingPath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.nlink !== 1 || opened.size !== initial.size || opened.dev !== initial.dev || opened.ino !== initial.ino) return null;
    const buffer = Buffer.alloc(opened.size);
    if (readSync(fd, buffer, 0, buffer.length, 0) !== buffer.length) return null;
    const current = lstatSync(routingPath);
    const final = fstatSync(fd);
    if (!current.isFile() || current.isSymbolicLink() || current.nlink !== 1 || current.size !== opened.size || current.dev !== opened.dev || current.ino !== opened.ino || final.nlink !== 1 || final.size !== opened.size) return null;
    const routing = JSON.parse(buffer.toString('utf8'));
    return routing && typeof routing === 'object' && !Array.isArray(routing) ? routing : null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) try { closeSync(fd); } catch {}
  }
}

// This is routing correlation only. It is intentionally unauthenticated and must
// never be used as authorization or proof that a session is OMX-owned.
function isPluginHookRoutingSession(input, payload) {
  const launchId = sanitizeLaunchId(process.env.OMX_CODEX_LAUNCH_ID);
  const entryPath = process.env.OMX_ENTRY_PATH?.trim();
  const sessionId = hookPayloadSessionId(input, payload);
  if (!launchId || !entryPath || !isSafeRoutingSessionId(sessionId)) return false;

  const routingPath = resolveLaunchRoutingPath(payload, launchId);
  try {
    if (existsSync(routingPath)) {
      const routing = readPinnedRoutingRecord(routingPath);
      if (!routing) return false;
      const ownerSessionId = routing.routing === OMX_PLUGIN_HOOK_ROUTING_ONLY_MARKER && isSafeRoutingSessionId(routing.ownerSessionId)
        ? routing.ownerSessionId
        : '';
      return ownerSessionId === sessionId || isChildRoutingSessionStart(payload, ownerSessionId)
        || isChildRoutingSubagentStop(payload, ownerSessionId);
    }
    mkdirSync(dirname(routingPath), { recursive: true });
    writeFileSync(routingPath, `${JSON.stringify({ routing: OMX_PLUGIN_HOOK_ROUTING_ONLY_MARKER, ownerSessionId: sessionId })}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    return true;
  } catch {
    return false;
  }
}

function writePlainCodexNoop(emitJson) {
  if (emitJson) process.stdout.write('{}\n');
  process.exitCode = 0;
}

async function readBoundedStdin({ drainOversized = false } = {}) {
  const chunks = [];
  let totalBytes = 0;
  let storedBytes = 0;
  let oversized = false;
  for await (const rawChunk of process.stdin) {
    const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
    totalBytes += chunk.length;

    if (oversized) continue;

    const remaining = MAX_WRAPPER_STDIN_BYTES - storedBytes;
    if (chunk.length > remaining) {
      if (remaining > 0) chunks.push(chunk.subarray(0, remaining));
      storedBytes += Math.max(remaining, 0);
      oversized = true;
      if (!drainOversized) return { input: Buffer.concat(chunks), oversized: true, totalBytes };
      continue;
    }
    chunks.push(chunk);
    storedBytes += chunk.length;
  }
  return { input: Buffer.concat(chunks), oversized, totalBytes };
}

function stopFallbackOutput(stopReason, detail) {
  const reason = 'OMX plugin Stop hook launcher failed before valid native Stop JSON could be produced. Continue once, preserve runtime state, inspect hook launcher diagnostics, and retry.';
  return {
    decision: 'block',
    reason,
    stopReason,
    systemMessage: detail ? `${reason} Failure: ${detail}` : reason,
  };
}

function writeStopFallback(stopReason, detail) {
  process.stdout.write(`${JSON.stringify(stopFallbackOutput(stopReason, detail))}\n`);
  process.exitCode = 0;
}

function writeOversizedStopFallback(stopReason, detail) {
  const reason =
    'OMX plugin Stop rejected oversized stdin before launcher delegation; continue once with a smaller valid Stop JSON response.';
  process.stdout.write(`${JSON.stringify({
    decision: 'block',
    reason,
    stopReason,
    systemMessage: detail ? `${reason} Failure: ${detail}` : reason,
  })}\n`);
  process.exitCode = 0;
}

function writeOversizedStopNoop() {
  process.stdout.write('{}\n');
  process.exitCode = 0;
}

function writeOversizedToolHookOutput(eventName) {
  const systemMessage = 'OMX native hook rejected oversized stdin JSON before parsing; maxBytes=1048576.';
  const output = eventName === 'PreToolUse'
    ? {
      systemMessage,
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: systemMessage,
      },
    }
    : {
      continue: false,
      stopReason: 'native_hook_stdin_oversized',
      systemMessage,
    };
  process.stdout.write(`${JSON.stringify(output)}\n`);
  process.exitCode = 0;
}
function writeCompactFallback() {
  process.exitCode = 0;
}

function failLauncher(error, isStop, isCompact, isSubagentStop, stopReason = 'plugin_stop_hook_launcher_failure') {
  const detail = error instanceof Error ? error.message : String(error);
  console.error(`[oh-my-codex] ${detail}`);
  if (isStop) {
    writeStopFallback(stopReason, detail);
    return;
  }
  if (isSubagentStop) {
    writePlainCodexNoop(true);
    return;
  }
  if (isCompact) {
    writeCompactFallback();
    return;
  }
  process.exitCode = 1;
}

function readPinnedLauncher() {
  const launcherPath = join(hookDir, 'omx-command.json');
  try {
    const raw = JSON.parse(readFileSync(launcherPath, 'utf8'));
    if (typeof raw.command !== 'string' || raw.command.trim() === '') {
      throw new Error('missing non-empty command');
    }
    const argsPrefix = Array.isArray(raw.argsPrefix) ? raw.argsPrefix : [];
    if (!argsPrefix.every((arg) => typeof arg === 'string')) {
      throw new Error('argsPrefix must contain only strings');
    }
    return { command: raw.command, argsPrefix };
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw new Error(`invalid plugin hook launcher ${launcherPath}: ${error.message}`);
  }
}

function buildSpawnOptions(command, extraEnv = {}) {
  const options = {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, ...extraEnv },
  };

  if (process.platform !== 'win32') return options;

  const extension = extname(command).toLowerCase();
  if (extension === '.exe' || extension === '.com') {
    return { ...options, windowsHide: true };
  }

  return { ...options, shell: true, windowsHide: true };
}

function readJsonFile(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

function livePinTarget(pluginRoot) {
  const absoluteRoot = resolve(pluginRoot);
  const version = basename(absoluteRoot);
  if (!version || version === '.' || version === '..' || version.includes('/') || version.includes('\\') || version.includes('\0')) return null;
  const codexHome = resolve(process.env.CODEX_HOME || join(homedir(), '.codex'));
  const cacheBase = join(codexHome, 'plugins', 'cache', 'oh-my-codex-local', 'oh-my-codex');
  const expectedRoot = join(cacheBase, version);
  if (!sameLexicalFilePath(absoluteRoot, expectedRoot)) return null;
  const cacheBaseStats = lstatSync(cacheBase);
  if (!cacheBaseStats.isDirectory() || cacheBaseStats.isSymbolicLink()) return null;
  return { pluginRoot: absoluteRoot, version, cacheBase, expectedRoot };
}

function livePinDirectory(pluginRoot) {
  const target = livePinTarget(pluginRoot);
  if (!target) return null;
  const { pluginRoot: absoluteRoot, version, cacheBase, expectedRoot } = target;
  let rootFd = null;
  const closeRoot = () => {
    if (rootFd === null) return;
    try { closeSync(rootFd); } catch {}
    rootFd = null;
  };
  try {
    const rootStats = lstatSync(absoluteRoot);
    if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) return null;
    if (process.platform === 'linux') {
      rootFd = openSync(absoluteRoot, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW);
      const openedRootStats = fstatSync(rootFd);
      if (
        !openedRootStats.isDirectory()
        || openedRootStats.isSymbolicLink()
        || openedRootStats.dev !== rootStats.dev
        || openedRootStats.ino !== rootStats.ino
      ) {
        closeRoot();
        return null;
      }
    }
    const operationRoot = rootFd === null ? absoluteRoot : `/proc/self/fd/${rootFd}`;
    const metadataDir = join(operationRoot, '.codex-plugin');
    const metadataStats = lstatSync(metadataDir);
    if (!metadataStats.isDirectory() || metadataStats.isSymbolicLink()) {
      closeRoot();
      return null;
    }
    const manifestText = readNoFollowText(join(metadataDir, 'plugin.json'), 16 * 1024)?.content;
    let manifest;
    try { manifest = manifestText ? JSON.parse(manifestText) : null; } catch { manifest = null; }
    if (manifest?.name !== 'oh-my-codex' || manifest.version !== version || !sameFilePath(absoluteRoot, expectedRoot)) {
      closeRoot();
      return null;
    }
    for (const marker of ['.omx-managed', '.omx-complete']) {
      const stats = lstatSync(join(operationRoot, marker));
      if (!stats.isFile() || stats.isSymbolicLink()) {
        closeRoot();
        return null;
      }
    }
    const pinDir = join(operationRoot, '.omx-live-pin');
    try {
      const pinDirStats = lstatSync(pinDir);
      if (!pinDirStats.isDirectory() || pinDirStats.isSymbolicLink()) {
        closeRoot();
        return null;
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        closeRoot();
        return null;
      }
    }
    return { path: pinDir, pluginRoot: absoluteRoot, version, cacheBase, rootDev: rootStats.dev, rootIno: rootStats.ino, rootFd };
  } catch (error) {
    closeRoot();
    throw error;
  }
}

function livePinRootMatches(pinState) {
  try {
    // The open descriptor follows a snapshot into quarantine; the published path must still name it.
    const namedRootStats = lstatSync(pinState.pluginRoot);
    if (
      !namedRootStats.isDirectory()
      || namedRootStats.isSymbolicLink()
      || namedRootStats.dev !== pinState.rootDev
      || namedRootStats.ino !== pinState.rootIno
    ) return false;
    const currentStats = pinState.rootFd === null
      ? namedRootStats
      : fstatSync(pinState.rootFd);
    return currentStats.isDirectory()
      && !currentStats.isSymbolicLink()
      && currentStats.dev === pinState.rootDev
      && currentStats.ino === pinState.rootIno;
  } catch {
    return false;
  }
}

function closeLivePinDirectory(pinState) {
  if (!pinState || pinState.rootFd === null) return;
  try { closeSync(pinState.rootFd); } catch {}
}

function livePinRetirementGateExists(pinDir) {
  try {
    lstatSync(join(pinDir, '.omx-retiring'));
    return true;
  } catch (error) {
    return error?.code !== 'ENOENT';
  }
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== 'ESRCH';
  }
}

function sameFileIdentity(left, right) {
  return Number.isInteger(left?.dev) && Number.isInteger(left?.ino)
    && Number.isInteger(right?.dev) && Number.isInteger(right?.ino)
    && left.dev === right.dev && left.ino === right.ino;
}

function readNoFollowText(path, maxBytes, { allowHardLinks = false } = {}) {
  let fd = null;
  try {
    const pathStats = lstatSync(path);
    const validLinkCount = pathStats.nlink === 1 || (allowHardLinks && pathStats.nlink === 2);
    if (!pathStats.isFile() || pathStats.isSymbolicLink() || !validLinkCount || pathStats.size <= 0 || pathStats.size > maxBytes) return null;
    fd = openSync(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    const openedStats = fstatSync(fd);
    if (!openedStats.isFile() || openedStats.isSymbolicLink() || !sameFileIdentity(openedStats, pathStats) || openedStats.nlink !== pathStats.nlink) return null;
    const content = readFileSync(fd, 'utf8');
    if (Buffer.byteLength(content) > maxBytes) return null;
    const afterStats = lstatSync(path);
    if (!sameFileIdentity(afterStats, pathStats) || afterStats.nlink !== pathStats.nlink) return null;
    return { stats: openedStats, content };
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try { closeSync(fd); } catch {}
    }
  }
}

function livePinVersionHash(version) {
  return createHash('sha256').update(version).digest('hex').slice(0, 24);
}

function livePinMutationLockName(version) {
  const versionHash = livePinVersionHash(version);
  return `.omx-live-pin-${versionHash}.lock`;
}

function readLivePinMutationLock(path) {
  let stats;
  try {
    stats = lstatSync(path);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    return { stats: null, content: null, record: null, regular: false };
  }
  if (!stats.isFile() || stats.isSymbolicLink() || (stats.nlink !== 1 && stats.nlink !== 2) || stats.size <= 0 || stats.size > 256) {
    return { stats, content: null, record: null, regular: false };
  }
  const file = readNoFollowText(path, 256, { allowHardLinks: true });
  if (!file || !sameFileIdentity(file.stats, stats) || file.stats.nlink !== stats.nlink) {
    return { stats, content: null, record: null, regular: false };
  }
  let record;
  try {
    record = JSON.parse(file.content);
  } catch {
    return { stats, content: file.content, record: null, regular: true };
  }
  if (
    record?.version !== 1
    || !Number.isSafeInteger(record.pid)
    || record.pid <= 0
    || (record.operation !== 'pin' && record.operation !== 'retire')
    || typeof record.token !== 'string'
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(record.token)
  ) return { stats, content: file.content, record: null, regular: true };
  if (stats.nlink === 2) {
    const stagePath = `${path}.stage-${record.pid}-${record.token}`;
    const stage = readNoFollowText(stagePath, 256, { allowHardLinks: true });
    if (!stage || !sameFileIdentity(stage.stats, stats) || stage.content !== file.content) {
      return { stats, content: file.content, record: null, regular: false };
    }
  }
  return { stats, content: file.content, record, regular: true };
}

function removeVerifiedLockEntry(path, expectedStats, expectedContent, canRemove = () => true) {
  try {
    const current = readNoFollowText(path, 256, { allowHardLinks: true });
    if (!current || !sameFileIdentity(current.stats, expectedStats) || current.content !== expectedContent) return false;
    const quarantinePath = `${path}.reclaim-${process.pid}-${randomUUID()}`;
    renameSync(path, quarantinePath);
    const restore = () => {
      try {
        const quarantined = lstatSync(quarantinePath);
        if (!quarantined.isFile() || quarantined.isSymbolicLink() || !sameFileIdentity(quarantined, expectedStats)) return;
        linkSync(quarantinePath, path);
        const restored = lstatSync(path);
        if (sameFileIdentity(restored, expectedStats)) unlinkSync(quarantinePath);
      } catch {}
    };
    const quarantined = readNoFollowText(quarantinePath, 256, { allowHardLinks: true });
    if (!quarantined || !sameFileIdentity(quarantined.stats, expectedStats) || quarantined.content !== expectedContent || !canRemove()) {
      restore();
      return false;
    }
    const final = readNoFollowText(quarantinePath, 256, { allowHardLinks: true });
    if (!final || !sameFileIdentity(final.stats, expectedStats) || final.content !== expectedContent || !canRemove()) {
      restore();
      return false;
    }
    unlinkSync(quarantinePath);
    return true;
  } catch {
    return false;
  }
}

function removeLockStageLink(path, state) {
  if (state?.stats?.nlink === 1) return true;
  if (state?.stats?.nlink !== 2 || !state.record || !state.content) return false;
  const stagePath = `${path}.stage-${state.record.pid}-${state.record.token}`;
  if (!removeVerifiedLockEntry(stagePath, state.stats, state.content)) return false;
  const refreshed = readLivePinMutationLock(path);
  return refreshed?.content === state.content
    && refreshed.record?.pid === state.record.pid
    && sameFileIdentity(refreshed.stats, state.stats)
    && refreshed.stats.nlink === 1;
}

function removeDeadLivePinMutationLock(path, state) {
  // A live PID is never stolen by age. If PID reuse makes a dead owner look
  // live, preserving the lock is safer than racing a paused pin/removal.
  if (!state?.stats || !state.regular || !state.record || isProcessAlive(state.record.pid)) return false;
  if (!removeLockStageLink(path, state)) return false;
  const refreshed = readLivePinMutationLock(path);
  if (
    refreshed?.content !== state.content
    || !refreshed.record
    || refreshed.record.pid !== state.record.pid
    || !sameFileIdentity(refreshed.stats, state.stats)
    || refreshed.stats.nlink !== 1
    || isProcessAlive(refreshed.record.pid)
  ) return false;
  return removeVerifiedLockEntry(path, refreshed.stats, refreshed.content, () => !isProcessAlive(refreshed.record.pid));
}

function acquireLivePinMutationLock(target, operation) {
  const path = join(target.cacheBase, livePinMutationLockName(target.version));
  const token = randomUUID();
  const content = `${JSON.stringify({ version: 1, pid: process.pid, operation, token })}\n`;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const existing = readLivePinMutationLock(path);
    if (existing) {
      if (removeDeadLivePinMutationLock(path, existing)) continue;
      return null;
    }
    const stagePath = `${path}.stage-${process.pid}-${token}`;
    let stageStats = null;
    let linked = false;
    try {
      // Link a complete staged record into place so readers cannot observe a
      // partially written lock; the record identifies the recoverable stage.
      writeFileSync(stagePath, content, { flag: 'wx', mode: 0o600 });
      stageStats = lstatSync(stagePath);
      try {
        linkSync(stagePath, path);
        linked = true;
      } catch (error) {
        if (error?.code !== 'EEXIST') throw error;
      }
      if (stageStats) removeVerifiedLockEntry(stagePath, stageStats, content);
      if (!linked) continue;
      const acquired = readLivePinMutationLock(path);
      if (acquired?.content === content && acquired.record?.pid === process.pid) {
        return { path, content, dev: acquired.stats.dev, ino: acquired.stats.ino };
      }
      if (acquired?.content === content && acquired.stats) {
        removeVerifiedLockEntry(path, acquired.stats, content, () => isProcessAlive(process.pid));
      }
      return null;
    } catch (error) {
      if (stageStats) removeVerifiedLockEntry(stagePath, stageStats, content);
      if (error?.code !== 'EEXIST') return null;
    }
  }
  return null;
}

function livePinMutationLockMatches(lock) {
  if (!lock) return false;
  const state = readLivePinMutationLock(lock.path);
  return state?.regular
    && state.content === lock.content
    && state.record?.pid === process.pid
    && state.stats.dev === lock.dev
    && state.stats.ino === lock.ino;
}

function hasLivePinMutationLock(pluginRoot) {
  let target;
  try {
    target = livePinTarget(pluginRoot);
  } catch {
    return true;
  }
  if (!target) return false;
  try {
    return readLivePinMutationLock(join(target.cacheBase, livePinMutationLockName(target.version))) !== null;
  } catch {
    return true;
  }
}

function releaseLivePinMutationLock(lock) {
  if (!livePinMutationLockMatches(lock)) return;
  const state = readLivePinMutationLock(lock.path);
  if (!state || !removeLockStageLink(lock.path, state)) return;
  const refreshed = readLivePinMutationLock(lock.path);
  if (refreshed?.content === lock.content && refreshed.record?.pid === process.pid && refreshed.stats.nlink === 1) {
    removeVerifiedLockEntry(lock.path, refreshed.stats, lock.content, () => isProcessAlive(process.pid));
  }
}

function pendingSessionIntentName(version, sessionHash) {
  return `${LIVE_PIN_INTENT_PREFIX}${livePinVersionHash(version)}-${sessionHash}.json`;
}

function readPendingSessionRegistration(pinPath, sessionHash) {
  const file = readNoFollowText(pinPath, 256, { allowHardLinks: true });
  if (!file) return null;
  let record;
  try { record = JSON.parse(file.content); } catch { return null; }
  if (
    record?.version !== 1
    || record.sessionHash !== sessionHash
    || Object.keys(record).some((key) => key !== 'version' && key !== 'sessionHash')
  ) return null;
  return { ...file, record };
}

function readPendingSessionIntent(path, version, sessionHash) {
  const file = readNoFollowText(path, 256, { allowHardLinks: true });
  if (!file) return null;
  let record;
  try { record = JSON.parse(file.content); } catch { return null; }
  if (
    record?.version !== 1
    || record.cacheVersion !== version
    || record.sessionHash !== sessionHash
    || Object.keys(record).some((key) => key !== 'version' && key !== 'cacheVersion' && key !== 'sessionHash')
  ) return null;
  return { ...file, record };
}

function hasPendingSessionRegistration(pluginRoot, sessionId) {
  let target;
  try {
    target = livePinTarget(pluginRoot);
  } catch {
    return false;
  }
  if (!target) return false;
  const sessionHash = createHash('sha256').update(sessionId.trim()).digest('hex');
  const path = join(target.cacheBase, pendingSessionIntentName(target.version, sessionHash));
  let stats;
  try {
    stats = lstatSync(path);
  } catch (error) {
    return error?.code !== 'ENOENT';
  }
  if (!stats.isFile() || stats.isSymbolicLink() || (stats.nlink !== 1 && stats.nlink !== 2) || stats.size <= 0 || stats.size > 256) return true;
  const intent = readPendingSessionIntent(path, target.version, sessionHash);
  if (!intent || intent.stats.dev !== stats.dev || intent.stats.ino !== stats.ino) return true;
  // A valid intent remains retryable regardless of age; retirement applies the
  // bounded mtime lease while holding the per-version mutation lock.
  return true;
}

function renewPendingSessionRegistration(path, expectedStats) {
  let fd = null;
  try {
    const before = lstatSync(path);
    if (!before.isFile() || before.isSymbolicLink() || (before.nlink !== 1 && before.nlink !== 2) || !sameFileIdentity(before, expectedStats)) return false;
    fd = openSync(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    const opened = fstatSync(fd);
    if (!opened.isFile() || !sameFileIdentity(opened, expectedStats) || opened.nlink !== before.nlink) return false;
    const now = new Date();
    futimesSync(fd, now, now);
    const after = fstatSync(fd);
    const namedAfter = lstatSync(path);
    return sameFileIdentity(after, expectedStats)
      && sameFileIdentity(namedAfter, expectedStats)
      && namedAfter.nlink === after.nlink;
  } catch {
    return false;
  } finally {
    if (fd !== null) {
      try { closeSync(fd); } catch {}
    }
  }
}

function writePendingSessionRegistration(pluginRoot, sessionId) {
  let cacheBaseFd = null;
  let stagePath = null;
  let stageStats = null;
  let stageContent = null;
  try {
    const target = livePinTarget(pluginRoot);
    if (!target) return false;
    const sessionHash = createHash('sha256').update(sessionId.trim()).digest('hex');
    const versionHash = livePinVersionHash(target.version);
    const baseStats = lstatSync(target.cacheBase);
    if (!baseStats.isDirectory() || baseStats.isSymbolicLink()) return false;
    let cacheBasePath = target.cacheBase;
    if (process.platform === 'linux') {
      cacheBaseFd = openSync(target.cacheBase, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW);
      const openedBaseStats = fstatSync(cacheBaseFd);
      if (!openedBaseStats.isDirectory() || !sameFileIdentity(openedBaseStats, baseStats)) return false;
      cacheBasePath = `/proc/self/fd/${cacheBaseFd}`;
    }
    const name = pendingSessionIntentName(target.version, sessionHash);
    const pendingPath = join(cacheBasePath, name);
    const content = `${JSON.stringify({ version: 1, cacheVersion: target.version, sessionHash })}\n`;
    const cacheBaseStillNamed = () => {
      if (process.platform === 'linux') return true;
      try {
        const current = lstatSync(target.cacheBase);
        return current.isDirectory() && !current.isSymbolicLink() && sameFileIdentity(current, baseStats);
      } catch {
        return false;
      }
    };
    try {
      const existingStats = lstatSync(pendingPath);
      if (!existingStats.isFile() || existingStats.isSymbolicLink() || (existingStats.nlink !== 1 && existingStats.nlink !== 2)) return false;
      const existing = readPendingSessionIntent(pendingPath, target.version, sessionHash);
      if (!existing || existing.stats.dev !== existingStats.dev || existing.stats.ino !== existingStats.ino) return false;
      if (!cacheBaseStillNamed()) return false;
      return renewPendingSessionRegistration(pendingPath, existingStats);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }

    stagePath = join(cacheBasePath, `${LIVE_PIN_INTENT_STAGE_PREFIX}${versionHash}-${sessionHash}-${process.pid}-${randomUUID()}`);
    writeFileSync(stagePath, content, { flag: 'wx', mode: 0o600 });
    stageStats = lstatSync(stagePath);
    stageContent = content;
    if (!cacheBaseStillNamed()) {
      removeVerifiedLockEntry(stagePath, stageStats, content);
      return false;
    }
    let published = false;
    try {
      linkSync(stagePath, pendingPath);
      published = true;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
    } finally {
      removeVerifiedLockEntry(stagePath, stageStats, content);
      stagePath = null;
      stageStats = null;
      stageContent = null;
    }
    if (!published) {
      const existing = readPendingSessionIntent(pendingPath, target.version, sessionHash);
      if (!existing || !sameFileIdentity(existing.stats, lstatSync(pendingPath))) return false;
      if (!renewPendingSessionRegistration(pendingPath, existing.stats)) return false;
    }
    if (!cacheBaseStillNamed()) return false;
    // This sidecar intent survives snapshot quarantine on every platform. The
    // lock-owning CLI writer commits the durable pin and then removes the intent.
    return true;
  } catch {
    return false;
  } finally {
    if (stagePath && stageStats && stageContent !== null) removeVerifiedLockEntry(stagePath, stageStats, stageContent);
    if (cacheBaseFd !== null) {
      try { closeSync(cacheBaseFd); } catch {}
    }
  }
}

function hasLiveSessionPin(pluginRoot, sessionId) {
  const sessionHash = createHash('sha256').update(sessionId.trim()).digest('hex');
  let pinState;
  try {
    pinState = livePinDirectory(pluginRoot);
  } catch {
    return true;
  }
  if (!pinState) return true;
  try {
    const lockPath = join(pinState.cacheBase, livePinMutationLockName(pinState.version));
    const mutationLock = readLivePinMutationLock(lockPath);
    if (mutationLock && !removeDeadLivePinMutationLock(lockPath, mutationLock)) return true;
    const entries = readdirSync(pinState.path, { withFileTypes: true });
    for (const entry of entries) {
      const pinPath = join(pinState.path, entry.name);
      let stats;
      try {
        stats = lstatSync(pinPath);
      } catch {
        return true;
      }
      const ageMs = Date.now() - stats.mtimeMs;
      if (entry.name.startsWith('.stage-')) {
        if (!stats.isFile() || stats.isSymbolicLink() || !Number.isFinite(ageMs) || ageMs < 0 || ageMs <= 5 * 60 * 1000) return true;
        continue;
      }
      if (entry.name.startsWith(LIVE_PIN_PENDING_PREFIX)) {
        const file = readPendingSessionRegistration(pinPath, entry.name.slice(LIVE_PIN_PENDING_PREFIX.length, -'.json'.length));
        if (!file || file.stats.dev !== stats.dev || file.stats.ino !== stats.ino) return true;
        continue;
      }
      if (!entry.isFile() || stats.isSymbolicLink() || stats.nlink !== 1 || stats.size <= 0 || stats.size > 4096) return true;
      const file = readNoFollowText(pinPath, 4096);
      if (!file || file.stats.dev !== stats.dev || file.stats.ino !== stats.ino) return true;
      let record;
      try { record = JSON.parse(file.content); } catch { return true; }
      if (
        record?.version !== 1
        || !Number.isSafeInteger(record.pid)
        || record.pid <= 0
        || (record.processStartHash !== null && (typeof record.processStartHash !== 'string' || !/^[0-9a-f]{24}$/.test(record.processStartHash)))
        || typeof record.sessionHash !== 'string'
        || !/^[0-9a-f]{64}$/.test(record.sessionHash)
      ) return true;
      if (isProcessAlive(record.pid)) {
        if (record.sessionHash === sessionHash) return true;
        continue;
      }
      try {
        unlinkSync(pinPath);
      } catch {
        return true;
      }
    }
    return false;
  } catch (error) {
    return error?.code !== 'ENOENT';
  } finally {
    closeLivePinDirectory(pinState);
  }
}

function writePendingSessionPin(pluginRoot, sessionId) {
  let pinState;
  let mutationLock;
  try {
    const target = livePinTarget(pluginRoot);
    if (!target) return null;
    mutationLock = acquireLivePinMutationLock(target, 'pin');
    if (!mutationLock) return null;
    pinState = livePinDirectory(pluginRoot);
    if (!pinState || pinState.version !== target.version || pinState.cacheBase !== target.cacheBase || !livePinRootMatches(pinState)) return null;
    const pinDir = pinState.path;
    try {
      mkdirSync(pinDir, { mode: 0o700 });
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
    }
    const pinDirStats = lstatSync(pinDir);
    if (!pinDirStats.isDirectory() || pinDirStats.isSymbolicLink()) return null;
    if (livePinRetirementGateExists(pinDir) || !livePinRootMatches(pinState) || !livePinMutationLockMatches(mutationLock)) return null;
    const sessionHash = createHash('sha256').update(sessionId.trim()).digest('hex');
    const record = {
      version: 1,
      pid: process.pid,
      processStartHash: null,
      sessionHash,
    };
    const content = `${JSON.stringify(record)}\n`;
    const stageName = `.stage-${process.pid}-${randomUUID()}`;
    const pinName = `pin-${process.pid}-${sessionHash}-${randomUUID()}.json`;
    const stagePath = join(pinDir, stageName);
    const pinPath = join(pinDir, pinName);
    const cleanupPath = join(pluginRoot, '.omx-live-pin', pinName);
    try {
      writeFileSync(stagePath, content, { flag: 'wx', mode: 0o600 });
      if (livePinRetirementGateExists(pinDir) || !livePinRootMatches(pinState) || !livePinMutationLockMatches(mutationLock)) {
        removePendingSessionPin(stagePath);
        return null;
      }
      renameSync(stagePath, pinPath);
      if (livePinRetirementGateExists(pinDir) || !livePinRootMatches(pinState) || !livePinMutationLockMatches(mutationLock)) {
        removePendingSessionPin(pinPath);
        return null;
      }
      return cleanupPath;
    } catch (error) {
      try { unlinkSync(stagePath); } catch {}
      throw error;
    }
  } catch {
    return null;
  } finally {
    releaseLivePinMutationLock(mutationLock);
    closeLivePinDirectory(pinState);
  }
}

function removePendingSessionPin(pinPath) {
  if (!pinPath) return;
  try {
    const stats = lstatSync(pinPath);
    if (stats.isFile() && !stats.isSymbolicLink()) unlinkSync(pinPath);
  } catch {}
}

function isTerminalOutcome(value) {
  return ['finish', 'finished', 'complete', 'completed', 'done', 'blocked', 'blocked-on-user', 'blocked_on_user', 'failed', 'fail', 'error', 'cancelled', 'canceled', 'cancel', 'aborted', 'abort', 'userinterlude', 'user-interlude', 'interrupted', 'interrupt', 'askuserquestion', 'ask-user-question', 'askuser', 'question'].includes(String(value ?? '').trim().toLowerCase());
}

function isTerminalRunStateForMode(state, mode) {
  if (!state) return false;
  const runMode = String(state.mode ?? '').trim();
  if (runMode && runMode !== mode) return false;
  return isTerminalOutcome(state.outcome)
    || isTerminalOutcome(state.run_outcome)
    || isTerminalOutcome(state.lifecycle_outcome)
    || isTerminalOutcome(state.terminal_outcome);
}

function sameLexicalFilePath(leftPath, rightPath) {
  const left = resolve(leftPath);
  const right = resolve(rightPath);
  return process.platform === 'win32'
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}

function canonicalPath(path) {
  const absolute = resolve(path);
  if (!existsSync(absolute)) return absolute;
  try {
    return typeof realpathSync.native === 'function' ? realpathSync.native(absolute) : realpathSync(absolute);
  } catch {
    return absolute;
  }
}

function sameFilePath(leftPath, rightPath) {
  return canonicalPath(leftPath) === canonicalPath(rightPath);
}

function isSessionStateAuthoritativeForCwd(state, cwd) {
  if (!isSafeSessionId(state?.session_id)) return false;
  const sessionCwd = typeof state.cwd === 'string' ? state.cwd.trim() : '';
  return !sessionCwd || sameFilePath(sessionCwd, cwd);
}

function listAuthoritativeStateBaseDirs(cwd) {
  if (process.env.OMX_TEAM_STATE_ROOT?.trim()) return [process.env.OMX_TEAM_STATE_ROOT.trim()];
  if (process.env.OMX_ROOT?.trim()) return [join(process.env.OMX_ROOT.trim(), '.omx', 'state')];
  if (process.env.OMX_STATE_ROOT?.trim()) return [join(process.env.OMX_STATE_ROOT.trim(), '.omx', 'state')];
  return [join(cwd, '.omx', 'state')];
}

function isSafeSessionId(sessionId) {
  return typeof sessionId === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(sessionId.trim());
}

function readCurrentSessionId(stateBaseDirs, cwd) {
  for (const stateDir of stateBaseDirs) {
    const session = readJsonFile(join(stateDir, 'session.json'));
    if (isSessionStateAuthoritativeForCwd(session, cwd)) return session.session_id.trim();
  }
  const envSessionId = process.env.OMX_SESSION_ID || process.env.CODEX_SESSION_ID;
  return isSafeSessionId(envSessionId) ? envSessionId.trim() : null;
}

function shouldContinueAutopilotState(state) {
  if (state?.active !== true) return false;
  return !(isTerminalOutcome(state.current_phase)
    || isTerminalOutcome(state.run_outcome)
    || isTerminalOutcome(state.lifecycle_outcome)
    || isTerminalOutcome(state.terminal_outcome)
    || isTerminalOutcome(state.outcome)
    || (typeof state.completed_at === 'string' && state.completed_at.trim() !== ''));
}

function hasActiveAutopilotStateForOversizedStop(input) {
  const text = input.toString('utf8');
  const cwd = extractTopLevelStringField(text, ['cwd']) || process.cwd();
  const stateBaseDirs = listAuthoritativeStateBaseDirs(cwd);
  const sessionId = readCurrentSessionId(stateBaseDirs, cwd);
  if (!isSafeSessionId(sessionId)) return false;

  const sessionDir = join(stateBaseDirs[0], 'sessions', sessionId.trim());
  const terminalRunState = readJsonFile(join(sessionDir, 'run-state.json'));
  if (isTerminalRunStateForMode(terminalRunState, 'autopilot')) return false;

  const sessionState = readJsonFile(join(sessionDir, 'autopilot-state.json'));
  return shouldContinueAutopilotState(sessionState);
}


function parseJsonObjectCandidate(text) {
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function isJsonObjectFragmentLine(text) {
  return text.startsWith('{') || text.endsWith('}') || /^"[^"]+"\s*:/.test(text);
}

function parseSingleJsonObjectOutput(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return null;
  const direct = parseJsonObjectCandidate(text);
  if (direct) return direct;

  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const lastLine = lines.at(-1);
  if (!lastLine || !lastLine.startsWith('{') || !lastLine.endsWith('}')) return null;
  for (const line of lines.slice(0, -1)) {
    if (parseJsonObjectCandidate(line) || isJsonObjectFragmentLine(line)) return null;
  }
  return parseJsonObjectCandidate(lastLine);
}

async function pinUnroutedSession(input, launcher, pluginRoot, pendingPin) {
  try {
    if (!launcher) return;
    const { command, argsPrefix } = launcher;
    const child = spawn(
      command,
      [...argsPrefix, 'codex-native-hook', '--plugin-cache-pin-only'],
      buildSpawnOptions(command, {
        OMX_PLUGIN_ROOT: pluginRoot,
        OMX_PLUGIN_CACHE_PIN_PENDING: '1',
      }),
    );
    child.stdout.resume();
    child.stderr.pipe(process.stderr);
    child.stdin.on('error', () => {});
    child.stdin.end(input);
    await new Promise((resolveChild) => {
      let settled = false;
      let killTimeout;
      const timeout = setTimeout(() => {
        if (settled) return;
        console.error('[oh-my-codex] live plugin cache pin helper timed out; a later hook may retry');
        child.kill('SIGTERM');
        child.stdin.destroy();
        child.stdout.destroy();
        child.stderr.unpipe(process.stderr);
        child.stderr.destroy();
        killTimeout = setTimeout(() => {
          if (settled) return;
          child.kill('SIGKILL');
          finish();
        }, LIVE_PIN_HELPER_KILL_GRACE_MS);
      }, LIVE_PIN_HELPER_TIMEOUT_MS);
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (killTimeout) clearTimeout(killTimeout);
        resolveChild();
      };
      child.once('error', (error) => {
        console.error(`[oh-my-codex] unable to launch live plugin cache pin writer: ${error.message}`);
        finish();
      });
      child.once('close', finish);
    });
  } catch (error) {
    console.error(`[oh-my-codex] unable to launch live plugin cache pin writer: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    removePendingSessionPin(pendingPin);
  }
}

async function main() {
  const pluginRoot = resolve(hookDir, '..');
  const doctorSmoke = process.env.OMX_NATIVE_HOOK_DOCTOR_SMOKE === '1';
  const startupPendingPin = doctorSmoke ? null : writePendingSessionPin(pluginRoot, `wrapper-${process.pid}-${randomUUID()}`);
  if (startupPendingPin) {
    process.once('exit', () => removePendingSessionPin(startupPendingPin));
  }

  let pinnedLauncherAtStart = null;
  let pinnedLauncherReadError = null;
  if (startupPendingPin || !hasLivePinMutationLock(pluginRoot)) {
    try {
      pinnedLauncherAtStart = readPinnedLauncher();
    } catch (error) {
      pinnedLauncherReadError = error;
    }
  }
  let configuredLauncherAtStart = null;
  let configuredLauncherError = null;
  try {
    configuredLauncherAtStart = process.env.OMX_NATIVE_HOOK_COMMAND
      ? { command: process.env.OMX_NATIVE_HOOK_COMMAND, argsPrefix: [] }
      : pinnedLauncherAtStart ?? { command: 'omx', argsPrefix: [] };
    if (!process.env.OMX_NATIVE_HOOK_COMMAND && pinnedLauncherReadError) {
      configuredLauncherError = pinnedLauncherReadError;
    }
  } catch (error) {
    configuredLauncherError = error;
  }

  const { input, oversized, totalBytes } = await readBoundedStdin({ drainOversized: true });
  const payload = parseHookPayload(input);
  const eventName = extractTopLevelHookEventName(input.toString('utf8'));
  const routedByLaunchCorrelation = isPluginHookRoutingSession(input, payload);
  const isStop = detectStopHookInput(input);
  const isSubagentStop = eventName === 'SubagentStop';
  const isCompact = detectCompactHookInput(input);
  const sessionId = payload?.session_id ?? payload?.sessionId;
  const sessionStart = (payload?.hook_event_name ?? payload?.hookEventName ?? payload?.event ?? payload?.name) === 'SessionStart';
  const validSessionId = !doctorSmoke
    && !oversized
    && typeof sessionId === 'string'
    && sessionId.trim().length > 0
    && sessionId.trim().length <= 256;
  const pendingRegistration = validSessionId && hasPendingSessionRegistration(pluginRoot, sessionId);
  let pinRegistrationPending = false;
  let pendingPin = null;
  if (validSessionId && (sessionStart || pendingRegistration || !hasLiveSessionPin(pluginRoot, sessionId))) {
    pinRegistrationPending = true;
    writePendingSessionRegistration(pluginRoot, sessionId);
    pendingPin = startupPendingPin ?? writePendingSessionPin(pluginRoot, sessionId);
  }

  if (!routedByLaunchCorrelation) {
    const pinLauncher = configuredLauncherAtStart;
    if (pinRegistrationPending) await pinUnroutedSession(input, pinLauncher, pluginRoot, pendingPin);
    writePlainCodexNoop(isStop || isSubagentStop);
    return;
  }

  if (oversized) {
    const message = `plugin hook stdin exceeded ${MAX_WRAPPER_STDIN_BYTES} bytes before launcher delegation; totalBytes>${totalBytes}`;
    if (isStop) {
      if (hasActiveAutopilotStateForOversizedStop(input)) {
        console.error(`[oh-my-codex] ${message}`);
        writeOversizedStopFallback('plugin_stop_hook_stdin_oversized_active_workflow', message);
        return;
      }
      writeOversizedStopNoop();
      return;
    }
    if (eventName === 'PreToolUse' || eventName === 'PostToolUse') {
      writeOversizedToolHookOutput(eventName);
      return;
    }
    if (eventName === 'SubagentStop') {
      writePlainCodexNoop(true);
      return;
    }
    console.error(`[oh-my-codex] ${message}`);
    process.exitCode = 1;
    return;
  }

  if (configuredLauncherError || !configuredLauncherAtStart) {
    removePendingSessionPin(pendingPin);
    failLauncher(configuredLauncherError ?? new Error('plugin hook launcher is unavailable'), isStop, isCompact, isSubagentStop);
    return;
  }

  const { command, argsPrefix } = configuredLauncherAtStart;
  const extraEnv = { OMX_PLUGIN_ROOT: pluginRoot };
  if (pinRegistrationPending) extraEnv.OMX_PLUGIN_CACHE_PIN_PENDING = '1';
  const child = spawn(
    command,
    [...argsPrefix, 'codex-native-hook'],
    buildSpawnOptions(command, extraEnv),
  );

  const stdoutChunks = [];
  let stdoutBytes = 0;
  let bufferedHookStdoutBytes = 0;
  let hookStdoutOversized = false;
  let childSpawnError = null;
  let childStdinError = null;

  child.stdout.on('data', (chunk) => {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    stdoutBytes += buffer.byteLength;
    if (isStop || isSubagentStop) {
      if (!hookStdoutOversized) {
        const remaining = MAX_BUFFERED_HOOK_STDOUT_BYTES - bufferedHookStdoutBytes;
        if (remaining > 0) {
          const slice = buffer.subarray(0, remaining);
          stdoutChunks.push(slice);
          bufferedHookStdoutBytes += slice.byteLength;
        }
        if (buffer.byteLength > remaining) {
          hookStdoutOversized = true;
          child.stdout.destroy();
          child.kill();
        }
      }
    } else if (!isCompact) {
      process.stdout.write(chunk);
    }
  });
  child.stderr.pipe(process.stderr);
  child.stdin.on('error', (error) => {
    childStdinError = error;
  });
  child.on('error', (error) => {
    childSpawnError = error;
    removePendingSessionPin(pendingPin);
  });
  child.on('close', (code, signal) => {
    removePendingSessionPin(pendingPin);
    if (isStop && hookStdoutOversized) {
      writeStopFallback('plugin_stop_hook_launcher_stdout_oversized', `codex-native-hook produced more than ${MAX_BUFFERED_HOOK_STDOUT_BYTES} bytes of Stop hook stdout`);
      return;
    }

    if (isSubagentStop) {
      if (!hookStdoutOversized && !childSpawnError && !childStdinError && !signal && code === 0) {
        const stdoutText = Buffer.concat(stdoutChunks).toString('utf8');
        const parsed = parseSingleJsonObjectOutput(stdoutText);
        if (parsed) {
          process.stdout.write(`${JSON.stringify(parsed)}\n`);
          process.exitCode = 0;
          return;
        }
      }
      writePlainCodexNoop(true);
      return;
    }

    if (isStop && stdoutBytes > 0) {
      const stdoutText = Buffer.concat(stdoutChunks).toString('utf8');
      const parsed = parseSingleJsonObjectOutput(stdoutText);
      if (parsed) {
        process.stdout.write(`${JSON.stringify(parsed)}\n`);
        process.exitCode = 0;
        return;
      }
      writeStopFallback('plugin_stop_hook_launcher_invalid_stdout', `codex-native-hook produced invalid Stop hook JSON stdout (${stdoutBytes} bytes)`);
      return;
    }

    if (isCompact) {
      process.exitCode = 0;
      return;
    }

    if (isStop && stdoutBytes === 0) {
      if (childSpawnError) {
        writeStopFallback('plugin_stop_hook_launcher_spawn_error', `failed to launch ${command} codex-native-hook: ${childSpawnError.message}`);
        return;
      }
      if (signal) {
        writeStopFallback('plugin_stop_hook_launcher_signal', `codex-native-hook terminated by ${signal}`);
        return;
      }
      if (code && code !== 0) {
        if (childStdinError) {
          writeStopFallback('plugin_stop_hook_launcher_stdin_error', `codex-native-hook stdin failed: ${childStdinError.message}`);
          return;
        }
        writeStopFallback('plugin_stop_hook_launcher_exit', `codex-native-hook exited with code ${code}`);
        return;
      }
      writeStopFallback('plugin_stop_hook_launcher_empty_stdout', 'codex-native-hook exited successfully without producing Stop hook JSON');
      return;
    }

    if (isCompact) {
      if (childSpawnError) {
        console.error(`[oh-my-codex] failed to launch ${command} codex-native-hook: ${childSpawnError.message}`);
      } else if (signal) {
        console.error(`[oh-my-codex] codex-native-hook terminated by ${signal}`);
      } else if (code && code !== 0) {
        console.error(`[oh-my-codex] codex-native-hook exited with code ${code}`);
      }
      process.exitCode = 0;
      return;
    }

    if (childSpawnError) {
      console.error(`[oh-my-codex] failed to launch ${command} codex-native-hook: ${childSpawnError.message}`);
      process.exitCode = 1;
      return;
    }
    if (signal) {
      console.error(`[oh-my-codex] codex-native-hook terminated by ${signal}`);
      process.exitCode = 1;
      return;
    }
    process.exitCode = code ?? 0;
  });

  child.stdin.end(input);
}

main().catch((error) => {
  console.error(`[oh-my-codex] plugin hook launcher failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
