/**
 * Version check and compatibility verification for the Capacitor mobile shell (AC 1, E-14).
 *
 * Requirements:
 * - On startup/connection, queries the daemon's API version (GET /api/v1/version).
 * - When incompatible, prompts the user to upgrade instead of throwing low-level errors (E-14).
 * - Network failures or malformed responses are captured gracefully without throwing bottom-level exceptions.
 */

export const SUPPORTED_API_VERSION = 'v1' as const;
export const DEFAULT_MOBILE_VERSION_CHECK_TIMEOUT_MS = 5000;

export type MobileVersionIncompatibilityReason = 'incompatible' | 'unreachable' | 'malformed';

export interface MobileVersionCheckCompatible {
	readonly compatible: true;
	readonly apiVersion: string;
	readonly daemonVersion?: string;
	readonly nodeVersion?: string;
}

export interface MobileVersionCheckIncompatible {
	readonly compatible: false;
	readonly reason: MobileVersionIncompatibilityReason;
	readonly apiVersion?: string;
	readonly expectedVersion: string;
	readonly message: string;
	readonly upgradePrompt: string;
}

export type MobileVersionCheckResult =
	| MobileVersionCheckCompatible
	| MobileVersionCheckIncompatible;

export interface MobileUpgradeNotice {
	readonly title: string;
	readonly message: string;
	readonly upgradePrompt: string;
	readonly serverVersion: string;
	readonly expectedVersion: string;
	readonly canContinue: false;
}

export interface MobileVersionCheckOptions {
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
 * Checks whether detected server API version is compatible with expected mobile client API version (E-14).
 */
export function isMobileApiVersionCompatible(
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
 * Checks daemon API version for mobile shell startup (AC 1, E-14).
 * Never throws bottom-level errors; returns a structured MobileVersionCheckResult.
 */
export async function checkMobileApiVersion(
	options: MobileVersionCheckOptions = {},
): Promise<MobileVersionCheckResult> {
	const baseUrl = (options.baseUrl ?? 'http://127.0.0.1:7817').replace(/\/+$/, '');
	const expectedVersion = options.expectedVersion ?? SUPPORTED_API_VERSION;
	const timeoutMs = options.timeoutMs ?? DEFAULT_MOBILE_VERSION_CHECK_TIMEOUT_MS;
	const fetcher = options.fetcher ?? (typeof fetch !== 'undefined' ? fetch : undefined);

	if (!fetcher) {
		return {
			compatible: false,
			reason: 'unreachable',
			expectedVersion,
			message: 'Fetch API is unavailable in mobile runtime environment',
			upgradePrompt: '无法连接到电脑端调度服务以校验 API 版本。',
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
				upgradePrompt: '电脑端调度服务版本接口响应异常。请检查并升级电脑端调度服务。',
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
				upgradePrompt: '电脑端调度服务返回数据格式异常，请检查服务状态。',
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
				upgradePrompt: '电脑端调度服务未暴露有效的 API 版本号，请升级调度服务。',
			};
		}

		const data = payload as {
			apiVersion: string;
			daemon?: string;
			node?: string;
		};

		const serverApiVersion = data.apiVersion.trim();
		const compatible = isMobileApiVersionCompatible(serverApiVersion, expectedVersion);

		if (!compatible) {
			return {
				compatible: false,
				reason: 'incompatible',
				apiVersion: serverApiVersion,
				expectedVersion,
				message: `API version mismatch: daemon has ${serverApiVersion}, mobile shell requires ${expectedVersion}`,
				upgradePrompt: `两端版本不一致：电脑端调度服务 API 版本为 ${serverApiVersion}，而手机应用需要 ${expectedVersion}。请升级手机应用或电脑端调度服务。`,
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
			upgradePrompt: '未能连接到电脑端调度服务。请确认电脑上的调度服务已启动并在同一局域网内可达。',
		};
	}
}

/**
 * Generates structured upgrade notice when two ends have mismatched API versions (AC 1, E-14).
 * Suitable for native/in-app alert or banner presentation without throwing low-level errors.
 */
export function generateMobileUpgradeNotice(options: {
	readonly apiVersion?: string;
	readonly expectedVersion?: string;
}): MobileUpgradeNotice {
	const serverVersion = options.apiVersion ?? '未知';
	const expectedVersion = options.expectedVersion ?? SUPPORTED_API_VERSION;

	return Object.freeze({
		title: '两端版本不一致',
		message: `手机端应用与电脑端调度服务的 API 版本不兼容（服务端版本：${serverVersion}，手机端需要：${expectedVersion}）。请升级手机应用或电脑端调度服务以继续使用。`,
		upgradePrompt: '两端版本不兼容，请升级应用或调度服务',
		serverVersion,
		expectedVersion,
		canContinue: false,
	});
}
