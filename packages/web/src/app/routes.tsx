import { type ComponentType, type ReactNode, Suspense, useSyncExternalStore } from 'react';
import { RouteGuard } from './route-guard.tsx';

/**
 * Seven flat hash paths defined in 07-前端架构.md (AC 1, AC 5).
 * Hash mode ensures uniform behavior across daemon static root `/`,
 * Tauri `tauri://localhost`, and Capacitor `https://localhost`.
 */
export const ROUTE_PATHS = {
	deck: '#/',
	tasks: '#/tasks',
	runDetail: '#/run/:runId',
	landing: '#/landing/:taskId',
	settingsAgents: '#/settings/agents',
	settingsDevices: '#/settings/devices',
	pair: '#/pair',
} as const;

export type RouteKey = keyof typeof ROUTE_PATHS;
export type RoutePath = (typeof ROUTE_PATHS)[RouteKey];

export type RouteId =
	| 'deck'
	| 'tasks'
	| 'runDetail'
	| 'landing'
	| 'settingsAgents'
	| 'settingsDevices'
	| 'pair';

export interface RouteDefinition {
	readonly id: RouteId;
	readonly path: string;
	readonly auth: boolean;
	readonly lazy: boolean;
}

/**
 * Route table metadata (07-前端架构.md / AC 1).
 * Settings and landing are marked for lazy chunk loading.
 * Deck, tasks, and runDetail remain in the main chunk.
 * Pair is the sole unprotected route (`auth: false`).
 */
export const ROUTES: readonly RouteDefinition[] = [
	{ id: 'deck', path: ROUTE_PATHS.deck, auth: true, lazy: false },
	{ id: 'tasks', path: ROUTE_PATHS.tasks, auth: true, lazy: false },
	{ id: 'runDetail', path: ROUTE_PATHS.runDetail, auth: true, lazy: false },
	{ id: 'landing', path: ROUTE_PATHS.landing, auth: true, lazy: true },
	{ id: 'settingsAgents', path: ROUTE_PATHS.settingsAgents, auth: true, lazy: true },
	{ id: 'settingsDevices', path: ROUTE_PATHS.settingsDevices, auth: true, lazy: true },
	{ id: 'pair', path: ROUTE_PATHS.pair, auth: false, lazy: false },
] as const;

export interface MatchedRoute {
	readonly id: RouteId;
	readonly path: string;
	readonly params: Readonly<Record<string, string>>;
	readonly query: Readonly<Record<string, string>>;
	readonly isUnknown: false;
	readonly auth: boolean;
	readonly lazy: boolean;
}

export interface UnknownRoute {
	readonly id: 'unknown';
	readonly path: string;
	readonly params: Readonly<Record<string, string>>;
	readonly query: Readonly<Record<string, string>>;
	readonly isUnknown: true;
	readonly auth: false;
	readonly lazy: false;
}

export type RouteMatch = MatchedRoute | UnknownRoute;

export interface NavigateOptions {
	replace?: boolean;
}

type RouteListener = () => void;
const listeners = new Set<RouteListener>();

function subscribeRoute(listener: RouteListener): () => void {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

function notifyRouteListeners(): void {
	for (const listener of listeners) {
		listener();
	}
}

function getLocation(): Location | undefined {
	if (typeof window !== 'undefined' && window.location) {
		return window.location;
	}
	if (
		typeof globalThis !== 'undefined' &&
		(globalThis as unknown as { location?: Location }).location
	) {
		return (globalThis as unknown as { location: Location }).location;
	}
	return undefined;
}

/**
 * Normalizes raw hash strings to standard `#/path` form (E-224).
 * Empty hash, `#`, or full URL without hash normalizes directly to `#/`.
 */
export function normalizeHash(rawHash?: string | null): string {
	if (!rawHash) {
		return '#/';
	}
	let clean = rawHash.trim();
	const hashIndex = clean.indexOf('#');
	if (hashIndex !== -1) {
		clean = clean.slice(hashIndex + 1);
	} else if (clean.includes('://')) {
		// Full URL without hash (e.g. daemon '/', tauri://localhost/, https://localhost/)
		return '#/';
	}
	if (!clean || clean === '/') {
		return '#/';
	}
	if (clean.startsWith('?')) {
		return `#/${clean}`;
	}
	if (!clean.startsWith('/')) {
		clean = `/${clean}`;
	}
	return `#${clean}`;
}

/**
 * Builds a path with parameters and query string.
 */
export function buildPath(
	pattern: string,
	params?: Record<string, string>,
	query?: Record<string, string>,
): string {
	let resolved = pattern;
	if (params) {
		for (const [key, value] of Object.entries(params)) {
			resolved = resolved.replace(`:${key}`, encodeURIComponent(value));
		}
	}
	if (query && Object.keys(query).length > 0) {
		const searchParams = new URLSearchParams(query);
		const qs = searchParams.toString();
		if (qs) {
			resolved = `${resolved}?${qs}`;
		}
	}
	return resolved;
}

/**
 * Matches a hash against the 7 registered routes + 2 single-segment parameters (AC 1).
 * When route parameters point to non-existent objects, the router still matches
 * and lets the page itself render the missing notice (E-223).
 * Missing parameters or unrecognized hashes return UnknownRoute without throwing (E-222).
 */
export function matchRoute(rawHash?: string | null): RouteMatch {
	const normalized = normalizeHash(rawHash);
	const questionIndex = normalized.indexOf('?');
	const pathname = questionIndex === -1 ? normalized : normalized.slice(0, questionIndex);
	const queryString = questionIndex === -1 ? '' : normalized.slice(questionIndex + 1);

	const query: Record<string, string> = {};
	if (queryString) {
		const searchParams = new URLSearchParams(queryString);
		for (const [key, value] of searchParams.entries()) {
			query[key] = value;
		}
	}

	// 1. Root / deck (#/)
	if (pathname === '#/' || pathname === '#') {
		return {
			id: 'deck',
			path: ROUTE_PATHS.deck,
			params: {},
			query,
			isUnknown: false,
			auth: true,
			lazy: false,
		};
	}

	// 2. Tasks (#/tasks)
	if (pathname === '#/tasks') {
		return {
			id: 'tasks',
			path: ROUTE_PATHS.tasks,
			params: {},
			query,
			isUnknown: false,
			auth: true,
			lazy: false,
		};
	}

	// 3. Run detail (#/run/:runId) - single segment param
	if (pathname.startsWith('#/run/')) {
		const param = pathname.slice('#/run/'.length);
		// Must have non-empty single segment (no further slashes)
		if (param.length > 0 && !param.includes('/')) {
			return {
				id: 'runDetail',
				path: pathname,
				params: { runId: decodeURIComponent(param) },
				query,
				isUnknown: false,
				auth: true,
				lazy: false,
			};
		}
		// Missing parameter or multi-segment: falls through to unknown (E-222)
	}

	// 4. Landing (#/landing/:taskId) - single segment param
	if (pathname.startsWith('#/landing/')) {
		const param = pathname.slice('#/landing/'.length);
		// Must have non-empty single segment (no further slashes)
		if (param.length > 0 && !param.includes('/')) {
			return {
				id: 'landing',
				path: pathname,
				params: { taskId: decodeURIComponent(param) },
				query,
				isUnknown: false,
				auth: true,
				lazy: true,
			};
		}
		// Missing parameter or multi-segment: falls through to unknown (E-222)
	}

	// 5. Settings: Agents (#/settings/agents)
	if (pathname === '#/settings/agents') {
		return {
			id: 'settingsAgents',
			path: ROUTE_PATHS.settingsAgents,
			params: {},
			query,
			isUnknown: false,
			auth: true,
			lazy: true,
		};
	}

	// 6. Settings: Devices (#/settings/devices)
	if (pathname === '#/settings/devices') {
		return {
			id: 'settingsDevices',
			path: ROUTE_PATHS.settingsDevices,
			params: {},
			query,
			isUnknown: false,
			auth: true,
			lazy: true,
		};
	}

	// 7. Pair (#/pair) - Sole public route
	if (pathname === '#/pair') {
		return {
			id: 'pair',
			path: ROUTE_PATHS.pair,
			params: {},
			query,
			isUnknown: false,
			auth: false,
			lazy: false,
		};
	}

	// E-222: Unregistered hash -> UnknownRoute
	return {
		id: 'unknown',
		path: pathname,
		params: {},
		query,
		isUnknown: true,
		auth: false,
		lazy: false,
	};
}

let currentRawHash = '';
let currentCachedMatch: RouteMatch = matchRoute('');

function syncRouteFromLocation(loc?: Location): boolean {
	const location = loc ?? getLocation();
	const raw = location ? location.hash : '';
	if (raw !== currentRawHash) {
		currentRawHash = raw;
		currentCachedMatch = matchRoute(raw);
		return true;
	}
	return false;
}

/**
 * Normalizes empty hash immediately upon startup without intermediate white screen (E-224).
 */
export function initializeHash(loc?: Location): string {
	const location = loc ?? getLocation();
	if (!location) {
		currentRawHash = '#/';
		currentCachedMatch = matchRoute('#/');
		return '#/';
	}
	const current = location.hash;
	if (!current || current === '#' || current === '#/') {
		if (current !== '#/') {
			if (typeof location.replace === 'function') {
				location.replace('#/');
			} else {
				location.hash = '#/';
			}
		}
		currentRawHash = '#/';
		currentCachedMatch = matchRoute('#/');
		return '#/';
	}
	const normalized = normalizeHash(current);
	if (normalized !== current) {
		if (typeof location.replace === 'function') {
			location.replace(normalized);
		} else {
			location.hash = normalized;
		}
	}
	currentRawHash = normalized;
	currentCachedMatch = matchRoute(normalized);
	return normalized;
}

// Perform instant initialization if in browser environment (E-224)
if (typeof window !== 'undefined') {
	initializeHash();
	window.addEventListener('hashchange', () => {
		if (syncRouteFromLocation()) {
			notifyRouteListeners();
		}
	});
}

/**
 * Universal navigation function (AC 5).
 * Components must NEVER set `location.hash` directly; all navigation flows through `navigateTo()`.
 */
export function navigateTo(target: string, options?: NavigateOptions): void {
	const normalized = normalizeHash(target);
	const location = getLocation();

	if (!location) {
		currentRawHash = normalized;
		currentCachedMatch = matchRoute(normalized);
		notifyRouteListeners();
		return;
	}

	if (options?.replace && typeof location.replace === 'function') {
		location.replace(normalized);
	} else {
		location.hash = normalized;
	}

	syncRouteFromLocation(location);
	notifyRouteListeners();
}

/**
 * React hook returning the current matched route (AC 1, AC 4).
 * Uses useSyncExternalStore with synchronous snapshot resolution to guarantee no white screens.
 */
export function useRoute(): RouteMatch {
	return useSyncExternalStore(
		subscribeRoute,
		() => currentCachedMatch,
		() => matchRoute('#/'),
	);
}

export const useRouter = useRoute;

export interface RouteComponentProps {
	match: RouteMatch;
	params: Readonly<Record<string, string>>;
	query: Readonly<Record<string, string>>;
}

/**
 * Unknown route fallback page (E-222).
 * Renders the topbar (`h-topbar`), "未知路径" heading, and "回到运行甲板" button.
 * Guarantees NO white screen and NO exceptions.
 */
export function UnknownRouteView({ match }: { match?: RouteMatch }) {
	const location = getLocation();
	const currentPath = match?.path ?? (location ? location.hash : '#/');

	return (
		<div
			data-testid="unknown-route-page"
			className="flex min-h-screen flex-col bg-page text-ink-1 font-ui"
		>
			{/* 顶栏 52px 保留顶栏 (E-222) */}
			<header className="h-topbar flex items-center justify-between px-4 border-b border-border bg-bg text-ink-1">
				<div className="flex items-center gap-2">
					<span className="font-mono text-body font-semibold tracking-tight">Agent 任务调度器</span>
					<span className="text-ink-3">/</span>
					<span className="text-meta text-ink-2">未知路径</span>
				</div>
			</header>

			{/* 主内容区：未知路径提示 + 回到运行甲板 */}
			<main className="flex flex-1 flex-col items-center justify-center p-6 text-center">
				<div className="max-w-md flex flex-col items-center gap-4">
					<div className="font-mono text-num-lg text-needs font-semibold">404</div>
					<h1 className="text-lead font-semibold text-ink-1">未知路径</h1>
					<p className="text-meta text-ink-2 max-w-sm">
						当前访问的路径不存在或已被移除：
						<span className="block mt-1 font-mono text-log text-ink-3 break-all">
							{currentPath}
						</span>
					</p>
					<button
						type="button"
						onClick={() => navigateTo(ROUTE_PATHS.deck)}
						className="h-btn px-4 rounded-sm bg-needs text-on-needs font-medium text-body inline-flex items-center justify-center transition-colors hover:brightness-105 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-needs-soft"
					>
						回到运行甲板
					</button>
				</div>
			</main>
		</div>
	);
}

export interface RouterProps {
	components?: Partial<Record<RouteId, ComponentType<RouteComponentProps>>>;
	guard?: boolean;
	hasToken?: () => boolean;
	renderUnknown?: (match: RouteMatch) => ReactNode;
	renderTopbar?: (match: RouteMatch) => ReactNode;
}

/**
 * Hash router view component (AC 1, AC 2, AC 4).
 * Combines RouteGuard authentication enforcement with lazy suspense and unknown route handling.
 */
export function RouterView({
	components,
	guard = true,
	hasToken,
	renderUnknown,
	renderTopbar,
}: RouterProps) {
	const match = useRoute();

	if (match.isUnknown) {
		return renderUnknown ? <>{renderUnknown(match)}</> : <UnknownRouteView match={match} />;
	}

	const Component = components?.[match.id];
	const routeContent = Component ? (
		<Component match={match} params={match.params} query={match.query} />
	) : (
		<div
			data-testid={`route-page-${match.id}`}
			data-route-id={match.id}
			className="p-6 text-ink-1 bg-page min-h-[calc(100vh-var(--topbar-h))]"
		>
			<div className="font-mono text-meta text-ink-3 mb-2">{match.path}</div>
		</div>
	);

	const guardedContent = guard ? (
		<RouteGuard currentRoute={match} hasToken={hasToken}>
			{routeContent}
		</RouteGuard>
	) : (
		routeContent
	);

	return (
		<div className="flex min-h-screen flex-col bg-page text-ink-1 font-ui">
			{renderTopbar?.(match)}
			<main className="flex-1">
				<Suspense fallback={<div className="p-6 text-meta text-ink-3">加载中...</div>}>
					{guardedContent}
				</Suspense>
			</main>
		</div>
	);
}
