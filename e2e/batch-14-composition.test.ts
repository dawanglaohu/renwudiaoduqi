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
import { inflateSync } from 'node:zlib';
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

		// Emit literal palette indices with regular clear codes. Keeping each dictionary
		// below 512 entries makes every code exactly 9 bits and avoids an invalid
		// width transition in the previous encoder, which corrupted the saved frames.
		const bytes: number[] = [];
		let pending = 0;
		let pendingBits = 0;
		const writeCode = (code: number) => {
			pending |= code << pendingBits;
			pendingBits += 9;
			while (pendingBits >= 8) {
				bytes.push(pending & 0xff);
				pending >>>= 8;
				pendingBits -= 8;
			}
		};
		writeCode(clearCode);
		let literalsSinceClear = 0;
		for (const pixel of frame.pixels) {
			if (literalsSinceClear === 200) {
				writeCode(clearCode);
				literalsSinceClear = 0;
			}
			writeCode(pixel);
			literalsSinceClear++;
		}
		writeCode(eoiCode);
		if (pendingBits > 0) bytes.push(pending & 0xff);

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

function decodePngRgba(buf: Buffer): { width: number; height: number; data: Uint8Array } {
	if (buf.length < 8 || buf.readUInt32BE(0) !== 0x89504e47 || buf.readUInt32BE(4) !== 0x0d0a1a0a) {
		throw new Error('Invalid PNG signature');
	}

	let offset = 8;
	let width = 0;
	let height = 0;
	let bitDepth = 0;
	let colorType = 0;
	const idatChunks: Buffer[] = [];

	while (offset < buf.length) {
		const length = buf.readUInt32BE(offset);
		const type = buf.toString('ascii', offset + 4, offset + 8);
		const chunkData = buf.subarray(offset + 8, offset + 8 + length);
		offset += 12 + length;

		if (type === 'IHDR') {
			width = chunkData.readUInt32BE(0);
			height = chunkData.readUInt32BE(4);
			bitDepth = chunkData[8]!;
			colorType = chunkData[9]!;
		} else if (type === 'IDAT') {
			idatChunks.push(chunkData);
		} else if (type === 'IEND') {
			break;
		}
	}

	if (bitDepth !== 8 || (colorType !== 6 && colorType !== 2)) {
		throw new Error(`Unsupported PNG format: depth=${bitDepth}, colorType=${colorType}`);
	}

	const bpp = colorType === 6 ? 4 : 3;
	const compressed = Buffer.concat(idatChunks);
	const decompressed = inflateSync(compressed);

	const stride = width * bpp;
	const expectedScanline = 1 + stride;
	const outRgba = new Uint8Array(width * height * 4);

	const priorRow = new Uint8Array(stride);
	const currentRow = new Uint8Array(stride);

	function paeth(a: number, b: number, c: number): number {
		const p = a + b - c;
		const pa = Math.abs(p - a);
		const pb = Math.abs(p - b);
		const pc = Math.abs(p - c);
		if (pa <= pb && pa <= pc) return a;
		if (pb <= pc) return b;
		return c;
	}

	for (let y = 0; y < height; y++) {
		const rowOffset = y * expectedScanline;
		const filter = decompressed[rowOffset]!;
		const rawData = decompressed.subarray(rowOffset + 1, rowOffset + 1 + stride);

		for (let i = 0; i < stride; i++) {
			const left = i >= bpp ? currentRow[i - bpp]! : 0;
			const up = priorRow[i]!;
			const upLeft = i >= bpp ? priorRow[i - bpp]! : 0;
			const raw = rawData[i]!;

			let val = 0;
			if (filter === 0) {
				val = raw;
			} else if (filter === 1) {
				val = (raw + left) & 0xff;
			} else if (filter === 2) {
				val = (raw + up) & 0xff;
			} else if (filter === 3) {
				val = (raw + Math.floor((left + up) / 2)) & 0xff;
			} else if (filter === 4) {
				val = (raw + paeth(left, up, upLeft)) & 0xff;
			} else {
				val = raw;
			}
			currentRow[i] = val;
		}

		const outRowOffset = y * width * 4;
		for (let x = 0; x < width; x++) {
			const srcIdx = x * bpp;
			const dstIdx = outRowOffset + x * 4;
			outRgba[dstIdx] = currentRow[srcIdx]!;
			outRgba[dstIdx + 1] = currentRow[srcIdx + 1]!;
			outRgba[dstIdx + 2] = currentRow[srcIdx + 2]!;
			outRgba[dstIdx + 3] = bpp === 4 ? currentRow[srcIdx + 3]! : 255;
		}

		priorRow.set(currentRow);
	}

	return { width, height, data: outRgba };
}

function getRunFromDb(dataDir: string, runId: string): any {
	const dbPath = join(dataDir, 'app.db');
	if (!existsSync(dbPath)) return null;
	const require = createRequire(import.meta.url);
	const Database = require('better-sqlite3');
	const db = new Database(dbPath, { readonly: true });
	try {
		return db.prepare('SELECT * FROM runs WHERE id = ?').get(runId);
	} finally {
		db.close();
	}
}

function getSnapshotFromDb(dataDir: string, snapshotId: string): any {
	const dbPath = join(dataDir, 'app.db');
	if (!existsSync(dbPath)) return null;
	const require = createRequire(import.meta.url);
	const Database = require('better-sqlite3');
	const db = new Database(dbPath, { readonly: true });
	try {
		return db.prepare('SELECT * FROM dispatch_snapshots WHERE id = ?').get(snapshotId);
	} finally {
		db.close();
	}
}

const FRAME_WIDTH = 960;
const FRAME_HEIGHT = 600;

async function captureStateFrame(
	page: Page,
	label: string,
	description: string,
): Promise<FrameRecord> {
	await maskSensitivePageContent(page);
	const pngBuffer = await page.screenshot({ type: 'png' });
	writeFileSync(join(artifactsDir, `${label}.png`), pngBuffer);
	const decoded = decodePngRgba(pngBuffer);
	const pixels = new Uint8Array(FRAME_WIDTH * FRAME_HEIGHT);

	for (let y = 0; y < FRAME_HEIGHT; y++) {
		const srcY = Math.min(decoded.height - 1, Math.floor((y * decoded.height) / FRAME_HEIGHT));
		for (let x = 0; x < FRAME_WIDTH; x++) {
			const srcX = Math.min(decoded.width - 1, Math.floor((x * decoded.width) / FRAME_WIDTH));
			const idx = (srcY * decoded.width + srcX) * 4;
			const r = decoded.data[idx]!;
			const g = decoded.data[idx + 1]!;
			const b = decoded.data[idx + 2]!;
			const rIdx = Math.min(5, Math.max(0, Math.round(r / 51)));
			const gIdx = Math.min(5, Math.max(0, Math.round(g / 51)));
			const bIdx = Math.min(5, Math.max(0, Math.round(b / 51)));
			pixels[y * FRAME_WIDTH + x] = rIdx * 36 + gIdx * 6 + bIdx;
		}
	}

	return {
		label,
		description,
		pixels,
		timestamp: new Date().toISOString(),
		delayMs: 1200,
	};
}

interface CapturedEvent {
	readonly kind: string;
	readonly receivedAt?: string;
	readonly runId: string | null;
	readonly taskId: string | null;
	readonly payload: Record<string, unknown>;
}

async function captureLiveEvents(port: number, token: string): Promise<{
	readonly events: CapturedEvent[];
	readonly subscription: { readonly connectedAt: string; readonly status: number };
	readonly stop: () => Promise<void>;
}> {
	const abort = new AbortController();
	const response = await fetch(`http://127.0.0.1:${port}/api/v1/events`, {
		headers: { Authorization: `Bearer ${token}` },
		signal: abort.signal,
	});
	if (!response.ok || !response.body) {
		abort.abort();
		throw new Error(`Could not subscribe to live events: ${response.status}`);
	}
	const events: CapturedEvent[] = [];
	const reader = response.body.getReader();
	const drain = (async () => {
		const decoder = new TextDecoder();
		let pending = '';
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			pending += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
			let boundary = pending.indexOf('\n\n');
			while (boundary >= 0) {
				const frame = pending.slice(0, boundary);
				pending = pending.slice(boundary + 2);
				const data = frame.split('\n').find((line) => line.startsWith('data: '));
				if (data) {
					const envelope = JSON.parse(data.slice(6)) as CapturedEvent;
					events.push({ ...envelope, receivedAt: new Date().toISOString() });
				}
				boundary = pending.indexOf('\n\n');
			}
		}
	})().catch((error: unknown) => {
		if (!abort.signal.aborted) throw error;
	});
	return {
		events,
		subscription: { connectedAt: new Date().toISOString(), status: response.status },
		stop: async () => {
			abort.abort();
			await drain;
		},
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

// Multi fingerprint match for codex (\\bcodex\\b), grok (\\bgrok\\b) and claude (\\bClaude Code\\b)
if (process.argv.includes('--version') || process.argv.includes('-V') || process.argv.includes('-v')) {
  process.stdout.write('codex 0.1.0 grok 1.2.0 (Claude Code compatible composition-agent)\\n');
  process.exit(0);
}

// Login probe response for codex and claude
if ((process.argv.includes('login') && process.argv.includes('status')) || (process.argv.includes('auth') && process.argv.includes('status'))) {
  process.stdout.write('Logged in as test-user\\n{"loggedIn":true,"user":"test-user"}\\n');
  process.exit(0);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const signalDir = process.env.AGSCHED_SMOKE_SIGNAL_DIR || os.tmpdir();

const zeroSignals = [
  path.join(signalDir, 'zero-output.signal'),
  path.join(os.tmpdir(), 'zero-output.signal'),
  path.join(path.dirname(process.argv[1] || ''), 'zero-output.signal'),
];
const hasZeroSignal = zeroSignals.some((p) => fs.existsSync(p));
const isReviewOrBughunt = process.argv.some((a) => a.includes('review') || a.includes('bughunt') || a.includes('grok'));
const isTask2 = !isReviewOrBughunt && (
  process.cwd().toLowerCase().includes('b14-t2') ||
  process.argv.some((a) => a.includes('B14-T2') && !a.includes('B14-T1'))
);

// E-323: only the armed task's bughunt may consume this fault.
const bughuntFailSignal = path.join(signalDir, 'bughunt-fail.signal');
function shouldFailBughunt(prompt) {
  if (!prompt.trimStart().startsWith('# 查 bug 执行指令') || !fs.existsSync(bughuntFailSignal)) return false;
  const fault = JSON.parse(fs.readFileSync(bughuntFailSignal, 'utf8'));
  const targetHeading = '\\n## 工作区指针与测试指令\\n\\n### 目标任务\\n';
  const targetOffset = prompt.lastIndexOf(targetHeading);
  return typeof fault.taskId === 'string' && fault.taskId.length > 0 && targetOffset >= 0 &&
    prompt.slice(targetOffset + targetHeading.length).startsWith('- 任务 ' + fault.taskId + '：');
}
const hasWrapupFailSignal = fs.existsSync(path.join(signalDir, 'wrapup-fail.signal'));

// E-348 Zero-output check: if zero-output signal exists and target is B14-T2, wait 350ms for daemon to reach running state, then exit with stderr before content events
if (hasWrapupFailSignal) {
  const partial = path.join(process.cwd(), 'e2e/b14-t1.ts');
  if (fs.existsSync(partial)) fs.appendFileSync(partial, '// unfinished wrapup change\\n', 'utf8');
  setTimeout(() => {
    process.stderr.write('[error] Wrapup exited with unfinished worktree changes\\n');
    process.exit(1);
  }, 350);
} else if (hasZeroSignal && isTask2) {
  setTimeout(() => {
    process.stderr.write('[error] Agent process exited before producing content: authentication required or invalid model\\n[stderr] credentials check failed: token expired\\n');
    process.exit(1);
  }, 350);
} else {
  let turnStarted = false;
  let currentPrompt = '';

  function emitTurnPayload() {
    if (turnStarted) return;
    turnStarted = true;
    const prompt = currentPrompt || process.argv.find((arg) => arg.trimStart().startsWith('# 查 bug 执行指令')) || '';
    if (shouldFailBughunt(prompt)) {
      setTimeout(() => {
        process.stderr.write('[error] Bughunt execution failure: test induced bughunt failure for E-323\\n[stderr] analysis aborted\\n');
        process.exit(1);
      }, 350);
      return;
    }

    // Produce real git diff for implement runs strictly within the task's own effectivePaths
    const taskKeys = ['b14-t1', 'b14-t2', 'b14-t3', 'b14-t4', 'b14-t5'];
    for (const key of taskKeys) {
      const isKeyTarget = process.cwd().toLowerCase().includes(key) ||
        process.argv.some((a) => a.toLowerCase().includes(key));
      if (isKeyTarget) {
        const tf = path.join(process.cwd(), 'e2e/' + key + '.ts');
        if (fs.existsSync(tf)) {
          try {
            fs.appendFileSync(tf, '// implemented code update ' + Date.now() + '\\n', 'utf8');
          } catch {}
        }
      }
    }

    // Check if wrapup signal exists to emit 8-section wrapup report
    const wrapupSignals = [
      path.join(signalDir, 'wrapup.signal'),
      path.join(os.tmpdir(), 'wrapup.signal'),
    ];
    let outputText = 'VERDICT: pass\\nComposition agent verified and approved.\\n';
    const wrapupSignalPath = wrapupSignals.find((p) => fs.existsSync(p));
    const isBughunt = process.argv.some((a) => a.includes('bughunt') || a.includes('查 bug')) ||
      currentPrompt.includes('查 bug') || currentPrompt.includes('BUGS');
    if (wrapupSignalPath) {
      try {
        outputText = fs.readFileSync(wrapupSignalPath, 'utf8');
      } catch {}
    } else if (isBughunt) {
      outputText = 'BUGS\\n(none)\\n\\nFIXED\\n(none)\\n\\nNOT_FIXED\\n(none)\\n\\nSUSPECT\\n(none)\\n\\nNEXT\\nReady for landing\\n';
    } else {
      const isReviewOrGrok = process.argv.some((a) => a.includes('review') || a.includes('grok'));
      const isT3Target = process.cwd().toLowerCase().includes('b14-t3') || process.argv.some((a) => a.includes('B14-T3'));
      const unstructuredSignalPath = [
        path.join(signalDir, 'unstructured-rework.signal'),
        path.join(os.tmpdir(), 'unstructured-rework.signal'),
      ].find((p) => fs.existsSync(p));
      if (isReviewOrGrok && isT3Target && unstructuredSignalPath) {
        // E-278: Unstructured review verdict without R items, triggering review_verdict='incomplete'
        outputText = 'VERDICT: rework\\nPlease revise the implementation code thoroughly without structured R items.\\n';
      } else if (!isReviewOrGrok) {
        const customSignals = [
          path.join(signalDir, 'agsched-fake-agent-1.signal'),
          path.join(os.tmpdir(), 'agsched-fake-agent-1.signal'),
        ];
        const customSignalPath = customSignals.find((p) => fs.existsSync(p));
        if (customSignalPath) {
          try {
            outputText = fs.readFileSync(customSignalPath, 'utf8');
          } catch {}
        }
      }
    }

    process.stdout.write(JSON.stringify({ method: 'thread/started', params: { threadId: 'thread-b14-composition' } }) + '\\n');
    process.stdout.write(JSON.stringify({ method: 'turn/started', params: { threadId: 'thread-b14-composition', turn: { id: 'turn-b14-composition' } } }) + '\\n');

    const formattedDelta = outputText.endsWith('\\n') ? outputText : outputText + '\\n';
    // Raw text output for raw stream parsers
    process.stdout.write(formattedDelta);
    // Codex line
    process.stdout.write(JSON.stringify({
      method: 'item/agentMessage/delta',
      params: { delta: formattedDelta }
    }) + '\\n');
    // Grok / ACP compatible line
    process.stdout.write(JSON.stringify({
      type: 'agent_message_chunk',
      text: formattedDelta
    }) + '\\n');

    setTimeout(() => {
      process.stdout.write(JSON.stringify({
        method: 'item/completed',
        params: { item: { id: 'msg-b14-1', type: 'agentMessage', text: outputText } }
      }) + '\\n');

      setTimeout(async () => {
        // Keep the real implement turn active until its lane metadata is observed.
        while (outputText.startsWith('B14_LIVE_CONTENT_') && fs.existsSync(path.join(signalDir, 'hold-implementation.signal'))) await sleep(50);
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
          const inputArr = msg.params?.input;
          if (Array.isArray(inputArr) && inputArr[0]?.text) {
            currentPrompt = String(inputArr[0].text);
          }
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
}
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
				effortVendorMap: { low: 'low', medium: 'medium', high: 'high' },
				maxConcurrency: 6,
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
				defaultEffortTier: { tier: 'medium' },
				effortVendorMap: { low: 'low', medium: 'medium', high: 'high' },
				maxConcurrency: 6,
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
				execPath: agentExecPath,
				defaultModel: 'grok-beta',
				defaultEffortTier: { tier: 'medium' },
				effortVendorMap: { low: 'low', medium: 'medium', high: 'high' },
				maxConcurrency: 6,
				builtinModels: [
					{ name: 'grok-beta' },
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
	try {
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
			throw new Error(`Daemon failed to respond at http://127.0.0.1:${port} within timeout`);
		}
	} catch (err) {
		mkdirSync(artifactsDir, { recursive: true });
		writeFileSync(join(artifactsDir, 'b14-setup-daemon-stdout.log'), redactSensitiveData(stdoutData), 'utf8');
		writeFileSync(join(artifactsDir, 'b14-setup-daemon-stderr.log'), redactSensitiveData(stderrData), 'utf8');
		await stopFn().catch(() => {});
		throw err;
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
	let gitRepoDir: string;
	let fixtureDocsPath: string | null = null;
	let importedDocId: string | null = null;
	let activeBatchId: string | null = null;
	let task1Id: string | null = null;
	let task2Id: string | null = null;
	let task3Id: string | null = null;
	let task4Id: string | null = null;
	let task5Id: string | null = null;
	let currentRunId: string | null = null;
	let bughuntRerunEvidence: unknown = null;
	let liveEvents: Awaited<ReturnType<typeof captureLiveEvents>> | null = null;

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
			gitRepoDir = join(isolatedProjectRoot, 'repo');
			mkdirSync(gitRepoDir, { recursive: true });
			execFileSync('git', ['init', gitRepoDir], { stdio: 'ignore' });
			execFileSync('git', ['-C', gitRepoDir, 'symbolic-ref', 'HEAD', 'refs/heads/main'], { stdio: 'ignore' });
			execFileSync('git', ['-C', gitRepoDir, 'config', 'user.name', 'Batch14 E2E'], { stdio: 'ignore' });
			execFileSync('git', ['-C', gitRepoDir, 'config', 'user.email', 'b14-e2e@example.invalid'], { stdio: 'ignore' });

			// Fixture document conforming to batch 14 expectations with 5 tasks in Batch 1 (E-106)
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
						'B14-T1': { hash: 'hash-b14-task-1', effectivePaths: ['e2e/b14-t1.ts'] },
						'B14-T2': { hash: 'hash-b14-task-2', effectivePaths: ['e2e/b14-t2.ts'] },
						'B14-T3': { hash: 'hash-b14-task-3', effectivePaths: ['e2e/b14-t3.ts'] },
						'B14-T4': { hash: 'hash-b14-task-4', effectivePaths: ['e2e/b14-t4.ts'] },
						'B14-T5': { hash: 'hash-b14-task-5', effectivePaths: ['e2e/b14-t5.ts'] },
					},
					readiness: {
						'B14-T1': { ready: true, contractHash: 'hash-b14-task-1', reasons: [] },
						'B14-T2': { ready: true, contractHash: 'hash-b14-task-2', reasons: [] },
						'B14-T3': { ready: true, contractHash: 'hash-b14-task-3', reasons: [] },
						'B14-T4': { ready: true, contractHash: 'hash-b14-task-4', reasons: [] },
						'B14-T5': { ready: true, contractHash: 'hash-b14-task-5', reasons: [] },
					},
					effectivePaths: {
						'B14-T1': ['e2e/b14-t1.ts'],
						'B14-T2': ['e2e/b14-t2.ts'],
						'B14-T3': ['e2e/b14-t3.ts'],
						'B14-T4': ['e2e/b14-t4.ts'],
						'B14-T5': ['e2e/b14-t5.ts'],
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
						{
							id: 'B14-T3',
							title: '并发流任务3',
							module: 'M1',
							deps: [],
							input: '输入3',
							output: '输出3',
							accept: '1) 验证并发流',
							est: 1.0,
							edges: ['E-106'],
						},
						{
							id: 'B14-T4',
							title: '并发流任务4',
							module: 'M1',
							deps: [],
							input: '输入4',
							output: '输出4',
							accept: '1) 验证并发流',
							est: 1.0,
							edges: ['E-106'],
						},
						{
							id: 'B14-T5',
							title: '并发流任务5',
							module: 'M1',
							deps: [],
							input: '输入5',
							output: '输出5',
							accept: '1) 验证并发流',
							est: 1.0,
							edges: ['E-106'],
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
					'B14-T3': {
						contractHash: 'hash-b14-task-3',
						implementation: '实现 B14-T3',
						review: '审查 B14-T3',
					},
					'B14-T4': {
						contractHash: 'hash-b14-task-4',
						implementation: '实现 B14-T4',
						review: '审查 B14-T4',
					},
					'B14-T5': {
						contractHash: 'hash-b14-task-5',
						implementation: '实现 B14-T5',
						review: '审查 B14-T5',
					},
				},
			};

			mkdirSync(join(gitRepoDir, 'e2e'), { recursive: true });
			writeFileSync(join(gitRepoDir, 'e2e/b14-t1.ts'), '// B14-T1 implementation\n', 'utf8');
			writeFileSync(join(gitRepoDir, 'e2e/b14-t2.ts'), '// B14-T2 implementation\n', 'utf8');
			writeFileSync(join(gitRepoDir, 'e2e/b14-t3.ts'), '// B14-T3 implementation\n', 'utf8');
			writeFileSync(join(gitRepoDir, 'e2e/b14-t4.ts'), '// B14-T4 implementation\n', 'utf8');
			writeFileSync(join(gitRepoDir, 'e2e/b14-t5.ts'), '// B14-T5 implementation\n', 'utf8');

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

			daemon = await startCompositionDaemon({ timeoutMs: 240000 });
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
	}, 300000);

	afterEach(async ({ task }) => {
		try {
			if (daemon) rmSync(join(daemon.dataDir, 'hold-implementation.signal'), { force: true });
			if (task.result?.state === 'fail') {
				const safeName = task.name.replace(/[^a-zA-Z0-9_-]/g, '_');
				mkdirSync(artifactsDir, { recursive: true });
				if (liveEvents) {
					writeFileSync(
						join(artifactsDir, `${safeName}-live-events.json`),
						redactSensitiveData(JSON.stringify({ subscription: liveEvents.subscription, events: liveEvents.events }, null, 2)),
						'utf8',
					);
				}

				if (daemon && currentRunId && adminToken) {
					try {
						const [runsResponse, gatesResponse] = await Promise.all([
							fetch(`http://127.0.0.1:${daemon.port}/api/v1/runs`, { headers: { Authorization: `Bearer ${adminToken}` } }),
							fetch(`http://127.0.0.1:${daemon.port}/api/v1/gates?pending=false`, { headers: { Authorization: `Bearer ${adminToken}` } }),
						]);
						const runState = {
							parentRunId: currentRunId,
							runs: await runsResponse.json(),
							gates: await gatesResponse.json(),
							rerun: bughuntRerunEvidence,
						};
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
		} finally {
			if (daemon && (task.result?.state === 'fail' || task.name.startsWith('step 4:'))) {
				rmSync(join(daemon.dataDir, 'bughunt-fail.signal'), { force: true });
			}
		}
	});

	afterAll(async () => {
		if (liveEvents) {
			writeFileSync(
				join(artifactsDir, 'b14-live-events.json'),
				redactSensitiveData(JSON.stringify({ subscription: liveEvents.subscription, events: liveEvents.events }, null, 2)),
				'utf8',
			);
		}
		if (liveEvents) await liveEvents.stop().catch(() => {});
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
		liveEvents = await captureLiveEvents(daemon.port, adminToken);

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
					if (docTasks.length >= 5) {
						task1Id = docTasks.find((t) => t.taskKey === 'B14-T1')?.id ?? null;
						task2Id = docTasks.find((t) => t.taskKey === 'B14-T2')?.id ?? null;
						task3Id = docTasks.find((t) => t.taskKey === 'B14-T3')?.id ?? null;
						task4Id = docTasks.find((t) => t.taskKey === 'B14-T4')?.id ?? null;
						task5Id = docTasks.find((t) => t.taskKey === 'B14-T5')?.id ?? null;
						return true;
					}
					return false;
				},
				{ timeout: 15000 },
			)
			.toBe(true);

		expect(task1Id).toBeTruthy();
		expect(task2Id).toBeTruthy();
		expect(task3Id).toBeTruthy();
		expect(task4Id).toBeTruthy();
		expect(task5Id).toBeTruthy();

		// Set document laneCount to 6 to support 5 concurrent tasks simultaneously (E-106)
		const setLaneRes = await fetch(
			`http://127.0.0.1:${daemon.port}/api/v1/documents/${importedDocId}/settings`,
			{
				method: 'PATCH',
				headers: {
					'Content-Type': 'application/json',
					Authorization: `Bearer ${adminToken}`,
				},
				body: JSON.stringify({ laneCount: 6 }),
			},
		);
		expect(setLaneRes.status).toBe(200);

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

		// Configure task assignment for B14-T1: agent=codex, model=codex-standard, effortTier=high via UI (AC 1, E-347)
		await page.getByTestId('select-agent-B14-T1').selectOption('codex');

		const assignmentRow = page.locator('[data-task-editing-row="B14-T1"]');
		await assignmentRow.getByTestId('model-picker').getByRole('combobox').click();
		await page.getByRole('option', { name: 'codex-standard', exact: true }).click();
		await assignmentRow.getByTestId('effort-picker').getByRole('combobox').click();
		await page.getByRole('option', { name: '高档 (high)', exact: true }).click();

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
		const t1Draft = assignJson.drafts.find((d: any) => d.taskId === task1Id);
		expect(t1Draft).toBeDefined();
		expect(t1Draft.agentId).toBe('codex');
		expect(t1Draft.model).toBe('codex-standard');
		expect(t1Draft.effort?.tier).toBe('high');

		const assignedRow = page.getByTestId('assigned-row-B14-T1');
		await assignedRow.waitFor({ state: 'visible' });
		const rowText = await assignedRow.innerText();
		expect(rowText).toContain('codex-standard');
		expect(rowText).toMatch(/思考:\s*(high|高)/);

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
		expect(task2Id).toBeTruthy();

		// Write zero-output signal for B14-T2 before starting batch dispatch (E-348)
		const zeroSignalPath = join(daemon.dataDir, 'zero-output.signal');
		const zeroTmpSignalPath = join(tmpdir(), 'zero-output.signal');
		writeFileSync(zeroSignalPath, 'TRIGGER_ZERO_OUTPUT\n', 'utf8');
		writeFileSync(zeroTmpSignalPath, 'TRIGGER_ZERO_OUTPUT\n', 'utf8');
		// Make B14-T3's real review return an unstructured verdict (E-278).
		writeFileSync(join(daemon.dataDir, 'unstructured-rework.signal'), 'TRIGGER_UNSTRUCTURED_REVIEW\n');

		// Signal normal content for B14-T1
		const liveMsg = `B14_LIVE_CONTENT_${Date.now()}`;
		const sigFile = join(daemon.dataDir, 'agsched-fake-agent-1.signal');
		writeFileSync(sigFile, `${liveMsg}\n`, 'utf8');
		const holdSignal = join(daemon.dataDir, 'hold-implementation.signal');
		writeFileSync(holdSignal, 'WAIT_FOR_IMPLEMENT_METADATA\n', 'utf8');

		// Configure pipeline setting with reviewOverride and bughunt before dispatch (E-341, E-342, E-323)
		const pipelineRes = await fetch(`http://127.0.0.1:${daemon.port}/api/v1/settings/pipeline`, {
			method: 'PATCH',
			headers: {
				'Content-Type': 'application/json',
				Authorization: `Bearer ${adminToken}`,
			},
			body: JSON.stringify({
				bughunt: 1,
				wrapupMode: 'manual',
				reviewOverride: {
					agentId: 'grok',
					modelName: 'grok-beta',
					effortTier: 'medium',
				},
				wrapupAssignment: { mode: 'follow' },
			}),
		});
		expect(pipelineRes.status).toBe(200);

		const confirmBtn = page.locator('[data-action="confirm-dispatch"]');
		await confirmBtn.waitFor({ state: 'visible', timeout: 15000 });
		await expect.poll(async () => await confirmBtn.isEnabled(), { timeout: 15000 }).toBe(true);

		const startPromise = page.waitForResponse(
			(res) => res.request().method() === 'POST' && res.url().includes(`/batches/${activeBatchId}/start`),
			{ timeout: 15000 },
		);
		await confirmBtn.click();
		const startRes = await startPromise;
		expect([200, 201]).toContain(startRes.status());

		// Wait for run to appear in public API strictly from batch dispatch (AC 1, AC 2)
		await expect
			.poll(
				async () => {
					const r = await fetch(`http://127.0.0.1:${daemon.port}/api/v1/runs`, {
						headers: { Authorization: `Bearer ${adminToken}` },
					});
					if (!r.ok) return null;
					const body = (await r.json()) as {
						runs: Array<{ id: string; taskId: string; kind: string; assignmentSource?: string }>;
					};
					const run = body.runs.find((entry) => entry.taskId === task1Id && entry.kind === 'implement');
					if (run) {
						currentRunId = run.id;
						return run.id;
					}
					return null;
				},
				{ timeout: 20000, interval: 500 },
			)
			.toBeTruthy();

		// Assert RunDto public API fields: assignmentSource resolves accurately (E-341, E-347)
		const runDetailRes = await fetch(
			`http://127.0.0.1:${daemon.port}/api/v1/runs/${currentRunId}`,
			{ headers: { Authorization: `Bearer ${adminToken}` } },
		);
		expect(runDetailRes.status).toBe(200);
		const runDetail = (await runDetailRes.json()) as {
			run: { id: string; laneNo: number; assignmentSource: string; modelName: string; effort: any };
		};
		expect(runDetail.run.assignmentSource).toBe('task');
		expect(runDetail.run.modelName).toBe('codex-standard');
		expect(runDetail.run.effort?.tier).toBe('high');

		// Navigate to run detail page to verify SSE chunk arrives in DOM (AC 2, E-10)
		await page.goto(`http://127.0.0.1:${daemon.port}/#/run/${currentRunId}`, {
			waitUntil: 'domcontentloaded',
		});
		const liveLocator = page.locator(`text=${liveMsg}`).first();
		await liveLocator.waitFor({ state: 'visible', timeout: 25000 });
		expect(await liveLocator.isVisible()).toBe(true);

		// Navigate to deck #/ to verify stream column ref-bar rendered with assignment source (AC 1, E-347)
		await page.goto(`http://127.0.0.1:${daemon.port}/#/`, { waitUntil: 'domcontentloaded' });
		const observedLane = page.locator(
			`[data-stream-column="true"][data-lane-no="${runDetail.run.laneNo}"]`,
		);
		const refBar = observedLane.locator('[data-ref-bar="true"]');
		await refBar.waitFor({ state: 'visible', timeout: 15000 });
		const sourceField = observedLane.locator('[data-field="ref-source"]');
		await sourceField.waitFor({ state: 'visible', timeout: 10000 });
		const sourceText = await sourceField.innerText();
		expect(sourceText).toMatch(/任务/);
		// Arm the target fault before releasing the implementation into review and bughunt.
		const targetWorktreePath = getRunFromDb(daemon.dataDir, currentRunId)?.worktree_path;
		expect(targetWorktreePath).toBeTruthy();
		writeFileSync(
			join(daemon.dataDir, 'bughunt-fail.signal'),
			JSON.stringify({ taskId: task1Id }),
			'utf8',
		);
		rmSync(holdSignal, { force: true });

		// 清理 liveMsg 信号文件，避免干扰后续阶段
		if (existsSync(sigFile)) rmSync(sigFile, { force: true });
		const tmpSig = join(tmpdir(), 'agsched-fake-agent-1.signal');
		if (existsSync(tmpSig)) rmSync(tmpSig, { force: true });

		// Record state frame 3
		recordedFrames.push(
			await captureStateFrame(page, 'frame-3-implement-ref-bar', '真实派发、SSE 到 DOM 及参照条显示任务指派'),
		);
	});

	// ─────────────────────────────────────────────────────────────────────────
	// Step 4: 审查阶段覆盖、跨家映射与查 bug 阶段链 (AC 1, AC 2, M8-T9, E-341, E-342, E-347, E-323)
	// ─────────────────────────────────────────────────────────────────────────
	it('step 4: 审查阶段覆盖、跨家映射与查 bug 阶段链 (AC 1, AC 2, M8-T9, E-341, E-342, E-347, E-323)', async () => {
		expect(currentRunId).toBeTruthy();

		// Configure pipeline setting with reviewOverride and bughunt (E-341, E-342, E-323)
		const pipelineRes = await fetch(`http://127.0.0.1:${daemon.port}/api/v1/settings/pipeline`, {
			method: 'PATCH',
			headers: {
				'Content-Type': 'application/json',
				Authorization: `Bearer ${adminToken}`,
			},
			body: JSON.stringify({
				bughunt: 1,
				wrapupMode: 'manual',
				reviewOverride: {
					agentId: 'grok',
					modelName: 'grok-beta',
					effortTier: 'medium',
				},
				wrapupAssignment: { mode: 'follow' },
			}),
		});
		expect(pipelineRes.status).toBe(200);

		// 等待实施运行由于机械检查通过（子进程产生代码 diff），自动触发审查运行
		let reviewRunId: string | null = null;
		await expect
			.poll(
				async () => {
					const r = await fetch(`http://127.0.0.1:${daemon.port}/api/v1/runs`, {
						headers: { Authorization: `Bearer ${adminToken}` },
					});
					if (!r.ok) return null;
					const b = (await r.json()) as { runs: any[] };
					const rRun = b.runs.find((entry) => entry.taskId === task1Id && entry.kind === 'review');
					if (rRun) {
						reviewRunId = rRun.id;
						return rRun.id;
					}
					return null;
				},
				{ timeout: 30000 },
			)
			.toBeTruthy();

		expect(reviewRunId).toBeTruthy();

		// 核对审查运行 RunDto、指派快照、参照条 (AC 1, AC 2, M8-T9, E-341, E-342, E-347)
		const reviewDetailRes = await fetch(`http://127.0.0.1:${daemon.port}/api/v1/runs/${reviewRunId}`, {
			headers: { Authorization: `Bearer ${adminToken}` },
		});
		expect(reviewDetailRes.status).toBe(200);
		const reviewDetail = (await reviewDetailRes.json()) as {
			run: {
				id: string;
				assignmentSource: string;
				agentId: string;
				modelName: string;
				effort: any;
				parentRunId: string;
			};
		};
		expect(reviewDetail.run.assignmentSource).toBe('review_override');
		expect(reviewDetail.run.agentId).toBe('grok');
		expect(reviewDetail.run.modelName).toBe('grok-beta');
		expect(reviewDetail.run.effort?.tier).toBe('medium');
		expect(reviewDetail.run.parentRunId).toBe(currentRunId);

		// 核对跨家子快照 (E-304, E-352)
		const reviewRunDb = getRunFromDb(daemon.dataDir, reviewRunId);
		expect(reviewRunDb?.snapshot_id).toBeTruthy();
		const reviewSnap = getSnapshotFromDb(daemon.dataDir, reviewRunDb.snapshot_id);
		expect(reviewSnap?.parent_snapshot_id).toBeTruthy();

		// 在页面上核对参照条独立呈现审查覆盖
		await page.goto(`http://127.0.0.1:${daemon.port}/#/`, { waitUntil: 'domcontentloaded' });
		const deckRefSources = page.locator('[data-field="ref-source"]');
		await deckRefSources.first().waitFor({ state: 'visible', timeout: 15000 });
		await expect
			.poll(
				async () => {
					const texts = await deckRefSources.allInnerTexts();
					return texts.some((t) => /审查/i.test(t));
				},
				{ timeout: 15000, interval: 1000 },
			)
			.toBe(true);

		// Step 3 armed this task's first bughunt before releasing the implementation.
		const bughuntFailSignalPath = join(daemon.dataDir, 'bughunt-fail.signal');

		// 等待审查运行完成并触发查 bug 运行 (bughunt)，此时因信号真实失败转入 failed (AC 2, M8-T9, E-323)
		let failedBughuntRunId: string | null = null;
		await expect
			.poll(
				async () => {
					const r = await fetch(`http://127.0.0.1:${daemon.port}/api/v1/runs`, {
						headers: { Authorization: `Bearer ${adminToken}` },
					});
					if (!r.ok) return null;
					const b = (await r.json()) as { runs: any[] };
					const bRun = b.runs.find(
						(entry) => entry.taskId === task1Id && entry.kind === 'bughunt' && entry.state === 'failed',
					);
					if (bRun) {
						failedBughuntRunId = bRun.id;
						return bRun.id;
					}
					return null;
				},
				{ timeout: 35000, interval: 1000 },
			)
			.toBeTruthy();

		expect(failedBughuntRunId).toBeTruthy();

		// 断言 E-323 真实业务规约：
		// 1. 父实施运行转入 awaiting_human，queuedReason === 'bughunt_failed'
		const parentRunAfterFail = (await (
			await fetch(`http://127.0.0.1:${daemon.port}/api/v1/runs/${currentRunId}`, {
				headers: { Authorization: `Bearer ${adminToken}` },
			})
		).json()) as { run: { state: string; queuedReason?: string; reworkCount?: number } };
		expect(parentRunAfterFail.run.state).toBe('awaiting_human');
		expect(parentRunAfterFail.run.queuedReason).toBe('bughunt_failed');
		// 2. 查 bug 失败不计入实施返工次数 (E-323: reworkCount 不增加)
		expect(parentRunAfterFail.run.reworkCount ?? 0).toBe(0);

		// 3. 调度器开启 comment === 'bughunt_failed' 的闸门
		let bughuntGateId: string | null = null;
		await expect
			.poll(
				async () => {
					const gatesRes = await fetch(`http://127.0.0.1:${daemon.port}/api/v1/gates`, {
						headers: { Authorization: `Bearer ${adminToken}` },
					});
					if (!gatesRes.ok) return false;
					const gatesData = (await gatesRes.json()) as { gates: any[] };
					const g = gatesData.gates.find(
						(item) => item.state === 'waiting' && item.taskId === task1Id && item.comment === 'bughunt_failed',
					);
					if (g) {
						bughuntGateId = g.id;
						return true;
					}
					return false;
				},
				{ timeout: 15000 },
			)
			.toBe(true);
		expect(bughuntGateId).toBeTruthy();
		const beforeRerunRuns = (await (
			await fetch(`http://127.0.0.1:${daemon.port}/api/v1/runs`, { headers: { Authorization: `Bearer ${adminToken}` } })
		).json()) as { runs: Array<{ id: string; taskId: string; attemptNo: number }> };
		const taskRunsBefore = beforeRerunRuns.runs.filter((run) => run.taskId === task1Id);
		const highestAttemptBefore = Math.max(...taskRunsBefore.map((run) => run.attemptNo));
		const failedBughuntBefore = getRunFromDb(daemon.dataDir, failedBughuntRunId!);

		// 4. 清理 bughunt-fail 信号，通过合法 POST /runs/:id/rerun 触发重跑 (AC 2, E-323)
		if (existsSync(bughuntFailSignalPath)) rmSync(bughuntFailSignalPath, { force: true });

		const rerunKey = `bughunt-rerun-${Date.now()}`;
		const bughuntRerunRes = await fetch(`http://127.0.0.1:${daemon.port}/api/v1/runs/${failedBughuntRunId}/rerun`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
			body: JSON.stringify({ idempotencyKey: rerunKey }),
		});
		const bughuntRerunBody = (await bughuntRerunRes.json()) as {
			run: { id: string; kind: string; parentRunId: string; attemptNo: number; agentId: string; modelName: string };
		};
		bughuntRerunEvidence = { status: bughuntRerunRes.status, response: bughuntRerunBody, before: taskRunsBefore, gateId: bughuntGateId };
		writeFileSync(join(artifactsDir, 'b14-bughunt-rerun.json'), redactSensitiveData(JSON.stringify(bughuntRerunEvidence, null, 2)), 'utf8');
		expect(bughuntRerunRes.status).toBe(200);
		expect(bughuntRerunBody.run.kind).toBe('bughunt');
		expect(bughuntRerunBody.run.id).not.toBe(failedBughuntRunId);
		expect(bughuntRerunBody.run.id).not.toBe(currentRunId);
		expect(bughuntRerunBody.run.parentRunId).toBe(currentRunId);
		expect(bughuntRerunBody.run.attemptNo).toBe(highestAttemptBefore + 1);
		expect(bughuntRerunBody.run.agentId).toBe(failedBughuntBefore.agent_id);
		expect(bughuntRerunBody.run.modelName).toBe(failedBughuntBefore.model_name);
		const rerunDb = getRunFromDb(daemon.dataDir, bughuntRerunBody.run.id);
		expect(rerunDb.snapshot_id).toBe(failedBughuntBefore.snapshot_id);
		expect(rerunDb.worktree_path).toBe(failedBughuntBefore.worktree_path);
		const replay = await fetch(`http://127.0.0.1:${daemon.port}/api/v1/runs/${failedBughuntRunId}/rerun`, {
			method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
			body: JSON.stringify({ idempotencyKey: rerunKey }),
		});
		expect(replay.status).toBe(200);
		expect((await replay.json()).run.id).toBe(bughuntRerunBody.run.id);

		// 5. 等待重跑后的 bughunt 运行启动并完成
		let recoveredBughuntRunId: string | null = null;
		await expect
			.poll(
				async () => {
					const r = await fetch(`http://127.0.0.1:${daemon.port}/api/v1/runs`, {
						headers: { Authorization: `Bearer ${adminToken}` },
					});
					if (!r.ok) return null;
					const b = (await r.json()) as { runs: any[] };
					const bRuns = b.runs.filter((entry) => entry.taskId === task1Id && entry.kind === 'bughunt');
					const latest = bRuns.find((entry) =>
						entry.id === bughuntRerunBody.run.id && entry.state === 'landed' &&
						entry.queuedReason === 'bughunt_clean' && entry.exitCode === 0 && entry.endedAt,
					);
					if (latest) {
						const resumedGatesResponse = await fetch(`http://127.0.0.1:${daemon.port}/api/v1/gates`, {
							headers: { Authorization: `Bearer ${adminToken}` },
						});
						if (!resumedGatesResponse.ok) return null;
						const resumedGates = (await resumedGatesResponse.json()) as { gates: Array<{ runId: string; kind: string; state: string; comment: string }> };
						if (!resumedGates.gates.some((gate) => gate.runId === currentRunId && gate.kind === 'review' && gate.state === 'waiting' && gate.comment === 'review_manual_gate')) return null;
						recoveredBughuntRunId = latest.id;
						return latest.id;
					}
					return null;
				},
				{ timeout: 35000, interval: 1000 },
			)
			.toBeTruthy();

		expect(recoveredBughuntRunId).toBeTruthy();
		const bughuntDetailRes = await fetch(`http://127.0.0.1:${daemon.port}/api/v1/runs/${recoveredBughuntRunId}`, {
			headers: { Authorization: `Bearer ${adminToken}` },
		});
		expect(bughuntDetailRes.status).toBe(200);
		const bughuntDetail = (await bughuntDetailRes.json()) as {
			run: { id: string; kind: string; parentRunId: string };
		};
		expect(bughuntDetail.run.kind).toBe('bughunt');
		expect(bughuntDetail.run.parentRunId).toBe(currentRunId);
		const gatesAfterRerun = (await (
			await fetch(`http://127.0.0.1:${daemon.port}/api/v1/gates?pending=false`, { headers: { Authorization: `Bearer ${adminToken}` } })
		).json()) as { gates: Array<{ id: string; taskId: string; runId: string; kind: string; state: string; comment: string }> };
		expect(gatesAfterRerun.gates.find((gate) => gate.id === bughuntGateId)).toMatchObject({ state: 'decided', comment: 'superseded' });
		const resumedReviewGate = gatesAfterRerun.gates.find((gate) =>
			gate.taskId === task1Id && gate.runId === currentRunId && gate.state === 'waiting' &&
			gate.kind === 'review' && gate.comment === 'review_manual_gate',
		);
		expect(resumedReviewGate).toBeTruthy();
		if (!resumedReviewGate) throw new Error('Missing resumed review gate');
		const resumeResponse = await fetch(`http://127.0.0.1:${daemon.port}/api/v1/gates/${resumedReviewGate.id}/decide`, {
			method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
			body: JSON.stringify({ decision: 'pass' }),
		});
		expect(resumeResponse.status).toBe(200);
		const continuedGates = (await (
			await fetch(`http://127.0.0.1:${daemon.port}/api/v1/gates?pending=false`, { headers: { Authorization: `Bearer ${adminToken}` } })
		).json()) as typeof gatesAfterRerun;
		expect(continuedGates.gates.find((gate) => gate.id === resumedReviewGate.id)).toMatchObject({ state: 'decided', decision: 'pass' });
		expect(continuedGates.gates.some((gate) => gate.runId === currentRunId && gate.kind === 'landing' && gate.state === 'waiting')).toBe(true);
		bughuntRerunEvidence = { ...(bughuntRerunEvidence as object), recovered: bughuntDetail, gatesAfterRerun, continuedGates };
		writeFileSync(join(artifactsDir, 'b14-bughunt-rerun.json'), redactSensitiveData(JSON.stringify(bughuntRerunEvidence, null, 2)), 'utf8');

		// Record state frame 4
		recordedFrames.push(
			await captureStateFrame(page, 'frame-4-review-and-bughunt', '审查覆盖与查 bug 阶段运行及参照条呈现'),
		);
	});

	// ─────────────────────────────────────────────────────────────────────────
	// Step 5: 真实 spawn 零产出退出转人工、审批卡呈现与多流并置 (AC 2, E-348, E-106, E-157)
	// ─────────────────────────────────────────────────────────────────────────
	it('step 5: 真实 spawn 零产出退出转人工、审批卡呈现与多流并置 (AC 2, E-348, E-106, E-157)', async () => {
		expect(activeBatchId).toBeTruthy();
		expect(task2Id).toBeTruthy();

		// Wait for zero-output transition on task2 (B14-T2): run exits before output -> awaiting_human (E-348)
		let zeroRunId: string | null = null;
		await expect
			.poll(
				async () => {
					const r = await fetch(`http://127.0.0.1:${daemon.port}/api/v1/runs`, {
						headers: { Authorization: `Bearer ${adminToken}` },
					});
					if (!r.ok) return null;
					const b = (await r.json()) as {
						runs: Array<{ id: string; taskId: string; state: string; queuedReason?: string }>;
					};
					const zeroRun = b.runs.find(
						(entry) => entry.taskId === task2Id && entry.state === 'awaiting_human',
					);
					if (zeroRun) {
						zeroRunId = zeroRun.id;
						return zeroRun.id;
					}
					return null;
				},
				{ timeout: 25000 },
			)
			.toBeTruthy();

		expect(zeroRunId).toBeTruthy();

		const zeroRunDetail = (await (
			await fetch(`http://127.0.0.1:${daemon.port}/api/v1/runs/${zeroRunId}`, {
				headers: { Authorization: `Bearer ${adminToken}` },
			})
		).json()) as { run: { state: string; queuedReason: string; exitCode: number } };
		expect(zeroRunDetail.run.state).toBe('awaiting_human');
		expect(zeroRunDetail.run.queuedReason).toBe('exited_before_output');

		const zeroRunDb = getRunFromDb(daemon.dataDir, zeroRunId);
		expect(zeroRunDb?.snapshot_id).toBeTruthy();

		// 断言泳道释放 (E-348): task2 的 laneNo 必须已置空 (null)
		const task2Res = await fetch(`http://127.0.0.1:${daemon.port}/api/v1/snapshot`, {
			headers: { Authorization: `Bearer ${adminToken}` },
		});
		const snapTasks = (await task2Res.json()).tasks;
		const task2Snap = snapTasks.find((t: any) => t.id === task2Id);
		expect(task2Snap?.laneNo == null).toBe(true);

		// 检查 gate: 必须存在 state === 'waiting' 且 comment === 'exited_before_output' 的 GateDto
		let zeroOutputGateId: string | null = null;
		let zeroOutputGateContext: any = null;
		await expect
			.poll(
				async () => {
					const gatesRes = await fetch(`http://127.0.0.1:${daemon.port}/api/v1/gates`, {
						headers: { Authorization: `Bearer ${adminToken}` },
					});
					if (!gatesRes.ok) return false;
					const gatesData = (await gatesRes.json()) as {
						gates: Array<{ id: string; state: string; taskId?: string; comment?: string; context?: any }>;
					};
					const g = gatesData.gates.find(
						(item) => item.state === 'waiting' && item.taskId === task2Id && item.comment === 'exited_before_output',
					);
					if (g) {
						zeroOutputGateId = g.id;
						zeroOutputGateContext = g.context;
						return true;
					}
					return false;
				},
				{ timeout: 15000 },
			)
			.toBe(true);

		expect(zeroOutputGateId).toBeTruthy();
		// Verify zero-output gate has valid context in daemon: stderrTail lines, redacted error, and login probe (E-348)
		expect(zeroOutputGateContext).toBeDefined();
		expect(zeroOutputGateContext.stderrTail).toBeDefined();
		expect(zeroOutputGateContext.stderrTail.lines?.length).toBeGreaterThan(0);
		const stderrLinesJson = JSON.stringify(zeroOutputGateContext.stderrTail.lines);
		expect(stderrLinesJson).toContain('authentication required or invalid model');
		expect(zeroOutputGateContext.exitCode).toBe(1);
		expect(zeroOutputGateContext.exitSignal ?? null).toBeNull();
		expect(zeroOutputGateContext.login).toBeDefined();
		await expect
			.poll(
				() => {
					const events = liveEvents?.events.filter((event) => event.runId === zeroRunId) ?? [];
					const exited = events.find((event) => event.kind === 'run.exited');
					const states = events.filter((event) => event.kind === 'run.state_changed');
					const released = events.find(
						(event) => event.kind === 'lane.released' && event.payload.reason === 'awaiting_human',
					);
					return Boolean(
						exited?.payload.exitCode === 1 &&
							JSON.stringify(exited.payload.stderrTail).includes('authentication required or invalid model') &&
							states.some((event) => event.payload.to === 'reviewing') &&
							states.some((event) => event.payload.to === 'awaiting_human') &&
							released,
					);
				},
				{ timeout: 15000, interval: 250 },
			)
			.toBe(true);
		// The B14-T3 review must preserve its unstructured original text and open
		// a real human gate; the invalid-ID HTTP checks used previously proved neither.
		let incompleteReviewText = '';
		await expect
			.poll(
				async () => {
					const runsRes = await fetch(`http://127.0.0.1:${daemon.port}/api/v1/runs`, {
						headers: { Authorization: `Bearer ${adminToken}` },
					});
					if (!runsRes.ok) return false;
					const runs = (await runsRes.json()) as {
						runs: Array<{ taskId: string; kind: string; reviewVerdict?: string; reworkText?: string }>;
					};
					const review = runs.runs.find(
						(run) => run.taskId === task3Id && run.kind === 'review' && run.reviewVerdict === 'incomplete',
					);
					incompleteReviewText = review?.reworkText ?? '';
					return incompleteReviewText.includes('Please revise the implementation code thoroughly');
				},
				{ timeout: 30000, interval: 500 },
			)
			.toBe(true);
		const incompleteGateRes = await fetch(`http://127.0.0.1:${daemon.port}/api/v1/gates`, {
			headers: { Authorization: `Bearer ${adminToken}` },
		});
		expect(incompleteGateRes.status).toBe(200);
		const incompleteGates = (await incompleteGateRes.json()) as {
			gates: Array<{ taskId: string; state: string }>;
		};
		expect(incompleteGates.gates.some((gate) => gate.taskId === task3Id && gate.state === 'waiting')).toBe(true);

		// Navigate to deck #/ to assert gate card rendering in DOM (E-348, E-106)
		await page.goto(`http://127.0.0.1:${daemon.port}/#/`, { waitUntil: 'domcontentloaded' });
		const gateCard = page
			.locator('[data-component="gate-card"]')
			.filter({ hasText: 'agent 未产出任何内容就退出' })
			.first();
		await gateCard.waitFor({ state: 'visible', timeout: 15000 });
		const cardText = await gateCard.innerText();
		expect(cardText).toContain('agent 未产出任何内容就退出，常见原因：未登录、模型名不可用、参数被拒');
		expect(cardText).toMatch(/authentication required|token expired/);
		await page.getByText('Please revise the implementation code thoroughly', { exact: false }).first().waitFor({
			state: 'visible',
			timeout: 15000,
		});
		const deliverRaw = page.getByRole('button', { name: '投递原文到实施会话' }).first();
		await deliverRaw.waitFor({ state: 'visible', timeout: 15000 });

		// E-106: 无条件断言桌面端同时 5 个以上运行流并置
		const streamLanes = page.locator('[data-component="run-lane"], [data-stream-column="true"]');
		await expect
			.poll(async () => await streamLanes.count(), { timeout: 15000 })
			.toBeGreaterThanOrEqual(5);

		// E-106: 无条件断言常驻停止流控件存在并可见
		const stopControl = page.locator('[data-action="stop-stream"]').first();
		await stopControl.waitFor({ state: 'visible', timeout: 10000 });
		expect(await stopControl.isVisible()).toBe(true);

		// Record state frame 5
		recordedFrames.push(
			await captureStateFrame(page, 'frame-5-zero-output-gate', '零产出退出转人工审批卡呈现与 stderr 尾'),
		);

		// Cleanup zero-output signal so subsequent runs can proceed
		const zeroSignalPath = join(daemon.dataDir, 'zero-output.signal');
		const zeroTmpSignalPath = join(tmpdir(), 'zero-output.signal');
		if (existsSync(zeroSignalPath)) rmSync(zeroSignalPath, { force: true });
		if (existsSync(zeroTmpSignalPath)) rmSync(zeroTmpSignalPath, { force: true });

		// 触发 rerun 重跑 B14-T2（AC 2, E-331, R1），走正常生命周期完成实施与审查
		const rerunRes = await fetch(`http://127.0.0.1:${daemon.port}/api/v1/runs/${zeroRunId}/rerun`, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				Authorization: `Bearer ${adminToken}`,
			},
			body: JSON.stringify({
				idempotencyKey: `rerun-task2-${Date.now()}`,
			}),
		});
		expect([200, 201]).toContain(rerunRes.status);
	});

	// ─────────────────────────────────────────────────────────────────────────
	// Step 6: 批次正式落地、HEAD 检测、收口启动、八段报告与落地清单呈现 (AC 3, M9-T20, E-157, E-286, E-290, E-297, E-74)
	// ─────────────────────────────────────────────────────────────────────────
	it(
		'step 6: 批次正式落地、HEAD 检测、收口启动、八段报告与落地清单呈现 (AC 3, M9-T20, E-157, E-286, E-290, E-297, E-74)',
		async () => {
			expect(activeBatchId).toBeTruthy();

		let step6PollCount = 0;
		// 1. 等待并审批所有 landing 闸门推进任务落地（AC 2b, R2，严格禁止直接改写数据库！）
		const allBatchTaskIds = [task1Id, task2Id, task3Id, task4Id, task5Id].filter(Boolean);
		await expect
			.poll(
				async () => {
					step6PollCount++;
					const gatesRes = await fetch(`http://127.0.0.1:${daemon.port}/api/v1/gates`, {
						headers: { Authorization: `Bearer ${adminToken}` },
					});
					if (!gatesRes.ok) return 0;
					const gatesData = (await gatesRes.json()) as { gates: any[] };
					const pendingGates = gatesData.gates.filter(
						(g) => g.state === 'waiting' && allBatchTaskIds.includes(g.taskId),
					);

					for (const g of pendingGates) {
						const decideRes = await fetch(`http://127.0.0.1:${daemon.port}/api/v1/gates/${g.id}/decide`, {
							method: 'POST',
							headers: {
								'Content-Type': 'application/json',
								Authorization: `Bearer ${adminToken}`,
							},
							body: JSON.stringify({ decision: 'pass' }),
						});
						console.log(`[STEP 6 POLL #${step6PollCount}] Decided gate ${g.id} (kind: ${g.kind}, comment: ${g.comment}): status=${decideRes.status}`);
					}
					const snapRes = await fetch(`http://127.0.0.1:${daemon.port}/api/v1/snapshot`, {
						headers: { Authorization: `Bearer ${adminToken}` },
					});
					if (!snapRes.ok) return 0;
					const snap = await snapRes.json();
					const landedTasks = snap.tasks.filter(
						(t: any) => allBatchTaskIds.includes(t.id) && t.state === 'landed',
					);
					if (step6PollCount % 2 === 1) {
						const runsRes = await fetch(`http://127.0.0.1:${daemon.port}/api/v1/runs`, {
							headers: { Authorization: `Bearer ${adminToken}` },
						});
						const runsData = runsRes.ok ? (await runsRes.json()).runs : [];
						console.log(`[STEP 6 POLL #${step6PollCount}] landedTasks: ${landedTasks.length}/${allBatchTaskIds.length}, pendingGates: ${pendingGates.length}`);
					}
					return landedTasks.length;
				},
				{ timeout: 60000, interval: 1500 },
			)
			.toBe(5);

		// 2. 真实将变更合入主干 Git HEAD (R2)，使 isBranchInHead 判定通过
		try {
			const worktreesRaw = execFileSync('git', ['-C', gitRepoDir, 'worktree', 'list', '--porcelain'], {
				encoding: 'utf8',
			});
			console.log('[STEP 6 GIT] worktreesRaw:\n' + worktreesRaw);
			const wtPaths = worktreesRaw
				.split(/\r?\n/)
				.filter((l) => l.startsWith('worktree '))
				.map((l) => l.slice('worktree '.length).trim());
			for (const wt of wtPaths) {
				try {
					execFileSync('git', ['-C', wt, 'config', 'user.name', 'Batch14 E2E'], { stdio: 'ignore' });
					execFileSync('git', ['-C', wt, 'config', 'user.email', 'b14-e2e@example.invalid'], { stdio: 'ignore' });
					execFileSync('git', ['-C', wt, 'add', '.'], { stdio: 'ignore' });
					execFileSync(
						'git',
						['-C', wt, '-c', 'user.name=Batch14 E2E', '-c', 'user.email=b14-e2e@example.invalid', 'commit', '-m', 'Worktree changes'],
						{ stdio: 'ignore' },
					);
				} catch {}
			}
		} catch (err: any) {
			console.error('[STEP 6 GIT] Error listing worktrees:', err.message);
		}

		try {
			execFileSync('git', ['-C', gitRepoDir, 'add', '.'], { stdio: 'ignore' });
			execFileSync(
				'git',
				['-C', gitRepoDir, '-c', 'user.name=Batch14 E2E', '-c', 'user.email=b14-e2e@example.invalid', 'commit', '-m', 'Initial main state'],
				{ stdio: 'ignore' },
			);
		} catch {}

		const rawBranchOutput = execFileSync('git', ['-C', gitRepoDir, 'branch', '-a'], { encoding: 'utf8' });
		console.log('[STEP 6 GIT] rawBranchOutput:\n' + rawBranchOutput);
		const allBranches = rawBranchOutput
			.split(/\r?\n/)
			.map((line) => line.replace(/^[*+ ]+/, '').trim())
			.filter((line) => line.length > 0 && !line.includes('HEAD') && line !== 'main');
		console.log('[STEP 6 GIT] All branches to merge:', allBranches);
		for (const branch of allBranches) {
			try {
				const mergeOut = execFileSync(
					'git',
					[
						'-C',
						gitRepoDir,
						'-c',
						'user.name=Batch14 E2E',
						'-c',
						'user.email=b14-e2e@example.invalid',
						'merge',
						'-X',
						'theirs',
						'--no-ff',
						'-m',
						`Merge ${branch} into HEAD`,
						branch,
					],
					{
						encoding: 'utf8',
					},
				);
				console.log(`[STEP 6 GIT] Merged ${branch}:`, mergeOut.trim());
			} catch (err: any) {
				console.error(`[STEP 6 GIT] Failed to merge ${branch}:`, err.message, err.stderr);
				try {
					execFileSync('git', ['-C', gitRepoDir, 'merge', '--abort'], { stdio: 'ignore' });
				} catch {}
			}
		}
		try {
			console.log(
				'[STEP 6 GIT] git log -n 5:\n',
				execFileSync('git', ['-C', gitRepoDir, 'log', '--oneline', '-n', '5'], { encoding: 'utf8' }),
			);
		} catch {}

		// 3. 等待调度器检测到分支已入 HEAD 并刷新 is_in_head (M8-T6, E-272)
		let inHeadPollCount = 0;
		await expect
			.poll(
				async () => {
					inHeadPollCount++;
					const r = await fetch(
						`http://127.0.0.1:${daemon.port}/api/v1/documents/${importedDocId}/batches`,
						{ headers: { Authorization: `Bearer ${adminToken}` } },
					);
					if (!r.ok) return false;
					const bData = (await r.json()) as { batches: any[] };
					const b = bData.batches.find((entry) => entry.id === activeBatchId);
					if (inHeadPollCount % 3 === 1) {
						console.log(`[STEP 6 IN_HEAD POLL #${inHeadPollCount}] batch:`, JSON.stringify({
							id: b?.id,
							state: b?.state,
							allLanded: b?.allLanded,
							allInHead: b?.allInHead,
							landedCount: b?.landedCount,
							notInHeadCount: b?.notInHeadCount,
							notInHeadTaskKeys: b?.notInHeadTaskKeys,
							canWrapup: b?.canWrapup,
						}));
					}
					// 严格断言全任务合入 HEAD 且具备收口条件 (R2: landedCount=5, notInHeadCount=0, canWrapup=true)
					return b?.canWrapup === true && b?.notInHeadCount === 0 && b?.landedCount === 5;
				},
				{ timeout: 60000, interval: 2000 },
			)
			.toBe(true);

		// Prepare 8-section wrapup report signal (E-286: RECORD says clean, but BUGS has unresolved item -> effective verdict is open; B1 has < 4 parts -> isWellFormed is false)
		const wrapupSignalPath = join(daemon.dataDir, 'wrapup.signal');
		const wrapupTmpSignalPath = join(tmpdir(), 'wrapup.signal');
		const wrapupReportText = `BATCH_SUMMARY
Batch 14 composition verification summary.

TESTS
pass: 8 tests passed, 0 failed

BUGS
B1 [S2] 涉及 B14-T1：并发取数防反向覆盖异常 -> 慢请求延迟到达 -> 缺乏序列号防护

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

		// 4. Trigger batch wrapup via formal API (AC 3, E-157)
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
		expect([200, 201, 202]).toContain(wrapupTriggerRes.status);
		let wrapupRunId: string | null = null;
		await expect
			.poll(
				() => {
					const started = liveEvents?.events.find(
						(event) => event.kind === 'batch.wrapup_started' && event.payload.batchId === activeBatchId,
					);
					wrapupRunId = typeof started?.payload.runId === 'string' ? started.payload.runId : null;
					return wrapupRunId;
				},
				{ timeout: 15000, interval: 250 },
			)
			.toBeTruthy();

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
					const data = (await r.json()) as {
						wrapups: Array<{ id: string; verdict: string; declaredVerdict: string }>;
					};
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
			wrapups: Array<{ id: string; verdict: string; declaredVerdict: string; findings?: any[] }>;
		};
		const report = wrapupRecords.wrapups[0]!;
		expect(report.verdict).toBe('open');
		expect(report.declaredVerdict).toBe('clean');
		await expect
			.poll(
				() =>
					liveEvents?.events.some(
						(event) =>
							event.kind === 'batch.wrapup_finished' &&
							event.payload.batchId === activeBatchId &&
							event.payload.runId === wrapupRunId &&
							event.payload.wrapupId === report.id &&
							event.payload.verdict === 'open',
						) ?? false,
				{ timeout: 15000, interval: 250 },
			)
			.toBe(true);

		// 在页面上断言收口报告组件渲染有效裁定与落地清单 (E-286, E-74)
		const reportPanel = page.locator('[data-component="wrapup-report"]').first();
		await reportPanel.waitFor({ state: 'visible', timeout: 15000 });
		const reportDomText = await reportPanel.innerText();
		expect(reportDomText).toContain('B1');
		expect(reportDomText).toMatch(/open|未通过|自报|clean/i);

		// 断言格式不全提示徽标呈现 (E-286: 少于 4 段式时渲染 data-chip="ill-formed"「格式不全」)
		const illFormedChip = page.locator('[data-chip="ill-formed"]').first();
		await illFormedChip.waitFor({ state: 'visible', timeout: 15000 });
		expect(await illFormedChip.isVisible()).toBe(true);
		expect(await illFormedChip.innerText()).toContain('格式不全');

		// 断言收口泳道存在并可见 (M9-T20)
		const wrapupLane = page.locator('[data-kind="wrapup"], [data-field="wrapup-head"], [data-component="wrapup-panel"]').first();
		await wrapupLane.waitFor({ state: 'visible', timeout: 10000 });
		expect(await wrapupLane.isVisible()).toBe(true);

		// Record state frame 6
		recordedFrames.push(
			await captureStateFrame(page, 'frame-6-wrapup-report', '收口报告呈现有效裁定 open 与自报 clean 不一致及格式不全呈现'),
		);
	}, 180000);

	// ─────────────────────────────────────────────────────────────────────────
	// Step 7: 收口失败后的半成品工作区、转人工与解析失败呈现 (AC 3, E-295, E-297)
	// ─────────────────────────────────────────────────────────────────────────
	it('step 7: 收口失败后的半成品工作区、转人工与解析失败呈现 (AC 3, E-295, E-297)', async () => {
		expect(activeBatchId).toBeTruthy();
		writeFileSync(join(daemon.dataDir, 'wrapup-fail.signal'), 'TRIGGER_WRAPUP_FAIL\n');
		const secondTrigger = await fetch(`http://127.0.0.1:${daemon.port}/api/v1/batches/${activeBatchId}/wrapup`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
			body: JSON.stringify({ agentId: 'codex', idempotencyKey: `wrapup-fail-${Date.now()}` }),
		});
		expect([200, 201, 202]).toContain(secondTrigger.status);
		let failedWrapupRunId: string | null = null;
		await expect
			.poll(
				() => {
					const started = liveEvents?.events.find(
						(event) =>
							event.kind === 'batch.wrapup_started' &&
							event.payload.batchId === activeBatchId &&
							event.payload.round === 2,
					);
					failedWrapupRunId = typeof started?.payload.runId === 'string' ? started.payload.runId : null;
					return failedWrapupRunId;
				},
				{ timeout: 15000, interval: 250 },
			)
			.toBeTruthy();
		await expect
			.poll(
				() =>
					liveEvents?.events.some(
						(event) =>
							event.kind === 'batch.wrapup_finished' &&
							event.payload.runId === failedWrapupRunId &&
							event.payload.verdict === 'unparsed' &&
							event.payload.batchState === 'needs_attention',
						) ?? false,
				{ timeout: 30000, interval: 250 },
			)
			.toBe(true);
		const failedRunResponse = await fetch(`http://127.0.0.1:${daemon.port}/api/v1/runs/${failedWrapupRunId}`, {
			headers: { Authorization: `Bearer ${adminToken}` },
		});
		expect(failedRunResponse.status).toBe(200);
		const failedRun = (await failedRunResponse.json()) as {
			run: { state: string; worktreePath: string | null; branchName: string | null };
		};
		expect(failedRun.run.state).toBe('awaiting_human');
		expect(failedRun.run.worktreePath).toBeTruthy();
		expect(readFileSync(join(failedRun.run.worktreePath!, 'e2e/b14-t1.ts'), 'utf8')).toContain(
			'unfinished wrapup change',
		);
		const failedGateResponse = await fetch(`http://127.0.0.1:${daemon.port}/api/v1/gates`, {
			headers: { Authorization: `Bearer ${adminToken}` },
		});
		const failedGates = (await failedGateResponse.json()) as {
			gates: Array<{ runId: string; state: string; taskId: string | null }>;
		};
		expect(
			failedGates.gates.some(
				(gate) => gate.runId === failedWrapupRunId && gate.state === 'waiting' && gate.taskId === null,
			),
		).toBe(true);

		// The browser receives the failed round and offers the original run.
		await page.getByText('解析失败', { exact: true }).first().waitFor({ state: 'visible', timeout: 15000 });
		await page.getByText('直链原文', { exact: true }).first().waitFor({ state: 'visible', timeout: 15000 });
		// E-297: 批次树挂出「批次收口 · 第 N 轮」入口行
		const wrapupTreeItem = page.locator('text=/批次收口/').first();
		await wrapupTreeItem.waitFor({ state: 'visible', timeout: 10000 });
		expect(await wrapupTreeItem.isVisible()).toBe(true);
		await page.goto(`http://127.0.0.1:${daemon.port}/#/landing/${task1Id}`, {
			waitUntil: 'domcontentloaded',
		});
		const unfinishedRow = page.locator(`[data-batch-landing-row="wrapup"][data-run-id="${failedWrapupRunId}"]`);
		await unfinishedRow.waitFor({ state: 'visible', timeout: 15000 });
		expect(await unfinishedRow.innerText()).toContain('未完成的收口改动');
		expect(await unfinishedRow.innerText()).toContain(failedRun.run.branchName);
		// Record state frame 7
		recordedFrames.push(
			await captureStateFrame(page, 'frame-7-failed-wrapup', '收口失败、半成品分支保留与解析失败原文入口'),
		);
	});

	// ─────────────────────────────────────────────────────────────────────────
	// Step 8: 真实浏览器状态驱动 GIF 录制完成与发布门禁架构断言 (AC 4, E-265)
	// ─────────────────────────────────────────────────────────────────────────
	it('step 8: 真实浏览器状态驱动 GIF 录制完成与发布门禁架构断言 (AC 4, E-265)', async () => {
		// Encode captured state frames into real GIF89a file (AC 4)
		expect(recordedFrames.length).toBeGreaterThanOrEqual(6);
		const gifBuffer = encodeGif89a(recordedFrames, FRAME_WIDTH, FRAME_HEIGHT);
		expect(gifBuffer.length).toBeGreaterThan(1000);

		const gifPath = join(artifactsDir, 'batch-14-composition.gif');
		writeFileSync(gifPath, gifBuffer);
		expect(existsSync(gifPath)).toBe(true);

		// Record current HEAD commit hash for recorded evidence
		let currentGitHead = '';
		try {
			currentGitHead = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
		} catch {}
		expect(currentGitHead).toMatch(/^[0-9a-f]{40}$/);

		// Write timeline JSON
		const timelineData = {
			suite: 'R14-T23602992 Batch 14 Composition Acceptance',
			generatedAt: new Date().toISOString(),
			gitHead: currentGitHead,
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
