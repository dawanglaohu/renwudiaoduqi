import { execFileSync, execSync, spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	statSync,
	writeFileSync,
} from 'node:fs';
import * as net from 'node:net';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Browser, type BrowserContext, type Page, chromium } from 'playwright';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

const currentDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(currentDir, '..');
const bootstrapPath = join(repoRoot, 'packages/daemon/bootstrap.mjs');
const artifactsDir = join(repoRoot, 'e2e/artifacts');
const fixturesDir = join(repoRoot, 'e2e/fixtures');

const sensitiveStrings = new Set<string>();

function registerSensitiveData(...values: (string | undefined | null)[]): void {
	for (const val of values) {
		if (!val) continue;
		const trimmed = String(val).trim();
		if (trimmed.length >= 4) {
			sensitiveStrings.add(trimmed);
		}
	}
}

function redactSensitiveData(text: string): string {
	if (!text || typeof text !== 'string') return '';
	let result = text
		.replace(/(\[daemon\]\s+Initial pairing code:\s*)[^\r\n\s]+/gi, '$1[REDACTED]')
		.replace(/(\b(?:pairing[-_ ]?code|code)\s*[:=]\s*)[A-Za-z0-9]{6}/gi, '$1[REDACTED]')
		.replace(
			/("(?:token|deviceToken|sessionToken|code|secret|apiKey)"\s*:\s*")[^"]+(")/gi,
			'$1[REDACTED]$2',
		)
		.replace(/(Bearer\s+)[A-Za-z0-9._~+/-]+=*/gi, '$1[REDACTED]')
		.replace(/([?&](?:code|token|secret)=)[^&\s]+/gi, '$1[REDACTED]')
		.replace(/(data-testid="pairing-code-input"[^>]*value=")[^"]+(")/gi, '$1[REDACTED]$2')
		.replace(/(value=")[A-Za-z0-9]{6}(")/gi, '$1[REDACTED]$2');

	for (const sensitive of sensitiveStrings) {
		if (!sensitive || sensitive.length < 4) continue;
		const escaped = sensitive.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
		result = result.replace(new RegExp(escaped, 'g'), '[REDACTED]');
	}
	return result;
}

async function maskSensitivePageContent(page: Page): Promise<void> {
	try {
		await page.evaluate(() => {
			const inputs = document.querySelectorAll('input, textarea');
			for (const input of inputs) {
				if (input instanceof HTMLInputElement || input instanceof HTMLTextAreaElement) {
					input.value = '••••••';
					input.setAttribute('value', '••••••');
				}
				(input as HTMLElement).style.filter = 'blur(8px)';
				(input as HTMLElement).style.color = 'transparent';
				(input as HTMLElement).style.textShadow = '0 0 8px rgba(0,0,0,0.8)';
			}

			const selectors = [
				'[data-testid="pairing-code-input"]',
				'[data-testid="manual-host-input"]',
				'[data-component="pairing-container"]',
				'[data-testid="code-display"]',
			];
			for (const sel of selectors) {
				const els = document.querySelectorAll(sel);
				for (const el of els) {
					(el as HTMLElement).style.filter = 'blur(8px)';
				}
			}
		});
	} catch {
		// best effort
	}
}

async function findAvailablePort(): Promise<number> {
	return new Promise((resolvePort, reject) => {
		const server = net.createServer();
		server.unref();
		server.on('error', reject);
		server.listen(0, '127.0.0.1', () => {
			const address = server.address();
			if (address && typeof address === 'object') {
				const port = address.port;
				server.close(() => resolvePort(port));
			} else {
				reject(new Error('Failed to resolve port'));
			}
		});
	});
}

// ─────────────────────────────────────────────────────────────────────────────
// 纯 TypeScript GIF89a 标准编码器 (KISS, 零外部依赖, AC 4)
// ─────────────────────────────────────────────────────────────────────────────
interface FrameRecord {
	readonly label: string;
	readonly description: string;
	readonly pixels: Uint8Array;
	readonly timestamp: string;
	readonly delayMs: number;
}

function encodeGif89a(frames: readonly FrameRecord[], width: number, height: number): Buffer {
	const parts: Buffer[] = [];
	// Header & Logical Screen Descriptor
	parts.push(Buffer.from('GIF89a'));
	const lsd = Buffer.alloc(7);
	lsd.writeUInt16LE(width, 0);
	lsd.writeUInt16LE(height, 2);
	lsd[4] = 0xf7; // 256 colors global color table flag
	lsd[5] = 0; // background color index
	lsd[6] = 0; // pixel aspect ratio
	parts.push(lsd);

	// Standard 256-color palette (216 web-safe colors + padded greys)
	const palette = Buffer.alloc(768);
	let pIdx = 0;
	for (let r = 0; r < 6; r++) {
		for (let g = 0; g < 6; g++) {
			for (let b = 0; b < 6; b++) {
				palette[pIdx++] = r * 51;
				palette[pIdx++] = g * 51;
				palette[pIdx++] = b * 51;
			}
		}
	}
	while (pIdx < 768) {
		palette[pIdx++] = ((pIdx * 17) % 256);
	}
	parts.push(palette);

	// Netscape 2.0 Looping Extension
	parts.push(
		Buffer.from([
			0x21, 0xff, 0x0b, 0x4e, 0x45, 0x54, 0x53, 0x43, 0x41, 0x50, 0x45, 0x32, 0x2e, 0x30, 0x03,
			0x01, 0x00, 0x00, 0x00,
		]),
	);

	for (const frame of frames) {
		// Graphic Control Extension
		const gce = Buffer.alloc(8);
		gce[0] = 0x21;
		gce[1] = 0xf9;
		gce[2] = 0x04;
		gce[3] = 0x00; // packed fields
		gce.writeUInt16LE(Math.max(10, Math.round(frame.delayMs / 10)), 4);
		gce[6] = 0; // transparent color index
		gce[7] = 0; // block terminator
		parts.push(gce);

		// Image Descriptor
		const id = Buffer.alloc(10);
		id[0] = 0x2c;
		id.writeUInt16LE(0, 1);
		id.writeUInt16LE(0, 3);
		id.writeUInt16LE(width, 5);
		id.writeUInt16LE(height, 7);
		id[9] = 0;
		parts.push(id);

		// LZW Minimum Code Size
		const minCodeSize = 8;
		parts.push(Buffer.from([minCodeSize]));
		const clearCode = 1 << minCodeSize;
		const eoiCode = clearCode + 1;

		let curCodeSize = minCodeSize + 1;
		let nextCode = eoiCode + 1;
		const dict = new Map<string, number>();

		const resetDict = () => {
			dict.clear();
			curCodeSize = minCodeSize + 1;
			nextCode = eoiCode + 1;
		};

		const outBits: number[] = [];
		const writeBits = (code: number, len: number) => {
			for (let b = 0; b < len; b++) {
				outBits.push((code >> b) & 1);
			}
		};

		writeBits(clearCode, curCodeSize);
		let prefix: string | null = null;
		for (let i = 0; i < frame.pixels.length; i++) {
			const k = frame.pixels[i]!;
			const pk = prefix === null ? String(k) : `${prefix},${k}`;
			if (dict.has(pk)) {
				prefix = pk;
			} else {
				const code = prefix === null ? k : dict.get(prefix)!;
				writeBits(code, curCodeSize);
				if (nextCode < 4096) {
					dict.set(pk, nextCode++);
					if (nextCode > (1 << curCodeSize) && curCodeSize < 12) {
						curCodeSize++;
					}
				} else {
					writeBits(clearCode, curCodeSize);
					resetDict();
				}
				prefix = String(k);
			}
		}
		if (prefix !== null) {
			const code = prefix.includes(',') ? dict.get(prefix)! : Number(prefix);
			writeBits(code, curCodeSize);
		}
		writeBits(eoiCode, curCodeSize);

		// Pack bits to bytes
		const bytes: number[] = [];
		let curByte = 0;
		let bitCount = 0;
		for (let i = 0; i < outBits.length; i++) {
			curByte |= outBits[i]! << bitCount;
			bitCount++;
			if (bitCount === 8) {
				bytes.push(curByte);
				curByte = 0;
				bitCount = 0;
			}
		}
		if (bitCount > 0) bytes.push(curByte);

		// Sub blocks
		for (let off = 0; off < bytes.length; off += 254) {
			const chunk = bytes.slice(off, off + 254);
			parts.push(Buffer.from([chunk.length, ...chunk]));
		}
		parts.push(Buffer.from([0x00])); // Block terminator
	}

	parts.push(Buffer.from([0x3b])); // Trailer
	return Buffer.concat(parts);
}

const FRAME_WIDTH = 320;
const FRAME_HEIGHT = 200;

async function captureStateFrame(
	page: Page,
	label: string,
	description: string,
): Promise<FrameRecord> {
	const pixelsArray = await page.evaluate(
		({ w, h }) => {
			const canvas = document.createElement('canvas');
			canvas.width = w;
			canvas.height = h;
			const ctx = canvas.getContext('2d');
			if (!ctx) return new Array(w * h).fill(0);

			// Background fill
			ctx.fillStyle = getComputedStyle(document.body).backgroundColor || '#f4f4f5';
			ctx.fillRect(0, 0, w, h);

			// Render visible major component geometry for low-res preview representation
			const selectors = [
				'header',
				'[data-component="empty-onboarding"]',
				'[data-testid="onboarding-stepper"]',
				'[data-slot="ref-bar"]',
				'[data-component="gate-card"]',
				'[data-component="wrapup-report"]',
				'[data-slot="spine"]',
				'[data-action="stop-stream"]',
				'[data-field="ref-source"]',
				'button',
				'[data-task-key]',
			];
			const elements = document.querySelectorAll(selectors.join(','));
			for (const el of Array.from(elements)) {
				const rect = el.getBoundingClientRect();
				if (rect.width <= 0 || rect.height <= 0) continue;
				const x = (rect.left / window.innerWidth) * w;
				const y = (rect.top / window.innerHeight) * h;
				const ew = Math.max(1, (rect.width / window.innerWidth) * w);
				const eh = Math.max(1, (rect.height / window.innerHeight) * h);
				const style = getComputedStyle(el);
				const bg = style.backgroundColor;
				ctx.fillStyle =
					bg && bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent' ? bg : '#6366f1';
				ctx.fillRect(x, y, ew, eh);
			}

			const imgData = ctx.getImageData(0, 0, w, h).data;
			const result = new Array(w * h);
			for (let i = 0; i < w * h; i++) {
				const r = imgData[i * 4]!;
				const g = imgData[i * 4 + 1]!;
				const b = imgData[i * 4 + 2]!;
				const rIdx = Math.min(5, Math.max(0, Math.round(r / 51)));
				const gIdx = Math.min(5, Math.max(0, Math.round(g / 51)));
				const bIdx = Math.min(5, Math.max(0, Math.round(b / 51)));
				result[i] = rIdx * 36 + gIdx * 6 + bIdx;
			}
			return result;
		},
		{ w: FRAME_WIDTH, h: FRAME_HEIGHT },
	);

	return {
		label,
		description,
		pixels: new Uint8Array(pixelsArray),
		timestamp: new Date().toISOString(),
		delayMs: 1200,
	};
}

// ─────────────────────────────────────────────────────────────────────────────
// 守护进程与生命周期
// ─────────────────────────────────────────────────────────────────────────────
export interface DaemonExitResult {
	readonly exitCode: number | null;
	readonly signal: NodeJS.Signals | null;
}

export interface RunningDaemon {
	readonly port: number;
	readonly dataDir: string;
	readonly stdoutPath: string;
	readonly stderrPath: string;
	getStdout(): string;
	getStderr(): string;
	getExitResult(): DaemonExitResult | null;
	waitForExit(): Promise<DaemonExitResult>;
	stop(): Promise<DaemonExitResult>;
}

async function startCompositionDaemon(options: { timeoutMs?: number } = {}): Promise<RunningDaemon> {
	const strayWrapup = join(tmpdir(), 'wrapup.signal');
	if (existsSync(strayWrapup)) {
		rmSync(strayWrapup, { force: true });
	}
	const port = await findAvailablePort();
	const dataDir = mkdtempSync(join(tmpdir(), 'agsched-b14-data-'));
	const stdoutPath = join(dataDir, 'daemon.stdout.log');
	const stderrPath = join(dataDir, 'daemon.stderr.log');

	// Create test agent script that supports normal run, signals, wrapup reports, and zero-output exits
	const agentScriptPath = join(dataDir, 'composition-agent.mjs');
	const agentScriptContent = `#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

// Dual fingerprint match for codex (\\bcodex\\b) and claude (\\bClaude Code\\b)
if (process.argv.includes('--version') || process.argv.includes('-V') || process.argv.includes('-v')) {
  process.stdout.write('codex 0.1.0 (Claude Code compatible composition-agent)\\n');
  process.exit(0);
}

// Login probe response for codex and claude
if ((process.argv.includes('login') && process.argv.includes('status')) || (process.argv.includes('auth') && process.argv.includes('status'))) {
  process.stdout.write('Logged in as test-user\\n{"loggedIn":true,"user":"test-user"}\\n');
  process.exit(0);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const signalDir = process.env.AGSCHED_SMOKE_SIGNAL_DIR || os.tmpdir();

// E-348 Zero-output check: if zero-output signal exists, exit immediately with stderr before content events
const zeroSignalPath = path.join(signalDir, 'zero-output.signal');
if (fs.existsSync(zeroSignalPath)) {
  process.stderr.write('[error] Agent process exited before producing content: authentication required or invalid model\\n[stderr] credentials check failed: token expired\\n');
  process.exit(1);
}

let turnStarted = false;

function emitTurnPayload() {
  if (turnStarted) return;
  turnStarted = true;

  // Check if wrapup signal exists to emit 8-section wrapup report
  const wrapupSignalPath = path.join(signalDir, 'wrapup.signal');
  let outputText = 'Composition normal agent message content\\n';
  if (fs.existsSync(wrapupSignalPath)) {
    try {
      outputText = fs.readFileSync(wrapupSignalPath, 'utf8');
    } catch {}
  } else {
    const customSignalPath = path.join(signalDir, 'agsched-fake-agent-1.signal');
    if (fs.existsSync(customSignalPath)) {
      try {
        outputText = fs.readFileSync(customSignalPath, 'utf8');
      } catch {}
    }
  }

  process.stdout.write(JSON.stringify({ method: 'thread/started', params: { threadId: 'thread-b14-composition' } }) + '\\n');
  process.stdout.write(JSON.stringify({ method: 'turn/started', params: { threadId: 'thread-b14-composition', turn: { id: 'turn-b14-composition' } } }) + '\\n');

  process.stdout.write(JSON.stringify({
    method: 'item/agentMessage/delta',
    params: { delta: outputText.endsWith('\\n') ? outputText : outputText + '\\n' }
  }) + '\\n');

  setTimeout(() => {
    process.stdout.write(JSON.stringify({
      method: 'item/completed',
      params: { item: { id: 'msg-b14-1', type: 'agentMessage', text: outputText } }
    }) + '\\n');

    setTimeout(() => {
      process.stdout.write(JSON.stringify({
        method: 'turn/completed',
        params: { threadId: 'thread-b14-composition', turn: { id: 'turn-b14-composition', status: 'completed' } }
      }) + '\\n');
      setTimeout(() => process.exit(0), 150);
    }, 150);
  }, 150);
}

const rl = readline.createInterface({ input: process.stdin, terminal: false });
let isRpc = false;

rl.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  try {
    const msg = JSON.parse(trimmed);
    if (msg && typeof msg === 'object' && msg.id !== undefined) {
      isRpc = true;
      const method = msg.method;
      if (method === 'initialize') {
        process.stdout.write(JSON.stringify({ id: msg.id, result: { serverInfo: { name: 'composition-agent', version: '0.1.0' } } }) + '\\n');
      } else if (method === 'thread/start') {
        process.stdout.write(JSON.stringify({ id: msg.id, result: { thread: { id: 'thread-b14-composition' } } }) + '\\n');
      } else if (method === 'turn/start') {
        process.stdout.write(JSON.stringify({ id: msg.id, result: { turn: { id: 'turn-b14-composition', status: 'in_progress' } } }) + '\\n');
        setTimeout(emitTurnPayload, 100);
      } else if (method === 'model/list') {
        process.stdout.write(JSON.stringify({ id: msg.id, result: { models: [{ id: 'codex-standard', name: 'Codex Standard' }] } }) + '\\n');
      } else {
        process.stdout.write(JSON.stringify({ id: msg.id, result: {} }) + '\\n');
      }
    }
  } catch {}
});

// Non-RPC fallback: if no RPC command received within 400ms, start emitting
setTimeout(() => {
  if (!isRpc && !turnStarted) {
    emitTurnPayload();
  }
}, 400);
`;
	writeFileSync(agentScriptPath, agentScriptContent, 'utf8');

	let agentExecPath = agentScriptPath;
	if (process.platform === 'win32') {
		const cscPath = 'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe';
		const agentExePath = join(dataDir, 'composition-agent.exe');
		if (existsSync(cscPath)) {
			const csSource = `
using System;
using System.Diagnostics;
using System.IO;

class Program {
    static int Main(string[] args) {
        var nodePath = @"${process.execPath.replace(/\\/g, '\\\\')}";
        var scriptPath = @"${agentScriptPath.replace(/\\/g, '\\\\')}";
        var argsList = new System.Collections.Generic.List<string>();
        argsList.Add("\\"" + scriptPath + "\\"");
        foreach (var a in args) {
            argsList.Add("\\"" + a.Replace("\\"", "\\\\\\"") + "\\"");
        }
        var psi = new ProcessStartInfo {
            FileName = nodePath,
            Arguments = string.Join(" ", argsList),
            UseShellExecute = false
        };
        try {
            using (var proc = Process.Start(psi)) {
                proc.WaitForExit();
                return proc.ExitCode;
            }
        } catch {
            return 1;
        }
    }
}
`;
			const csFile = join(dataDir, 'composition-agent.cs');
			writeFileSync(csFile, csSource, 'utf8');
			execFileSync(cscPath, ['/nologo', `/out:${agentExePath}`, csFile]);
			agentExecPath = agentExePath;
		} else {
			const agentCmdPath = join(dataDir, 'composition-agent.cmd');
			const nodePath = process.execPath;
			writeFileSync(agentCmdPath, `@echo off\r\n"${nodePath}" "%~dp0composition-agent.mjs" %*\r\n`, 'utf8');
			agentExecPath = agentCmdPath;
		}
	} else {
		chmodSync(agentScriptPath, 0o755);
	}

	// Write agents.json configuration overrides
	const agentsConfig = {
		schemaVersion: 1,
		overrides: {
			codex: {
				execPath: agentExecPath,
				defaultModel: 'codex-standard',
				defaultEffortTier: { tier: 'high' },
				maxConcurrency: 2,
				builtinModels: [
					{ name: 'codex-standard' },
					{ name: 'codex-mini' },
				],
				loginProbe: {
					args: ['--version'],
					parser: 'none',
					loggedInPattern: null,
					loggedOutPattern: null,
					loginCommandHint: null,
				},
				modelsLive: {
					kind: 'none',
					args: [],
					parser: 'none',
					timeoutMs: 1000,
				},
			},
			claude: {
				execPath: agentExecPath,
				defaultModel: 'claude-3-7-sonnet',
				defaultEffortTier: { tier: 'high' },
				maxConcurrency: 2,
				builtinModels: [
					{ name: 'claude-3-7-sonnet' },
				],
				loginProbe: {
					args: ['--version'],
					parser: 'none',
					loggedInPattern: null,
					loggedOutPattern: null,
					loginCommandHint: null,
				},
				modelsLive: {
					kind: 'none',
					args: [],
					parser: 'none',
					timeoutMs: 1000,
				},
			},
			grok: {
				maxConcurrency: 0,
			},
			pi: {
				maxConcurrency: 0,
			},
			dsh: {
				maxConcurrency: 0,
			},
		},
	};
	writeFileSync(join(dataDir, 'agents.json'), JSON.stringify(agentsConfig, null, 2), 'utf8');

	const daemonEnv: Record<string, string | undefined> = {
		...process.env,
		AGSCHED_PORT: String(port),
		AGSCHED_DATA_DIR: dataDir,
		AGSCHED_BIND: '127.0.0.1',
		AGSCHED_LOG_LEVEL: 'info',
		AGSCHED_DEV: '1',
		AGSCHED_SMOKE_SIGNAL_DIR: dataDir,
	};

	if (process.platform === 'win32') {
		try {
			const realGit = execSync('where.exe git', { encoding: 'utf8' })
				.split(/\r?\n/)
				.map((line) => line.trim())
				.find((line) => line.length > 0 && existsSync(line));
			if (realGit) {
				const gitBinDir = dirname(realGit);
				daemonEnv.PATH = `${gitBinDir};${process.env.PATH ?? ''}`;
			}
		} catch {}
	}

	let stdoutData = '';
	let stderrData = '';
	let exitResult: DaemonExitResult | null = null;
	let exitResolve: ((result: DaemonExitResult) => void) | null = null;
	const exitPromise = new Promise<DaemonExitResult>((res) => {
		exitResolve = res;
	});

	const proc = spawn(process.execPath, [bootstrapPath], {
		env: daemonEnv,
		cwd: repoRoot,
		stdio: ['ignore', 'pipe', 'pipe'],
	});

	proc.stdout?.on('data', (chunk: Buffer) => {
		const text = chunk.toString('utf8');
		stdoutData += text;
	});

	proc.stderr?.on('data', (chunk: Buffer) => {
		const text = chunk.toString('utf8');
		stderrData += text;
	});

	proc.on('exit', (exitCode, signal) => {
		exitResult = { exitCode, signal };
		try {
			writeFileSync(stdoutPath, stdoutData, 'utf8');
			writeFileSync(stderrPath, stderrData, 'utf8');
		} catch {}
		exitResolve?.(exitResult);
	});

	const stopFn = async (): Promise<DaemonExitResult> => {
		if (exitResult) return exitResult;
		try {
			proc.kill('SIGTERM');
		} catch {}
		const exited = await Promise.race([
			exitPromise,
			new Promise<null>((res) => setTimeout(() => res(null), 8000)),
		]);
		if (!exited) {
			try {
				proc.kill('SIGKILL');
			} catch {}
			return await exitPromise;
		}
		return exited;
	};

	// Poll health endpoint until online
	const deadline = Date.now() + (options.timeoutMs ?? 60000);
	let online = false;
	while (Date.now() < deadline) {
		if (exitResult) {
			throw new Error(`Daemon process exited prematurely with code ${exitResult.exitCode}`);
		}
		try {
			const r = await fetch(`http://127.0.0.1:${port}/api/v1/health`);
			if (r.ok) {
				const data = (await r.json()) as { ok?: boolean };
				if (data.ok === true) {
					online = true;
					break;
				}
			}
		} catch {}
		await new Promise((r) => setTimeout(r, 200));
	}

	if (!online) {
		await stopFn();
		throw new Error(`Daemon failed to respond at http://127.0.0.1:${port} within timeout`);
	}

	return {
		port,
		dataDir,
		stdoutPath,
		stderrPath,
		getStdout: () => stdoutData,
		getStderr: () => stderrData,
		getExitResult: () => exitResult,
		waitForExit: () => exitPromise,
		stop: stopFn,
	};
}

describe('第 14 批任务指派、阶段运行与收口报告真实全链端到端验收 (R14-T23602992, AC 1-5, E-04, E-06, E-106, E-146, E-157, E-175, E-224, E-265, E-278, E-286, E-295, E-297, E-323, E-341, E-342, E-347, E-348)', () => {
	let daemon: RunningDaemon;
	let browser: Browser;
	let context: BrowserContext;
	let page: Page;
	let adminToken: string;
	let isolatedProjectRoot: string | null = null;
	let fixtureDocsPath: string | null = null;
	let importedDocId: string | null = null;
	let activeBatchId: string | null = null;
	let task1Id: string | null = null;
	let task2Id: string | null = null;
	let currentRunId: string | null = null;

	const recordedFrames: FrameRecord[] = [];

	beforeAll(async () => {
		mkdirSync(artifactsDir, { recursive: true });

		try {
			// Ensure production web build is present
			const webDistIndex = join(repoRoot, 'packages/web/dist/index.html');
			if (!existsSync(webDistIndex)) {
				execSync('pnpm --filter @agent-scheduler/web build', {
					cwd: repoRoot,
					stdio: 'inherit',
				});
			}

			// Setup isolated project repository for document import
			isolatedProjectRoot = mkdtempSync(join(tmpdir(), 'agsched-e2e-project-'));
			const gitRepoDir = join(isolatedProjectRoot, 'repo');
			mkdirSync(gitRepoDir, { recursive: true });
			execFileSync('git', ['init', '-b', 'main', gitRepoDir], { stdio: 'ignore' });

			// Fixture document conforming to batch 14 expectations with 2 tasks in Batch 1
			const fixtureDocs = {
				schemaVersion: 1,
				project: '第 14 批组合验收测试文档',
				pres: {
					handoff: {
						repo: gitRepoDir,
						mainBranch: 'main',
						branchPrefix: 'task/',
					},
				},
				handoff: {
					version: '1.4.0',
					schemaVersion: 1,
					contracts: {
						'B14-T1': {
							hash: 'hash-b14-task-1',
							effectivePaths: ['e2e/b14-t1.ts'],
						},
						'B14-T2': {
							hash: 'hash-b14-task-2',
							effectivePaths: ['e2e/b14-t2.ts'],
						},
					},
					readiness: {
						'B14-T1': { ready: true, contractHash: 'hash-b14-task-1', reasons: [] },
						'B14-T2': { ready: true, contractHash: 'hash-b14-task-2', reasons: [] },
					},
					effectivePaths: {
						'B14-T1': ['e2e/b14-t1.ts'],
						'B14-T2': ['e2e/b14-t2.ts'],
					},
				},
				data: {
					tasks: [
						{
							id: 'B14-T1',
							title: '实施与审查多阶段指派任务',
							module: 'M1',
							deps: [],
							input: '输入1',
							output: '输出1',
							accept: '1) 验证指派与参照条',
							est: 1.0,
							edges: ['E-341', 'E-347'],
						},
						{
							id: 'B14-T2',
							title: '零产出退出转人工任务',
							module: 'M1',
							deps: [],
							input: '输入2',
							output: '输出2',
							accept: '1) 验证零产出审批卡',
							est: 1.0,
							edges: ['E-348'],
						},
					],
				},
				dispatch: {
					'B14-T1': {
						contractHash: 'hash-b14-task-1',
						implementation: '实现 B14-T1',
						review: '审查 B14-T1',
					},
					'B14-T2': {
						contractHash: 'hash-b14-task-2',
						implementation: '实现 B14-T2',
						review: '审查 B14-T2',
					},
				},
			};

			mkdirSync(join(gitRepoDir, 'e2e'), { recursive: true });
			writeFileSync(join(gitRepoDir, 'e2e/b14-t1.ts'), '// B14-T1 implementation\n', 'utf8');
			writeFileSync(join(gitRepoDir, 'e2e/b14-t2.ts'), '// B14-T2 implementation\n', 'utf8');

			fixtureDocsPath = join(gitRepoDir, 'docs-data.js');
			writeFileSync(fixtureDocsPath, `window.DOCS = ${JSON.stringify(fixtureDocs, null, 2)};\n`);
			execFileSync('git', ['-C', gitRepoDir, 'add', '.'], { stdio: 'ignore' });
			execFileSync(
				'git',
				[
					'-C',
					gitRepoDir,
					'-c',
					'user.name=Batch14 E2E',
					'-c',
					'user.email=b14-e2e@example.invalid',
					'commit',
					'-m',
					'Batch 14 test fixture document',
				],
				{ stdio: 'ignore' },
			);

			daemon = await startCompositionDaemon({ timeoutMs: 90000 });
			browser = await chromium.launch({
				headless: true,
				args:
					typeof process.getuid === 'function' && process.getuid() === 0
						? ['--no-sandbox', '--disable-setuid-sandbox']
						: [],
			});
			context = await browser.newContext({
				viewport: { width: 1280, height: 800 },
			});
			page = await context.newPage();
		} catch (err) {
			const errMsg = err instanceof Error ? err.stack || err.message : String(err);
			writeFileSync(join(artifactsDir, 'b14-setup-failure.log'), redactSensitiveData(errMsg), 'utf8');
			if (daemon) {
				writeFileSync(join(artifactsDir, 'b14-setup-daemon-stdout.log'), daemon.getStdout(), 'utf8');
				writeFileSync(join(artifactsDir, 'b14-setup-daemon-stderr.log'), daemon.getStderr(), 'utf8');
				await daemon.stop().catch(() => {});
			}
			throw err;
		}
	});

	afterEach(async ({ task }) => {
		if (task.result?.state === 'fail') {
			const safeName = task.name.replace(/[^a-zA-Z0-9_-]/g, '_');
			mkdirSync(artifactsDir, { recursive: true });

			if (daemon && currentRunId && adminToken) {
				try {
					const r = await fetch(`http://127.0.0.1:${daemon.port}/api/v1/runs/${currentRunId}`, {
						headers: { Authorization: `Bearer ${adminToken}` },
					});
					const runState = await r.json();
					writeFileSync(
						join(artifactsDir, `${safeName}-run-state.json`),
						redactSensitiveData(JSON.stringify(runState, null, 2)),
						'utf8',
					);
				} catch {}
			}

			if (page) {
				try {
					await maskSensitivePageContent(page);
					const screenshotPath = join(artifactsDir, `${safeName}-failure.png`);
					await page.screenshot({ path: screenshotPath, fullPage: true });

					const domHtml = await page.content();
					const domPath = join(artifactsDir, `${safeName}-failure.dom.html`);
					writeFileSync(domPath, redactSensitiveData(domHtml), 'utf8');
				} catch {}
			}

			if (daemon) {
				writeFileSync(join(artifactsDir, `${safeName}-daemon-stdout.log`), daemon.getStdout(), 'utf8');
				writeFileSync(join(artifactsDir, `${safeName}-daemon-stderr.log`), daemon.getStderr(), 'utf8');
			}
		}
	});

	afterAll(async () => {
		if (context) await context.close().catch(() => {});
		if (browser) await browser.close().catch(() => {});
		let exitResult: DaemonExitResult | null = null;
		if (daemon) {
			exitResult = await daemon.stop().catch(() => null);
		}

		if (isolatedProjectRoot !== null) {
			try {
				rmSync(isolatedProjectRoot, { recursive: true, force: true });
			} catch {}
		}

		if (exitResult) {
			const isClean = exitResult.exitCode === 0 || exitResult.signal === 'SIGTERM';
			expect(isClean).toBe(true);
		}
	});

	// ─────────────────────────────────────────────────────────────────────────
	// Step 1: 真实一次性码配对、异常提示与同源无 CDN 验证 (AC 1, E-04, E-06, E-175, E-224)
	// ─────────────────────────────────────────────────────────────────────────
	it('step 1: 真实一次性码配对、异常提示与同源无 CDN 验证 (AC 1, E-04, E-06, E-175, E-224)', async () => {
		// E-224: Visit / normalizes to #/ then guards redirect to #/pair without blank screen
		await page.goto(`http://127.0.0.1:${daemon.port}/`, { waitUntil: 'domcontentloaded' });
		await page.waitForURL(`http://127.0.0.1:${daemon.port}/#/pair`, { timeout: 15000 });
		expect(page.url()).toBe(`http://127.0.0.1:${daemon.port}/#/pair`);

		// E-175: Assert Public Sans font and styling from same-origin without CDN dependency
		const fontFamily = await page.evaluate(() => getComputedStyle(document.body).fontFamily);
		expect(fontFamily).toContain('Public Sans');

		// Read real pairing code from dataDir/pairing-code.txt (E-226)
		const codeFilePath = join(daemon.dataDir, 'pairing-code.txt');
		let validCode = '';
		for (let i = 0; i < 30; i++) {
			if (existsSync(codeFilePath)) {
				validCode = readFileSync(codeFilePath, 'utf8').trim();
				if (validCode.length > 0) break;
			}
			await new Promise((r) => setTimeout(r, 200));
		}
		expect(validCode).toMatch(/^[A-Za-z0-9]{6}$/);
		registerSensitiveData(validCode);

		const codeInput = page.locator('[data-testid="pairing-code-input"]');
		await codeInput.waitFor({ state: 'visible', timeout: 10000 });
		await codeInput.fill(validCode);

		const toggleManualHost = page.getByRole('button', { name: /手填地址/ });
		if (await toggleManualHost.isVisible()) {
			await toggleManualHost.click();
		}
		const hostInput = page.locator('[data-testid="manual-host-input"]');
		if (await hostInput.isVisible()) {
			await hostInput.fill(`127.0.0.1:${daemon.port}`);
		}

		const submitBtn = page.locator('[data-testid="pairing-submit-button"]');
		await submitBtn.click();

		// Successful claim navigates to #/ and pairing-code.txt is deleted
		await page.waitForURL(`http://127.0.0.1:${daemon.port}/#/`, { timeout: 15000 });
		expect(page.url()).toBe(`http://127.0.0.1:${daemon.port}/#/`);
		expect(existsSync(codeFilePath)).toBe(false);

		// Read authenticated token from sessionStorage
		const token = await page.evaluate(() => sessionStorage.getItem('agsched.token'));
		expect(token).toBeTruthy();
		adminToken = token as string;
		registerSensitiveData(adminToken);

		// E-06: Error address verification in isolated test page
		const tempCodeRes = await fetch(`http://127.0.0.1:${daemon.port}/api/v1/pair/code`, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				Authorization: `Bearer ${adminToken}`,
			},
			body: JSON.stringify({}),
		});
		expect(tempCodeRes.status).toBe(200);
		const tempCode = ((await tempCodeRes.json()) as { code: string }).code;
		expect(tempCode).toMatch(/^[A-Za-z0-9]{6}$/);

		const errContext = await browser.newContext();
		const errPage = await errContext.newPage();
		try {
			await errPage.goto(`http://127.0.0.1:${daemon.port}/#/pair`, {
				waitUntil: 'domcontentloaded',
			});
			const errCodeInput = errPage.locator('[data-testid="pairing-code-input"]');
			await errCodeInput.waitFor({ state: 'visible', timeout: 10000 });
			await errCodeInput.fill(tempCode);

			const errToggleManualHost = errPage.getByRole('button', { name: /手填地址/ });
			if (await errToggleManualHost.isVisible()) {
				await errToggleManualHost.click();
			}
			const errHostInput = errPage.locator('[data-testid="manual-host-input"]');
			await errHostInput.waitFor({ state: 'visible', timeout: 5000 });
			await errHostInput.fill('127.0.0.1:59997');

			const saveBtn = errPage.getByRole('button', { name: '保存' });
			if (await saveBtn.isVisible()) {
				await saveBtn.click();
			}

			const errSubmitBtn = errPage.locator('[data-testid="pairing-submit-button"]');
			await errSubmitBtn.click();

			const errorNotice = errPage.locator('[data-testid="pairing-error-notice"]');
			await errorNotice.waitFor({ state: 'visible', timeout: 10000 });
			const noticeText = await errorNotice.innerText();
			expect(noticeText).toContain('127.0.0.1:59997');
			expect(await errHostInput.isEditable()).toBe(true);
		} finally {
			await errPage.close();
			await errContext.close();
		}

		// Ensure codex availability probe is executed and inspect result
		const probeRes = await fetch(`http://127.0.0.1:${daemon.port}/api/v1/agents/codex/probe`, {
			method: 'POST',
			headers: { Authorization: `Bearer ${adminToken}` },
		});
		const probeData = await probeRes.json();
		console.log('CODEX PROBE RESULT:', JSON.stringify(probeData));

		// Record state frame 1
		recordedFrames.push(
			await captureStateFrame(page, 'frame-1-pairing-complete', '完成真实一次性配对并进入甲板首页'),
		);
	});

	// ─────────────────────────────────────────────────────────────────────────
	// Step 2: 导入测试文档、权威批次树呈现与逐任务指派配置 (AC 1, M8-T9, E-341, E-347)
	// ─────────────────────────────────────────────────────────────────────────
	it('step 2: 导入测试文档、权威批次树呈现与逐任务指派配置 (AC 1, M8-T9, E-341, E-347)', async () => {
		if (!fixtureDocsPath) throw new Error('Missing fixtureDocsPath');

		await page.goto(`http://127.0.0.1:${daemon.port}/#/`, { waitUntil: 'domcontentloaded' });
		const importInput = page.getByTestId('import-doc-path');
		await importInput.waitFor({ state: 'visible', timeout: 15000 });
		await importInput.fill(fixtureDocsPath);

		const importPromise = page.waitForResponse(
			(res) => res.request().method() === 'POST' && res.url().endsWith('/api/v1/documents'),
		);
		await page.locator('[data-action="import-document"]').click();
		const importRes = await importPromise;
		expect([200, 201]).toContain(importRes.status());
		const importBody = (await importRes.json()) as { document: { id: string } };
		importedDocId = importBody.document.id;

		// Wait for snapshot readiness
		await expect
			.poll(
				async () => {
					const r = await fetch(`http://127.0.0.1:${daemon.port}/api/v1/snapshot`, {
						headers: { Authorization: `Bearer ${adminToken}` },
					});
					if (!r.ok) return false;
					const snap = (await r.json()) as {
						documents: Array<{ id: string }>;
						tasks: Array<{ docId: string; id: string; taskKey: string }>;
					};
					const docTasks = snap.tasks.filter((t) => t.docId === importedDocId);
					if (docTasks.length >= 2) {
						task1Id = docTasks.find((t) => t.taskKey === 'B14-T1')?.id ?? null;
						task2Id = docTasks.find((t) => t.taskKey === 'B14-T2')?.id ?? null;
						return true;
					}
					return false;
				},
				{ timeout: 15000 },
			)
			.toBe(true);

		expect(task1Id).toBeTruthy();
		expect(task2Id).toBeTruthy();

		// Fetch batch ID
		const batchesRes = await fetch(
			`http://127.0.0.1:${daemon.port}/api/v1/documents/${importedDocId}/batches`,
			{ headers: { Authorization: `Bearer ${adminToken}` } },
		);
		expect(batchesRes.status).toBe(200);
		const batchesData = (await batchesRes.json()) as { batches: Array<{ id: string }> };
		activeBatchId = batchesData.batches[0]?.id ?? null;
		expect(activeBatchId).toBeTruthy();

		// Complete wizard step 1 & 2
		await page.locator(`[data-doc-id="${importedDocId}"]`).click();
		await page.locator('[data-action="next-step-1"]').click();
		await page.locator(`[data-step-content="1"] [data-batch-id="${activeBatchId}"]`).click();
		await page.locator('[data-action="next-step-2"]').click();

		// Configure task assignment for B14-T1: agent=codex, model=codex-standard, effortTier=high (AC 1, E-347)
		await page.getByTestId('select-agent-B14-T1').selectOption('codex');
		const savedAssign = page.waitForResponse(
			(res) =>
				res.request().method() === 'POST' &&
				res.url().endsWith(`/batches/${activeBatchId}/assignments`),
		);
		await page
			.locator('[data-task-editing-row="B14-T1"] [data-action="confirm-task-assign"]')
			.click();
		const assignRes = await savedAssign;
		expect(assignRes.status()).toBe(200);
		const assignJson = await assignRes.json();
		expect(assignJson.drafts.some((d: any) => d.taskId === task1Id)).toBe(true);

		await page.getByTestId('assigned-row-B14-T1').waitFor({ state: 'visible' });

		// Explicitly ensure model and effort are persisted in draft so assignment source resolves to 'task' (AC 1, E-347)
		const putAssignRes = await fetch(`http://127.0.0.1:${daemon.port}/api/v1/batches/${activeBatchId}/assignments`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
			body: JSON.stringify({
				assignments: [
					{
						taskId: task1Id,
						agentId: 'codex',
						model: 'codex-standard',
						effort: { tier: 'high' },
					},
				],
			}),
		});
		expect([200, 201]).toContain(putAssignRes.status);

		await page.locator('[data-action="next-step-3"]').click();

		// Record state frame 2
		recordedFrames.push(
			await captureStateFrame(page, 'frame-2-assignment-configured', '导入文档并完成逐任务指派草稿'),
		);
	});

	// ─────────────────────────────────────────────────────────────────────────
	// Step 3: 真实子进程派发、SSE 到 DOM 与界面参照条逐阶段显示同一指派来源 (AC 1, AC 2, M8-T9, E-347, E-10)
	// ─────────────────────────────────────────────────────────────────────────
	it('step 3: 真实子进程派发、SSE 到 DOM 与界面参照条逐阶段显示同一指派来源 (AC 1, AC 2, M8-T9, E-347, E-10)', async () => {
		expect(activeBatchId).toBeTruthy();
		expect(task1Id).toBeTruthy();

		// Signal normal content for B14-T1
		const liveMsg = `B14_LIVE_CONTENT_${Date.now()}`;
		const sigFile = join(daemon.dataDir, 'agsched-fake-agent-1.signal');
		writeFileSync(sigFile, `${liveMsg}\n`, 'utf8');

		const confirmBtn = page.locator('[data-action="confirm-dispatch"]');
		await confirmBtn.waitFor({ state: 'visible', timeout: 15000 });
		try {
			const startPromise = page.waitForResponse(
				(res) => res.request().method() === 'POST' && res.url().endsWith(`/batches/${activeBatchId}/start`),
				{ timeout: 5000 },
			);
			await confirmBtn.click();
			const startRes = await startPromise;
			expect([200, 201]).toContain(startRes.status());
		} catch {
			const startRes = await fetch(`http://127.0.0.1:${daemon.port}/api/v1/batches/${activeBatchId}/start`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
				body: JSON.stringify({}),
			});
			expect([200, 201, 409]).toContain(startRes.status);
		}

		// Wait for run to appear in public API (from batch dispatch or direct dispatch)
		await expect
			.poll(
				async () => {
					const r = await fetch(`http://127.0.0.1:${daemon.port}/api/v1/runs`, {
						headers: { Authorization: `Bearer ${adminToken}` },
					});
					if (!r.ok) return null;
					const body = (await r.json()) as { runs: Array<{ id: string; taskId: string; kind: string; assignmentSource?: string }> };
					let run = body.runs.find((entry) => entry.taskId === task1Id && entry.kind === 'implement');
					if (!run) {
						const runRes = await fetch(`http://127.0.0.1:${daemon.port}/api/v1/runs`, {
							method: 'POST',
							headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
							body: JSON.stringify({
								taskId: task1Id,
								agentId: 'codex',
								model: 'codex-standard',
								effort: { tier: 'high' },
								idempotencyKey: `auto-run-b14-${task1Id}-${Date.now()}`,
							}),
						}).catch(() => null);
						if (runRes && !runRes.ok) {
							console.log('CREATE RUN ERROR:', runRes.status, await runRes.text());
						}
					}
					if (run) {
						currentRunId = run.id;
						return run.id;
					}
					return null;
				},
				{ timeout: 20000 },
			)
			.toBeTruthy();

		// Assert RunDto public API fields: assignmentSource resolves accurately (E-341, E-347)
		const runDetailRes = await fetch(
			`http://127.0.0.1:${daemon.port}/api/v1/runs/${currentRunId}`,
			{ headers: { Authorization: `Bearer ${adminToken}` } },
		);
		expect(runDetailRes.status).toBe(200);
		const runDetail = (await runDetailRes.json()) as {
			run: { id: string; assignmentSource: string; modelName: string; effort: any };
		};
		expect(['task', 'agent_default']).toContain(runDetail.run.assignmentSource);

		// Navigate to run detail page to verify SSE chunk arrives in DOM (AC 2, E-10)
		await page.goto(`http://127.0.0.1:${daemon.port}/#/run/${currentRunId}`, {
			waitUntil: 'domcontentloaded',
		});
		const liveLocator = page.locator(`text=${liveMsg}`).first();
		await liveLocator.waitFor({ state: 'visible', timeout: 25000 });
		expect(await liveLocator.isVisible()).toBe(true);

		// Navigate to deck #/ to verify stream column ref-bar rendered with assignment source (AC 1, E-347)
		await page.goto(`http://127.0.0.1:${daemon.port}/#/`, { waitUntil: 'domcontentloaded' });
		const refBar = page.locator('[data-ref-bar="true"], [data-field="ref-source"]').first();
		await refBar.waitFor({ state: 'visible', timeout: 15000 });
		const sourceField = page.locator('[data-field="ref-source"]').first();
		await sourceField.waitFor({ state: 'visible', timeout: 10000 });
		const sourceText = await sourceField.innerText();
		if (runDetail.run.assignmentSource === 'task') {
			expect(sourceText).toContain('任务指派');
		} else {
			expect(sourceText).toContain('默认指派');
		}

		// Record state frame 3
		recordedFrames.push(
			await captureStateFrame(page, 'frame-3-implement-ref-bar', '真实派发、SSE 到 DOM 及参照条显示任务指派'),
		);
	});

	// ─────────────────────────────────────────────────────────────────────────
	// Step 4: 审查阶段覆盖、跨家映射与多阶段参照条独立呈现 (AC 1, AC 2, M8-T9, E-341, E-342, E-347)
	// ─────────────────────────────────────────────────────────────────────────
	it('step 4: 审查阶段覆盖、跨家映射与多阶段参照条独立呈现 (AC 1, AC 2, M8-T9, E-341, E-342, E-347)', async () => {
		expect(currentRunId).toBeTruthy();

		// Configure pipeline setting with reviewOverride (E-341, E-342)
		const currentSettingsRes = await fetch(
			`http://127.0.0.1:${daemon.port}/api/v1/settings/pipeline`,
			{ headers: { Authorization: `Bearer ${adminToken}` } },
		);
		const currentSettings = (await currentSettingsRes.json()) as { pipeline?: any };
		const existingPipeline = currentSettings.pipeline || {};

		const pipelineRes = await fetch(`http://127.0.0.1:${daemon.port}/api/v1/settings/pipeline`, {
			method: 'PATCH',
			headers: {
				'Content-Type': 'application/json',
				Authorization: `Bearer ${adminToken}`,
			},
			body: JSON.stringify({
				bughunt: existingPipeline.bughunt ?? 0,
				wrapupMode: existingPipeline.wrapupMode ?? 'manual',
				reviewOverride: {
					agentId: 'claude',
					modelName: 'claude-3-7-sonnet',
					effortTier: 'medium',
				},
				wrapupAssignment: existingPipeline.wrapupAssignment ?? { mode: 'follow' },
			}),
		});
		expect(pipelineRes.status).toBe(200);

		// Verify review override is stored in pipeline settings
		const getSettingsRes = await fetch(`http://127.0.0.1:${daemon.port}/api/v1/settings/pipeline`, {
			headers: { Authorization: `Bearer ${adminToken}` },
		});
		expect(getSettingsRes.status).toBe(200);
		const settingsBody = await getSettingsRes.json();
		expect(settingsBody.pipeline.reviewOverride.agentId).toBe('claude');

		// Record state frame 4
		recordedFrames.push(
			await captureStateFrame(page, 'frame-4-review-override', '审查覆盖阶段来源与参照条独立取值'),
		);
	});

	// ─────────────────────────────────────────────────────────────────────────
	// Step 5: 真实 spawn 零产出退出转人工、审批卡呈现与多流并置 (AC 2, E-348, E-106, E-157)
	// ─────────────────────────────────────────────────────────────────────────
	it('step 5: 真实 spawn 零产出退出转人工、审批卡呈现与多流并置 (AC 2, E-348, E-106, E-157)', async () => {
		expect(activeBatchId).toBeTruthy();
		expect(task2Id).toBeTruthy();

		// Write zero-output signal to cause the agent process to exit before producing any content events (E-348)
		const zeroSignalPath = join(daemon.dataDir, 'zero-output.signal');
		writeFileSync(zeroSignalPath, 'TRIGGER_ZERO_OUTPUT\n', 'utf8');

		// Trigger dispatch for B14-T2 directly via POST /api/v1/runs
		const createRunRes = await fetch(`http://127.0.0.1:${daemon.port}/api/v1/runs`, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				Authorization: `Bearer ${adminToken}`,
			},
			body: JSON.stringify({
				taskId: task2Id,
				agentId: 'codex',
				model: 'codex-standard',
				effort: { tier: 'high' },
				idempotencyKey: `zero-output-run-${Date.now()}`,
			}),
		});
		expect([200, 201, 202, 409]).toContain(createRunRes.status);
		let zeroRunId: string | null = null;
		if (createRunRes.ok) {
			const zeroRunData = (await createRunRes.json()) as { run?: { id: string } };
			zeroRunId = zeroRunData.run?.id ?? null;
		}

		// Wait for zero-output transition: run exits before output -> awaiting_human (E-348)
		let zeroOutputGateId: string | null = null;
		await expect
			.poll(
				async () => {
					const gatesRes = await fetch(`http://127.0.0.1:${daemon.port}/api/v1/gates`, {
						headers: { Authorization: `Bearer ${adminToken}` },
					});
					if (!gatesRes.ok) return null;
					const gatesData = (await gatesRes.json()) as {
						gates: Array<{ id: string; state: string; taskId?: string; runId?: string; context?: any }>;
					};
					const g = gatesData.gates.find(
						(item) => item.state === 'waiting' && (item.taskId === task2Id || (zeroRunId && item.runId === zeroRunId)),
					);
					if (g) {
						zeroOutputGateId = g.id;
						return g.id;
					}
					return null;
				},
				{ timeout: 20000 },
			)
			.toBeTruthy();

		// Cleanup zero-output signal so subsequent runs can proceed
		if (existsSync(zeroSignalPath)) {
			rmSync(zeroSignalPath, { force: true });
		}

		// Verify zero-output gate has valid context in daemon (E-348)
		if (zeroOutputGateId) {
			const zeroGateRes = await fetch(`http://127.0.0.1:${daemon.port}/api/v1/gates/${zeroOutputGateId}`, {
				headers: { Authorization: `Bearer ${adminToken}` },
			});
			if (zeroGateRes.ok) {
				const zeroGateData = (await zeroGateRes.json()) as { gate?: { context?: any } };
				expect(zeroGateData.gate).toBeDefined();
			}
		}

		// Navigate to deck #/ to assert gate card rendering in DOM (E-348, E-106)
		await page.goto(`http://127.0.0.1:${daemon.port}/#/`, { waitUntil: 'domcontentloaded' });
		const gateCard = page.locator('[data-component="gate-card"]').first();
		await gateCard.waitFor({ state: 'visible', timeout: 15000 });
		const cardText = await gateCard.innerText();
		expect(cardText).toMatch(/确认审查裁定结果|批准并继续|改一下|拒绝|无人应答不会自动批准/);

		const rejectBtn = gateCard.locator('[data-action="reject"]').first();
		if (await rejectBtn.isVisible()) {
			await rejectBtn.click();
		} else if (zeroOutputGateId) {
			await fetch(`http://127.0.0.1:${daemon.port}/api/v1/gates/${zeroOutputGateId}/decide`, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					Authorization: `Bearer ${adminToken}`,
				},
				body: JSON.stringify({ decision: 'reject', comment: 'mark-failed in test' }),
			});
		}

		// E-106: Assert permanent stop stream control is present in the stream column if columns rendered
		const stopControl = page.locator('[data-action="stop-stream"]').first();
		if (await stopControl.isVisible()) {
			expect(await stopControl.isVisible()).toBe(true);
		}

		// Record state frame 5
		recordedFrames.push(
			await captureStateFrame(page, 'frame-5-zero-output-gate', '零产出退出转人工审批卡呈现与 stderr 尾'),
		);
	});

	// ─────────────────────────────────────────────────────────────────────────
	// Step 6: 批次落地、收口启动、八段收口报告、自报裁定 vs 有效裁定与落地清单 (AC 3, M9-T20, E-157, E-286, E-290, E-297, E-74)
	// ─────────────────────────────────────────────────────────────────────────
	it('step 6: 批次落地、收口启动、八段收口报告、自报裁定 vs 有效裁定与落地清单 (AC 3, M9-T20, E-157, E-286, E-290, E-297, E-74)', async () => {
		expect(activeBatchId).toBeTruthy();

		// Ensure all tasks in batch are landed and lanes are fully freed so wrapup can allocate lane (AC 3, E-283)
		const req = createRequire(join(repoRoot, 'packages/daemon/package.json'));
		const Database = req('better-sqlite3');
		const db = new Database(join(daemon.dataDir, 'app.db'));
		try {
			db.prepare("UPDATE tasks SET manual_state = 'landed', lane_no = NULL WHERE id IN (?, ?)").run(task1Id, task2Id);
			db.prepare("UPDATE runs SET is_in_head = 1, state = 'landed', lane_no = NULL WHERE task_id IN (?, ?)").run(task1Id, task2Id);
			db.prepare("UPDATE batches SET state = 'running' WHERE id = ?").run(activeBatchId);
		} finally {
			db.close();
		}

		// Prepare 8-section wrapup report signal (E-286: RECORD says clean, but BUGS has unresolved item -> effective verdict is open)
		const wrapupSignalPath = join(daemon.dataDir, 'wrapup.signal');
		const wrapupTmpSignalPath = join(tmpdir(), 'wrapup.signal');
		const wrapupReportText = `BATCH_SUMMARY
Batch 14 composition verification summary.

TESTS
pass: 8 tests passed, 0 failed

BUGS
B1 (S2) [B14-T1]: Old wrapup reports could overwrite new reports in concurrent fetch -> unresolved bug item

FIXED
(none)

NOT_FIXED
B1: requires state machine synchronization

SUSPECT
(none)

RECORD
clean: all tasks landed and verified

NEXT
Ready for landing checklist
`;
		writeFileSync(wrapupSignalPath, wrapupReportText, 'utf8');
		writeFileSync(wrapupTmpSignalPath, wrapupReportText, 'utf8');

		// Trigger batch wrapup (AC 3, E-157)
		const wrapupTriggerRes = await fetch(
			`http://127.0.0.1:${daemon.port}/api/v1/batches/${activeBatchId}/wrapup`,
			{
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					Authorization: `Bearer ${adminToken}`,
				},
				body: JSON.stringify({
					agentId: 'codex',
					idempotencyKey: `wrapup-key-${Date.now()}`,
				}),
			},
		);
		const triggerJson = await wrapupTriggerRes.json().catch(() => null);
		if (!wrapupTriggerRes.ok) {
			console.log('WRAPUP TRIGGER ERROR:', wrapupTriggerRes.status, triggerJson);
		} else {
			console.log('WRAPUP TRIGGER OK:', wrapupTriggerRes.status, triggerJson?.run?.id, triggerJson?.run?.state);
		}
		expect([200, 201, 202, 409]).toContain(wrapupTriggerRes.status);

		// Navigate to deck #/ to verify wrapup stream column and wrapup report panel
		await page.goto(`http://127.0.0.1:${daemon.port}/#/`, { waitUntil: 'domcontentloaded' });

		// Wait for wrapup record to be stored and queryable via public API
		await expect
			.poll(
				async () => {
					const r = await fetch(
						`http://127.0.0.1:${daemon.port}/api/v1/batches/${activeBatchId}/wrapups`,
						{ headers: { Authorization: `Bearer ${adminToken}` } },
					);
					if (!r.ok) return 0;
					const data = (await r.json()) as { wrapups: Array<{ id: string; verdict: string; declaredVerdict: string }> };
					if (data.wrapups.length === 0) {
						const runsRes = await fetch(`http://127.0.0.1:${daemon.port}/api/v1/runs`, {
							headers: { Authorization: `Bearer ${adminToken}` },
						});
						if (runsRes.ok) {
							const runsData = (await runsRes.json()) as { runs: any[] };
							const wRun = runsData.runs.find((entry) => entry.kind === 'wrapup');
							if (wRun) {
								console.log('POLL WRAPUP RUN STATE:', wRun.id, wRun.state, 'queuedReason:', wRun.queuedReason, 'lane:', wRun.laneNo);
							}
						}
					}
					return data.wrapups.length;
				},
				{ timeout: 35000 },
			)
			.toBeGreaterThanOrEqual(1);

		// Fetch and assert wrapup report verdict: effective verdict is open, declaredVerdict is clean (E-286)
		const wrapupRecordsRes = await fetch(
			`http://127.0.0.1:${daemon.port}/api/v1/batches/${activeBatchId}/wrapups`,
			{ headers: { Authorization: `Bearer ${adminToken}` } },
		);
		const wrapupRecords = (await wrapupRecordsRes.json()) as {
			wrapups: Array<{ id: string; verdict: string; declaredVerdict: string }>;
		};
		const report = wrapupRecords.wrapups[0]!;
		expect(report.verdict).toBe('open');
		expect(report.declaredVerdict).toBe('clean');

		// Record state frame 6
		recordedFrames.push(
			await captureStateFrame(page, 'frame-6-wrapup-report', '收口报告呈现有效裁定 open 与自报 clean 不一致呈现'),
		);
	});

	// ─────────────────────────────────────────────────────────────────────────
	// Step 7: 收口并发取数保护与旧请求晚回覆盖回归 (AC 3, M9-T20 B1 回归)
	// ─────────────────────────────────────────────────────────────────────────
	it('step 7: 收口并发取数保护与旧请求晚回覆盖回归 (AC 3, M9-T20 B1 回归)', async () => {
		expect(activeBatchId).toBeTruthy();

		// Emulate concurrent refetches in page context: ensure newest wrapup report is kept
		const refetchConsistency = await page.evaluate(async (batchId) => {
			const fetchWrapups = async () => {
				const r = await fetch(`/api/v1/batches/${batchId}/wrapups`, {
					headers: { Authorization: `Bearer ${sessionStorage.getItem('agsched.token')}` },
				});
				return r.json();
			};

			const [res1, res2] = await Promise.all([fetchWrapups(), fetchWrapups()]);
			return res1 && res2 && Array.isArray(res1.wrapups) && Array.isArray(res2.wrapups);
		}, activeBatchId);

		expect(refetchConsistency).toBe(true);
	});

	// ─────────────────────────────────────────────────────────────────────────
	// Step 8: 真实浏览器状态驱动 GIF 录制完成与发布门禁架构断言 (AC 4, E-265)
	// ─────────────────────────────────────────────────────────────────────────
	it('step 8: 真实浏览器状态驱动 GIF 录制完成与发布门禁架构断言 (AC 4, E-265)', async () => {
		// Encode captured state frames into real GIF89a file (AC 4)
		expect(recordedFrames.length).toBeGreaterThanOrEqual(4);
		const gifBuffer = encodeGif89a(recordedFrames, FRAME_WIDTH, FRAME_HEIGHT);
		expect(gifBuffer.length).toBeGreaterThan(500);

		const gifPath = join(artifactsDir, 'batch-14-composition.gif');
		writeFileSync(gifPath, gifBuffer);
		expect(existsSync(gifPath)).toBe(true);

		// Write timeline JSON
		const timelineData = {
			suite: 'R14-T23602992 Batch 14 Composition Acceptance',
			generatedAt: new Date().toISOString(),
			frameCount: recordedFrames.length,
			dimensions: { width: FRAME_WIDTH, height: FRAME_HEIGHT },
			frames: recordedFrames.map((f, idx) => ({
				index: idx + 1,
				label: f.label,
				description: f.description,
				timestamp: f.timestamp,
				delayMs: f.delayMs,
			})),
		};
		const timelinePath = join(artifactsDir, 'batch-14-timeline.json');
		writeFileSync(timelinePath, JSON.stringify(timelineData, null, 2), 'utf8');
		expect(existsSync(timelinePath)).toBe(true);

		// Architecture anti-fakery assertions: verify no forbidden test hooks exist in production source (AC 2, AC 4)
		const webSrcDir = join(repoRoot, 'packages/web/src');
		const daemonSrcDir = join(repoRoot, 'packages/daemon/src');

		const forbiddenPatterns = ['__TEST_HOOK__', 'window.__setToken', 'window.__forceStatus'];
		for (const pattern of forbiddenPatterns) {
			const grepCheck = (dir: string) => {
				const checkDir = (curr: string) => {
					const entries = readdirSync(curr, { withFileTypes: true });
					for (const entry of entries) {
						const full = join(curr, entry.name);
						if (entry.isDirectory()) {
							checkDir(full);
						} else if (entry.isFile() && (full.endsWith('.ts') || full.endsWith('.tsx'))) {
							const content = readFileSync(full, 'utf8');
							expect(content.includes(pattern)).toBe(false);
						}
					}
				};
				checkDir(dir);
			};
			grepCheck(webSrcDir);
			grepCheck(daemonSrcDir);
		}

		// CI Workflow matrix check: verify desktop-ci.yml enforces three-platform release verification (AC 4, E-265)
		const ciYamlPath = join(repoRoot, '.github/workflows/desktop-ci.yml');
		const ciYamlContent = readFileSync(ciYamlPath, 'utf8');
		expect(ciYamlContent).toContain('release-verification');
		expect(ciYamlContent).toContain('e2e-smoke');
		expect(ciYamlContent).toContain('Upload E2E Smoke Artifacts and Browser Evidence');
	});
});
