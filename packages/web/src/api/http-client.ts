import type { RouteDefinition } from '../../../shared/src/api/routes.ts';
import { ERROR_CODES, type ErrorCode } from '../../../shared/src/errors/codes.ts';
import { resolveBaseUrl } from './base-url.ts';

export const TIMEOUT_MS = {
	get: 8000,
	post: 15000,
	probe: 30000,
} as const;

export const RETRY_DELAYS_MS = [300, 900] as const;
export const MAX_GET_RETRIES = 2;
export const SESSION_STORAGE_TOKEN_KEY = 'agsched.token' as const;

export interface ApiErrorOptions {
	code: ErrorCode;
	message: string;
	requestId: string;
	status?: number;
	details?: Record<string, unknown>;
	idempotencyKey?: string;
	cause?: unknown;
}

const BaseError: ErrorConstructor = Error;

/**
 * Normalized API error thrown by http-client (07-前端架构 / AC 4 / E-06 / E-126).
 * Front-end code branches strictly on `error.code`, never on HTTP status code.
 */
export class ApiError extends BaseError {
	readonly code: ErrorCode;
	readonly requestId: string;
	readonly status?: number;
	readonly details?: Record<string, unknown>;
	readonly idempotencyKey?: string;

	constructor(options: ApiErrorOptions) {
		super(options.message);
		this.name = 'ApiError';
		this.code = options.code;
		this.requestId = options.requestId;
		this.status = options.status;
		this.details = options.details;
		this.idempotencyKey = options.idempotencyKey;
		if (options.cause !== undefined) {
			(this as { cause?: unknown }).cause = options.cause;
		}
		Object.setPrototypeOf(this, ApiError.prototype);
	}
}

export function isApiError(error: unknown): error is ApiError {
	return (
		error instanceof ApiError ||
		(typeof error === 'object' &&
			error !== null &&
			(error as ApiError).name === 'ApiError' &&
			typeof (error as ApiError).code === 'string')
	);
}

export interface HttpRequestOptions<TReq = unknown> {
	path: string;
	method?: 'GET' | 'POST' | 'PATCH' | 'DELETE' | 'PUT';
	params?: Record<string, string | number>;
	query?: Record<string, string | number | boolean | undefined | null>;
	body?: TReq;
	headers?: Record<string, string>;
	signal?: AbortSignal;
	timeoutMs?: number;
	idempotencyKey?: string;
	auth?: 'device' | 'none';
}

export type TokenProvider = () => Promise<string | null> | string | null;

export interface CreateHttpClientOptions {
	getBaseUrl?: () => Promise<string> | string;
	getToken?: TokenProvider;
	clientVersion?: string;
	onUnauthorized?: () => void;
	sleep?: (ms: number) => Promise<void>;
}

export interface HttpClient {
	request<TRes, TReq = unknown>(options: HttpRequestOptions<TReq>): Promise<TRes>;
	get<TRes>(path: string, options?: Omit<HttpRequestOptions, 'method' | 'path'>): Promise<TRes>;
	post<TRes, TReq = unknown>(
		path: string,
		body?: TReq,
		options?: Omit<HttpRequestOptions, 'method' | 'path' | 'body'>,
	): Promise<TRes>;
	patch<TRes, TReq = unknown>(
		path: string,
		body?: TReq,
		options?: Omit<HttpRequestOptions, 'method' | 'path' | 'body'>,
	): Promise<TRes>;
	delete<TRes>(path: string, options?: Omit<HttpRequestOptions, 'method' | 'path'>): Promise<TRes>;
	callRoute<TRes, TReq = unknown>(
		route: RouteDefinition,
		options?: Omit<HttpRequestOptions<TReq>, 'method' | 'path' | 'auth'>,
	): Promise<TRes>;
}

// Module-level token cache (07-前端架构: 令牌从 shell 异步取一次后缓存在模块内变量，不进 store)
let cachedToken: string | null = null;
let hasLoadedToken = false;
let registeredTokenProvider: TokenProvider | null = null;

export function registerTokenProvider(provider: TokenProvider | null): void {
	registeredTokenProvider = provider;
	hasLoadedToken = false;
}

export function getCachedToken(): string | null {
	return cachedToken;
}

export function setCachedToken(token: string | null): void {
	cachedToken = token;
	hasLoadedToken = true;
}

export function clearCachedToken(): void {
	cachedToken = null;
	hasLoadedToken = false;
}

export function generateIdempotencyKey(): string {
	if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
		return crypto.randomUUID();
	}
	return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
		const r = (Math.random() * 16) | 0;
		const v = c === 'x' ? r : (r & 0x3) | 0x8;
		return v.toString(16);
	});
}

function interpolatePath(path: string, params?: Record<string, string | number>): string {
	if (!params) {
		return path;
	}
	let result = path;
	for (const [key, value] of Object.entries(params)) {
		result = result.replace(`:${key}`, encodeURIComponent(String(value)));
	}
	return result;
}

function buildRequestUrl(
	baseUrl: string,
	path: string,
	params?: Record<string, string | number>,
	query?: Record<string, string | number | boolean | undefined | null>,
): string {
	const interpolated = interpolatePath(path, params);
	const cleanBase = baseUrl.replace(/\/+$/, '');
	const cleanPath = interpolated.startsWith('/') ? interpolated : `/${interpolated}`;
	const combined = `${cleanBase}${cleanPath}`;
	if (!query) {
		return combined;
	}
	const parsedUrl = new URL(combined);
	for (const [key, value] of Object.entries(query)) {
		if (value !== undefined && value !== null) {
			parsedUrl.searchParams.append(key, String(value));
		}
	}
	return parsedUrl.toString();
}

function normalizeErrorCode(rawCode: unknown): ErrorCode {
	if (typeof rawCode === 'string' && rawCode in ERROR_CODES) {
		return rawCode as ErrorCode;
	}
	return 'E_INTERNAL';
}

interface RawErrorPayload {
	readonly error?: {
		readonly code?: unknown;
		readonly message?: unknown;
		readonly requestId?: unknown;
		readonly details?: unknown;
	};
	readonly code?: unknown;
	readonly message?: unknown;
	readonly requestId?: unknown;
	readonly details?: unknown;
}

async function normalizeResponseError(
	response: Response,
	clientRequestId: string,
	idempotencyKey?: string,
): Promise<ApiError> {
	const status = response.status;
	const headerRequestId = response.headers.get('x-request-id') || undefined;

	let payload: RawErrorPayload | null = null;
	try {
		const text = await response.text();
		if (text) {
			payload = JSON.parse(text) as RawErrorPayload;
		}
	} catch {
		// Response is not valid JSON (e.g. proxy HTML error)
	}

	const errorObj = payload?.error ?? payload;
	const code = normalizeErrorCode(errorObj?.code);
	const message =
		typeof errorObj?.message === 'string' && errorObj.message.trim()
			? errorObj.message
			: response.statusText || `Request failed with status ${status}`;
	const requestId =
		(typeof errorObj?.requestId === 'string' && errorObj.requestId.trim()) ||
		headerRequestId ||
		clientRequestId;
	const details =
		typeof errorObj?.details === 'object' && errorObj.details !== null
			? (errorObj.details as Record<string, unknown>)
			: undefined;

	return new ApiError({
		code,
		message,
		requestId,
		status,
		details,
		idempotencyKey,
	});
}

const defaultSleep = (ms: number): Promise<void> =>
	new Promise((resolve) => setTimeout(resolve, ms));

export function createHttpClient(options?: CreateHttpClientOptions): HttpClient {
	const clientVersion = options?.clientVersion ?? '0.0.0';
	const sleep = options?.sleep ?? defaultSleep;

	async function request<TRes, TReq = unknown>(
		requestOptions: HttpRequestOptions<TReq>,
	): Promise<TRes> {
		const method = (requestOptions.method ?? 'GET').toUpperCase() as
			| 'GET'
			| 'POST'
			| 'PATCH'
			| 'DELETE'
			| 'PUT';
		const isGet = method === 'GET';
		const isWrite = method !== 'GET';

		// Interceptor 1: 确定并注入 X-Idempotency-Key（写请求注入，重试复用同一个，E-126 / E-177 / AC 5）
		let idempotencyKey: string | undefined;
		if (isWrite) {
			idempotencyKey =
				requestOptions.idempotencyKey ??
				requestOptions.headers?.['X-Idempotency-Key'] ??
				requestOptions.headers?.['x-idempotency-key'] ??
				generateIdempotencyKey();
			// 保持在 options 供外部/重试复用
			requestOptions.idempotencyKey = idempotencyKey;
		}

		// Interceptor 2: 注入 Authorization（从 shell 异步取一次后缓存在模块内变量，不进 store）
		if (requestOptions.auth !== 'none') {
			if (!hasLoadedToken) {
				if (options?.getToken) {
					cachedToken = await options.getToken();
				} else if (registeredTokenProvider) {
					cachedToken = await registeredTokenProvider();
				} else if (typeof sessionStorage !== 'undefined') {
					cachedToken = sessionStorage.getItem(SESSION_STORAGE_TOKEN_KEY);
				}
				hasLoadedToken = true;
			}
		}

		// Interceptor 3: 构造基础头与 X-Agsched-Client（E-14）
		const headers = new Headers();
		if (requestOptions.headers) {
			for (const [key, value] of Object.entries(requestOptions.headers)) {
				if (value !== undefined && value !== null) {
					headers.set(key, String(value));
				}
			}
		}

		if (!headers.has('X-Agsched-Client')) {
			headers.set('X-Agsched-Client', `web/${clientVersion}`);
		}

		if (idempotencyKey && !headers.has('X-Idempotency-Key')) {
			headers.set('X-Idempotency-Key', idempotencyKey);
		}

		if (requestOptions.auth !== 'none' && cachedToken && !headers.has('Authorization')) {
			headers.set('Authorization', `Bearer ${cachedToken}`);
		}

		if (!headers.has('Accept')) {
			headers.set('Accept', 'application/json');
		}

		// 处理请求体
		let requestBody: BodyInit | undefined;
		if (requestOptions.body !== undefined) {
			if (
				typeof requestOptions.body === 'string' ||
				requestOptions.body instanceof FormData ||
				requestOptions.body instanceof Blob
			) {
				requestBody = requestOptions.body;
			} else {
				requestBody = JSON.stringify(requestOptions.body);
				if (!headers.has('Content-Type')) {
					headers.set('Content-Type', 'application/json');
				}
			}
		}

		// 解析 baseUrl（三级发现：壳注入 → 用户手填 → location.origin，E-06）
		const baseUrl = options?.getBaseUrl ? await options.getBaseUrl() : await resolveBaseUrl();

		if (!baseUrl) {
			throw new ApiError({
				code: 'E_NETWORK',
				message: 'Unable to resolve daemon baseUrl',
				requestId: generateIdempotencyKey(),
				idempotencyKey,
				details: {
					step: 'base_url_resolution',
					path: requestOptions.path,
				},
			});
		}

		const requestUrl = buildRequestUrl(
			baseUrl,
			requestOptions.path,
			requestOptions.params,
			requestOptions.query,
		);

		// 超时规则（07-前端架构: TIMEOUT_MS = {get: 8000, post: 15000, probe: 30000}）
		let defaultTimeout: number;
		if (requestOptions.path.includes('/probe')) {
			defaultTimeout = TIMEOUT_MS.probe;
		} else if (isGet) {
			defaultTimeout = TIMEOUT_MS.get;
		} else {
			defaultTimeout = TIMEOUT_MS.post;
		}
		const timeout = requestOptions.timeoutMs ?? defaultTimeout;

		// 重试策略（AC 3: 只重试 GET 且只在网络错误与 502/503/504，最多 2 次；POST 一律不自动重试）
		const maxRetries = isGet ? MAX_GET_RETRIES : 0;
		let attempt = 0;

		while (true) {
			const clientRequestId = generateIdempotencyKey();
			if (!headers.has('X-Request-Id')) {
				headers.set('X-Request-Id', clientRequestId);
			}

			const controller = new AbortController();
			let isTimedOut = false;
			const timer = setTimeout(() => {
				isTimedOut = true;
				controller.abort();
			}, timeout);

			let callerAbortListener: (() => void) | null = null;
			if (requestOptions.signal) {
				if (requestOptions.signal.aborted) {
					clearTimeout(timer);
					throw requestOptions.signal.reason || new Error('Request aborted by caller');
				}
				callerAbortListener = () => controller.abort();
				requestOptions.signal.addEventListener('abort', callerAbortListener, {
					once: true,
				});
			}

			try {
				const response = await fetch(requestUrl, {
					method,
					headers,
					body: requestBody,
					signal: controller.signal,
				});

				clearTimeout(timer);
				if (requestOptions.signal && callerAbortListener) {
					requestOptions.signal.removeEventListener('abort', callerAbortListener);
				}

				if (response.ok) {
					if (response.status === 204) {
						return undefined as unknown as TRes;
					}
					const text = await response.text();
					if (!text || !text.trim()) {
						return undefined as unknown as TRes;
					}
					try {
						return JSON.parse(text) as TRes;
					} catch {
						return text as unknown as TRes;
					}
				}

				// 响应状态码 >= 400：规格化成 ApiError
				const apiError = await normalizeResponseError(response, clientRequestId, idempotencyKey);

				// 401 处理：清内存令牌 → clear shell store → 跳 #/pair，禁止自动重试（07-前端架构 / AC 4）
				if (response.status === 401) {
					clearCachedToken();
					if (typeof sessionStorage !== 'undefined') {
						sessionStorage.removeItem(SESSION_STORAGE_TOKEN_KEY);
					}
					if (options?.onUnauthorized) {
						options.onUnauthorized();
					} else if (typeof window !== 'undefined') {
						window.location.hash = '#/pair';
					}
					throw apiError;
				}

				// 只重试 GET 且只在 502/503/504，最多 2 次（退避 300/900ms，AC 3）
				const isRetryableStatus =
					response.status === 502 || response.status === 503 || response.status === 504;
				if (isGet && isRetryableStatus && attempt < maxRetries) {
					const delay = RETRY_DELAYS_MS[attempt] ?? 900;
					attempt += 1;
					await sleep(delay);
					continue;
				}

				throw apiError;
			} catch (err: unknown) {
				clearTimeout(timer);
				if (requestOptions.signal && callerAbortListener) {
					requestOptions.signal.removeEventListener('abort', callerAbortListener);
				}

				// 已经规格化的 ApiError（如 401、非重试状态码或重试耗尽的 HTTP 错误）直接抛出
				if (isApiError(err)) {
					throw err;
				}

				// 调用方手动 abort，不作为重试异常吞掉，直接原样抛出
				if (requestOptions.signal?.aborted) {
					throw requestOptions.signal.reason || err;
				}

				// 底层网络异常或超时规格化
				const isTimeout = isTimedOut;
				const networkApiError = new ApiError({
					code: isTimeout ? 'E_TIMEOUT' : 'E_NETWORK',
					message: isTimeout
						? `Request timed out after ${timeout}ms`
						: err instanceof Error
							? err.message
							: 'Network request failed',
					requestId: clientRequestId,
					idempotencyKey,
					details: {
						baseUrl,
						path: requestOptions.path,
						attempt,
					},
					cause: err,
				});

				// 只重试 GET 且只在网络错误与超时，最多 2 次（退避 300/900ms，AC 3）
				if (isGet && attempt < maxRetries) {
					const delay = RETRY_DELAYS_MS[attempt] ?? 900;
					attempt += 1;
					await sleep(delay);
					continue;
				}

				throw networkApiError;
			}
		}
	}

	return {
		request,
		get<TRes>(
			path: string,
			requestOptions?: Omit<HttpRequestOptions, 'method' | 'path'>,
		): Promise<TRes> {
			return request<TRes>({ ...requestOptions, path, method: 'GET' });
		},
		post<TRes, TReq = unknown>(
			path: string,
			body?: TReq,
			requestOptions?: Omit<HttpRequestOptions, 'method' | 'path' | 'body'>,
		): Promise<TRes> {
			if (
				requestOptions &&
				!requestOptions.idempotencyKey &&
				!requestOptions.headers?.['X-Idempotency-Key'] &&
				!requestOptions.headers?.['x-idempotency-key']
			) {
				requestOptions.idempotencyKey = generateIdempotencyKey();
			}
			return request<TRes, TReq>({ ...requestOptions, path, body, method: 'POST' });
		},
		patch<TRes, TReq = unknown>(
			path: string,
			body?: TReq,
			requestOptions?: Omit<HttpRequestOptions, 'method' | 'path' | 'body'>,
		): Promise<TRes> {
			if (
				requestOptions &&
				!requestOptions.idempotencyKey &&
				!requestOptions.headers?.['X-Idempotency-Key'] &&
				!requestOptions.headers?.['x-idempotency-key']
			) {
				requestOptions.idempotencyKey = generateIdempotencyKey();
			}
			return request<TRes, TReq>({ ...requestOptions, path, body, method: 'PATCH' });
		},
		delete<TRes>(
			path: string,
			requestOptions?: Omit<HttpRequestOptions, 'method' | 'path'>,
		): Promise<TRes> {
			if (
				requestOptions &&
				!requestOptions.idempotencyKey &&
				!requestOptions.headers?.['X-Idempotency-Key'] &&
				!requestOptions.headers?.['x-idempotency-key']
			) {
				requestOptions.idempotencyKey = generateIdempotencyKey();
			}
			return request<TRes>({ ...requestOptions, path, method: 'DELETE' });
		},
		callRoute<TRes, TReq = unknown>(
			route: RouteDefinition,
			requestOptions?: Omit<HttpRequestOptions<TReq>, 'method' | 'path' | 'auth'>,
		): Promise<TRes> {
			return request<TRes, TReq>({
				...requestOptions,
				path: route.path,
				method: route.method,
				auth: route.auth,
			});
		},
	};
}

/**
 * Default global HTTP client instance.
 */
export const httpClient: HttpClient = createHttpClient();
