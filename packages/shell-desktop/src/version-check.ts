/**
 * Version check and compatibility verification for the Tauri desktop shell (AC 1, E-14).
 *
 * Requirements:
 * - On startup, queries the daemon's API version (GET /api/v1/version).
 * - When incompatible, prompts the user to upgrade instead of throwing low-level errors (E-14).
 * - Network failures or malformed responses are captured gracefully without throwing bottom-level exceptions.
 */

export const SUPPORTED_API_VERSION = 'v1' as const;
export const DEFAULT_VERSION_CHECK_TIMEOUT_MS = 5000;

export type VersionIncompatibilityReason = 'incompatible' | 'unreachable' | 'malformed';

export interface VersionCheckCompatible {
	readonly compatible: true;
	readonly apiVersion: string;
	readonly daemonVersion?: string;
	readonly nodeVersion?: string;
}

export interface VersionCheckIncompatible {
	readonly compatible: false;
	readonly reason: VersionIncompatibilityReason;
	readonly apiVersion?: string;
	readonly expectedVersion: string;
	readonly message: string;
	readonly upgradePrompt: string;
}

export type VersionCheckResult = VersionCheckCompatible | VersionCheckIncompatible;

export interface VersionCheckOptions {
	readonly baseUrl?: string;
	readonly expectedVersion?: string;
	readonly fetcher?: (url: string, init?: RequestInit) => Promise<Response>;
	readonly timeoutMs?: number;
}

/**
 * Parses major version from string like 'v1', '1.0.0', 'v2.1', '2'.
 * Returns NaN when unrecognized.
 */
export function extractMajorVersion(versionStr: string): number {
	if (!versionStr || typeof versionStr !== 'string') {
		return Number.NaN;
	}
	const cleaned = versionStr.trim().replace(/^v/i, '');
	const firstSegment = cleaned.split('.')[0] ?? '';
	const major = Number.parseInt(firstSegment, 10);
	return Number.isFinite(major) ? major : Number.NaN;
}

/**
 * Checks whether detected server API version is compatible with the expected client API version (E-14).
 */
export function isApiVersionCompatible(
	detectedVersion: string | null | undefined,
	expectedVersion: string = SUPPORTED_API_VERSION,
): boolean {
	if (!detectedVersion || typeof detectedVersion !== 'string') {
		return false;
	}
	const cleanDetected = detectedVersion.trim().toLowerCase();
	const cleanExpected = expectedVersion.trim().toLowerCase();

	if (cleanDetected === cleanExpected) {
		return true;
	}

	const serverMajor = extractMajorVersion(cleanDetected);
	const expectedMajor = extractMajorVersion(cleanExpected);

	if (Number.isNaN(serverMajor) || Number.isNaN(expectedMajor)) {
		return false;
	}

	return serverMajor === expectedMajor;
}

/**
 * Checks daemon API version for desktop shell startup (AC 1, E-14).
 * Never throws low-level errors; returns a structured VersionCheckResult.
 */
export async function checkDesktopApiVersion(
	options: VersionCheckOptions = {},
): Promise<VersionCheckResult> {
	const baseUrl = (options.baseUrl ?? 'http://127.0.0.1:7817').replace(/\/+$/, '');
	const expectedVersion = options.expectedVersion ?? SUPPORTED_API_VERSION;
	const timeoutMs = options.timeoutMs ?? DEFAULT_VERSION_CHECK_TIMEOUT_MS;
	const fetcher = options.fetcher ?? (typeof fetch !== 'undefined' ? fetch : undefined);

	if (!fetcher) {
		return {
			compatible: false,
			reason: 'unreachable',
			expectedVersion,
			message: 'Fetch API is unavailable in current runtime environment',
			upgradePrompt: '无法连接到调度服务以校验 API 版本。请确认运行环境支持网络请求。',
		};
	}

	const versionUrl = `${baseUrl}/api/v1/version`;

	try {
		const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
		const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;

		let response: Response;
		try {
			response = await fetcher(versionUrl, {
				method: 'GET',
				headers: {
					Accept: 'application/json',
				},
				signal: controller?.signal,
			});
		} finally {
			if (timer) {
				clearTimeout(timer);
			}
		}

		if (!response.ok) {
			return {
				compatible: false,
				reason: 'malformed',
				expectedVersion,
				message: `Daemon version endpoint returned HTTP ${response.status} ${response.statusText}`,
				upgradePrompt:
					'调度服务版本接口响应异常。请检查并升级调度服务或桌面客户端以保持两端版本一致。',
			};
		}

		let payload: unknown;
		try {
			payload = await response.json();
		} catch {
			return {
				compatible: false,
				reason: 'malformed',
				expectedVersion,
				message: 'Failed to parse JSON response from daemon version endpoint',
				upgradePrompt: '调度服务版本数据格式异常。请检查调度服务状态并升级至最新版本。',
			};
		}

		if (
			typeof payload !== 'object' ||
			payload === null ||
			typeof (payload as { apiVersion?: unknown }).apiVersion !== 'string'
		) {
			return {
				compatible: false,
				reason: 'malformed',
				expectedVersion,
				message: 'Daemon version payload is missing required apiVersion field',
				upgradePrompt: '调度服务未暴露有效的 API 版本号。请升级调度服务至兼容版本。',
			};
		}

		const data = payload as {
			apiVersion: string;
			daemon?: string;
			node?: string;
		};

		const serverApiVersion = data.apiVersion.trim();
		const compatible = isApiVersionCompatible(serverApiVersion, expectedVersion);

		if (!compatible) {
			return {
				compatible: false,
				reason: 'incompatible',
				apiVersion: serverApiVersion,
				expectedVersion,
				message: `API version mismatch: daemon has ${serverApiVersion}, shell requires ${expectedVersion}`,
				upgradePrompt: `两端版本不一致：当前调度服务 API 版本为 ${serverApiVersion}，而桌面客户端需要 ${expectedVersion}。请升级客户端或电脑上的调度服务。`,
			};
		}

		return {
			compatible: true,
			apiVersion: serverApiVersion,
			daemonVersion: data.daemon,
			nodeVersion: data.node,
		};
	} catch (error) {
		const errorMessage = error instanceof Error ? error.message : String(error);
		return {
			compatible: false,
			reason: 'unreachable',
			expectedVersion,
			message: `Unable to connect to daemon at ${baseUrl}: ${errorMessage}`,
			upgradePrompt: '调度服务未运行或网络不可达。请确认调度服务已在本地或局域网启动。',
		};
	}
}

/**
 * Generates upgrade prompt HTML when two ends have mismatched API versions (E-14).
 * Uses CSS variables conforming to project token specifications.
 */
export function generateVersionIncompatibleHtml(options: {
	readonly apiVersion?: string;
	readonly expectedVersion: string;
	readonly baseUrl?: string;
}): string {
	const displayServerVersion = options.apiVersion ?? '未知';
	const expectedVersion = options.expectedVersion;
	const displayUrl = options.baseUrl ?? 'scheduler daemon';

	return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <title>版本不兼容 · 需要升级</title>
  <style>
    :root {
      --page: #0F1213;
      --bg: #171B1C;
      --panel-2: #1F2425;
      --border: rgba(214, 232, 229, 0.09);
      --border-strong: rgba(214, 232, 229, 0.16);
      --ink-1: #E9EEED;
      --ink-2: #B2BCBB;
      --ink-3: #8B9695;
      --needs: #F0B03C;
      --on-needs: #171205;
      --down: #FF6B5A;
      --font-ui: "Public Sans", system-ui, -apple-system, sans-serif;
      --font-mono: "Commit Mono", "Cascadia Mono", ui-monospace, monospace;
    }
    body {
      background: var(--page);
      color: var(--ink-1);
      font-family: var(--font-ui);
      margin: 0;
      padding: 32px;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      box-sizing: border-box;
    }
    .card {
      background: var(--bg);
      border: 1px solid var(--needs);
      border-radius: 14px;
      padding: 28px;
      max-width: 520px;
      width: 100%;
      box-shadow: 0 4px 20px rgba(0, 0, 0, 0.35);
    }
    .badge {
      display: inline-block;
      font-size: 11px;
      font-weight: 600;
      color: var(--needs);
      text-transform: uppercase;
      letter-spacing: 0.05em;
      margin-bottom: 12px;
    }
    h1 {
      font-size: 20px;
      margin: 0 0 12px;
      color: var(--ink-1);
      font-weight: 600;
    }
    p {
      font-size: 14px;
      line-height: 1.6;
      color: var(--ink-2);
      margin: 0 0 20px;
    }
    .version-table {
      background: var(--panel-2);
      border: 1px solid var(--border);
      border-radius: 9px;
      padding: 14px 16px;
      margin-bottom: 24px;
      font-size: 13px;
    }
    .version-row {
      display: flex;
      justify-content: space-between;
      margin-bottom: 8px;
    }
    .version-row:last-child {
      margin-bottom: 0;
    }
    .version-label {
      color: var(--ink-3);
    }
    .version-val {
      font-family: var(--font-mono);
      color: var(--ink-1);
      font-weight: 500;
    }
    .version-val.mismatch {
      color: var(--down);
    }
    .hint {
      font-size: 12px;
      color: var(--ink-3);
      line-height: 1.5;
      margin-bottom: 24px;
    }
    .actions {
      display: flex;
      gap: 12px;
    }
    button {
      height: 32px;
      padding: 0 16px;
      border-radius: 9px;
      font-size: 13px;
      font-weight: 500;
      cursor: pointer;
      border: none;
    }
    button.primary {
      background: var(--needs);
      color: var(--on-needs);
    }
    button.secondary {
      background: var(--panel-2);
      color: var(--ink-1);
      border: 1px solid var(--border-strong);
    }
  </style>
</head>
<body>
  <div class="card">
    <div class="badge">E-14 · 两端版本不一致</div>
    <h1>两端版本不兼容，需要升级</h1>
    <p>桌面客户端检测到当前连接的调度服务 API 版本与客户端期望版本不匹配。只更新了客户端或只更新了服务端会导致此问题。</p>
    <div class="version-table">
      <div class="version-row">
        <span class="version-label">调度服务地址</span>
        <span class="version-val">${displayUrl}</span>
      </div>
      <div class="version-row">
        <span class="version-label">服务端 API 版本</span>
        <span class="version-val mismatch">${displayServerVersion}</span>
      </div>
      <div class="version-row">
        <span class="version-label">客户端期望版本</span>
        <span class="version-val">${expectedVersion}</span>
      </div>
    </div>
    <div class="hint">请将桌面应用与调度服务同步更新至最新版本后重新启动。</div>
    <div class="actions">
      <button class="primary" id="retry-btn" onclick="window.location.reload()">重新校验</button>
    </div>
  </div>
</body>
</html>`;
}
