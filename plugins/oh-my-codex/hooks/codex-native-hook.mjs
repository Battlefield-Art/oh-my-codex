#!/usr/bin/env node
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { extname } from 'node:path';
import { closeSync, constants as fsConstants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const hookDir = dirname(fileURLToPath(import.meta.url));
// sync-plugin-mirror verifies this stable marker; runtime behavior is tested separately.
const OMX_PLUGIN_HOOK_LAUNCHER_CONTRACT_MARKER = 'omx-plugin-hook-launcher:v1';
const OMX_PLUGIN_HOOK_ROUTING_ONLY_MARKER = 'omx-plugin-hook-routing-only:v1';
const MAX_WRAPPER_STDIN_BYTES = 1024 * 1024;
const RAW_EVENT_SCAN_BYTES = 64 * 1024;
const MAX_STOP_STDOUT_BYTES = 1024 * 1024;
const MAX_ROUTING_RECORD_BYTES = 4 * 1024;
const CODEX_HOOK_EVENT_NAMES = new Set([
  'SessionStart',
  'PreToolUse',
  'PostToolUse',
  'UserPromptSubmit',
  'PreCompact',
  'PostCompact',
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
      return ownerSessionId === sessionId || isChildRoutingSessionStart(payload, ownerSessionId);
    }
    mkdirSync(dirname(routingPath), { recursive: true });
    writeFileSync(routingPath, `${JSON.stringify({ routing: OMX_PLUGIN_HOOK_ROUTING_ONLY_MARKER, ownerSessionId: sessionId })}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    return true;
  } catch {
    return false;
  }
}

function writePlainCodexNoop(isStop) {
  if (isStop) process.stdout.write('{}\n');
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

function failLauncher(error, isStop, isCompact, stopReason = 'plugin_stop_hook_launcher_failure') {
  const detail = error instanceof Error ? error.message : String(error);
  console.error(`[oh-my-codex] ${detail}`);
  if (isStop) {
    writeStopFallback(stopReason, detail);
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

function livePinDirectory(pluginRoot) {
  const rootStats = lstatSync(pluginRoot);
  if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) return null;
  const manifest = readJsonFile(join(pluginRoot, '.codex-plugin', 'plugin.json'));
  if (
    manifest?.name !== 'oh-my-codex'
    || typeof manifest.version !== 'string'
    || !manifest.version
    || manifest.version === '.'
    || manifest.version === '..'
    || manifest.version.includes('/')
    || manifest.version.includes('\\')
    || manifest.version.includes('\0')
  ) return null;
  for (const marker of ['.omx-managed', '.omx-complete']) {
    const stats = lstatSync(join(pluginRoot, marker));
    if (!stats.isFile() || stats.isSymbolicLink()) return null;
  }
  const codexHome = process.env.CODEX_HOME || join(homedir(), '.codex');
  const expectedRoot = join(codexHome, 'plugins', 'cache', 'oh-my-codex-local', 'oh-my-codex', manifest.version);
  if (!sameFilePath(pluginRoot, expectedRoot)) return null;
  const pinDir = join(pluginRoot, '.omx-live-pin');
  try {
    const pinDirStats = lstatSync(pinDir);
    if (!pinDirStats.isDirectory() || pinDirStats.isSymbolicLink()) return null;
  } catch (error) {
    if (error?.code !== 'ENOENT') return null;
  }
  return pinDir;
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== 'ESRCH';
  }
}

function hasLiveSessionPin(pluginRoot, sessionId) {
  const sessionHash = createHash('sha256').update(sessionId.trim()).digest('hex');
  let pinDir;
  try {
    pinDir = livePinDirectory(pluginRoot);
  } catch {
    return true;
  }
  if (!pinDir) return true;
  let entries;
  try {
    entries = readdirSync(pinDir, { withFileTypes: true });
  } catch (error) {
    return error?.code !== 'ENOENT';
  }
  for (const entry of entries) {
    const pinPath = join(pinDir, entry.name);
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
    if (!entry.isFile() || stats.isSymbolicLink() || stats.nlink !== 1 || stats.size <= 0 || stats.size > 4096) return true;
    const record = readJsonFile(pinPath);
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
}

function writePendingSessionPin(pluginRoot, sessionId) {
  let pinDir;
  try {
    pinDir = livePinDirectory(pluginRoot);
    if (!pinDir) return null;
    mkdirSync(pinDir, { recursive: true, mode: 0o700 });
    const pinDirStats = lstatSync(pinDir);
    if (!pinDirStats.isDirectory() || pinDirStats.isSymbolicLink()) return null;
    const sessionHash = createHash('sha256').update(sessionId.trim()).digest('hex');
    const record = {
      version: 1,
      pid: process.pid,
      processStartHash: null,
      sessionHash,
    };
    const content = `${JSON.stringify(record)}\n`;
    const stagePath = join(pinDir, `.stage-${process.pid}-${randomUUID()}`);
    const pinPath = join(pinDir, `pin-${process.pid}-${sessionHash}-${randomUUID()}.json`);
    try {
      writeFileSync(stagePath, content, { flag: 'wx', mode: 0o600 });
      renameSync(stagePath, pinPath);
      return pinPath;
    } catch (error) {
      try { unlinkSync(stagePath); } catch {}
      throw error;
    }
  } catch {
    return null;
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
      const finish = () => {
        if (settled) return;
        settled = true;
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
  const startupPendingPin = writePendingSessionPin(pluginRoot, `wrapper-${process.pid}-${randomUUID()}`);
  if (startupPendingPin) {
    process.once('exit', () => removePendingSessionPin(startupPendingPin));
  }

  let pinnedLauncherAtStart = null;
  let pinnedLauncherReadError = null;
  try {
    pinnedLauncherAtStart = readPinnedLauncher();
  } catch (error) {
    pinnedLauncherReadError = error;
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
  const routedByLaunchCorrelation = isPluginHookRoutingSession(input, payload);
  const isStop = detectStopHookInput(input);
  const isCompact = detectCompactHookInput(input);
  const sessionId = payload?.session_id ?? payload?.sessionId;
  let pendingPin = null;
  if (
    !oversized
    && typeof sessionId === 'string'
    && sessionId.trim()
    && sessionId.trim().length <= 256
    && !hasLiveSessionPin(pluginRoot, sessionId)
  ) {
    pendingPin = startupPendingPin ?? writePendingSessionPin(pluginRoot, sessionId);
  }

  if (!routedByLaunchCorrelation) {
    if (pendingPin) await pinUnroutedSession(input, pinnedLauncherAtStart, pluginRoot, pendingPin);
    writePlainCodexNoop(isStop);
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
    const eventName = extractTopLevelHookEventName(input.toString('utf8'));
    if (eventName === 'PreToolUse' || eventName === 'PostToolUse') {
      writeOversizedToolHookOutput(eventName);
      return;
    }
    console.error(`[oh-my-codex] ${message}`);
    process.exitCode = 1;
    return;
  }

  if (configuredLauncherError || !configuredLauncherAtStart) {
    removePendingSessionPin(pendingPin);
    failLauncher(configuredLauncherError ?? new Error('plugin hook launcher is unavailable'), isStop, isCompact);
    return;
  }

  const { command, argsPrefix } = configuredLauncherAtStart;
  const extraEnv = { OMX_PLUGIN_ROOT: pluginRoot };
  if (pendingPin) extraEnv.OMX_PLUGIN_CACHE_PIN_PENDING = '1';
  const child = spawn(
    command,
    [...argsPrefix, 'codex-native-hook'],
    buildSpawnOptions(command, extraEnv),
  );

  const stdoutChunks = [];
  let stdoutBytes = 0;
  let bufferedStopStdoutBytes = 0;
  let stopStdoutOversized = false;
  let childSpawnError = null;
  let childStdinError = null;

  child.stdout.on('data', (chunk) => {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    stdoutBytes += buffer.byteLength;
    if (isStop) {
      if (!stopStdoutOversized) {
        const remaining = MAX_STOP_STDOUT_BYTES - bufferedStopStdoutBytes;
        if (remaining > 0) {
          const slice = buffer.subarray(0, remaining);
          stdoutChunks.push(slice);
          bufferedStopStdoutBytes += slice.byteLength;
        }
        if (buffer.byteLength > remaining) {
          stopStdoutOversized = true;
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
    if (isStop && stopStdoutOversized) {
      writeStopFallback('plugin_stop_hook_launcher_stdout_oversized', `codex-native-hook produced more than ${MAX_STOP_STDOUT_BYTES} bytes of Stop hook stdout`);
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
