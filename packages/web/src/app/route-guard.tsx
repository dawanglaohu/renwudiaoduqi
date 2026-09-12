import { type ReactNode, useEffect } from 'react';
import { getCachedToken } from '../api/http-client.ts';
import {
	ROUTE_PATHS,
	type RouteId,
	type RouteMatch,
	matchRoute,
	navigateTo,
	useRoute,
} from './routes.tsx';

/**
 * Checks whether a valid device token exists in memory (07-前端架构 / AC 1).
 * 令牌从 shell 异步取一次后缓存在模块内变量，不进 store，无壳时降级 sessionStorage。
 */
export function hasDeviceToken(): boolean {
	const token = getCachedToken();
	return Boolean(token && token.trim().length > 0);
}

/**
 * Checks whether a route is public.
 * `#/pair` is the SOLE unprotected route across the entire application (07-前端架构.md).
 * All other routes strictly require an authenticated device token in memory.
 *
 * 禁令：禁止在页面或容器里再判一次登录态；禁止做角色权限（单人自用，没有角色）。
 */
export function isPublicRoute(route?: RouteMatch | RouteId | string | null): boolean {
	if (!route) {
		return false;
	}
	if (typeof route === 'string') {
		const clean = route.trim();
		if (
			clean === 'pair' ||
			clean === '#/pair' ||
			clean.startsWith('#/pair?') ||
			clean === '/pair'
		) {
			return true;
		}
		const matched = matchRoute(clean);
		return matched.id === 'pair';
	}
	return route.id === 'pair';
}

export function isRouteProtected(route?: RouteMatch | RouteId | string | null): boolean {
	return !isPublicRoute(route);
}

export interface RouteGuardProps {
	children?: ReactNode;
	/**
	 * Custom token check function (defaults to `hasDeviceToken`).
	 */
	hasToken?: () => boolean;
	/**
	 * Target route to check (defaults to the active route from `useRoute`).
	 */
	currentRoute?: RouteMatch | RouteId | string;
	/**
	 * Optional custom pair view element to display when unauthenticated.
	 */
	pairElement?: ReactNode;
}

/**
 * Single application-wide authentication route guard (07-前端架构.md).
 *
 * 规则：
 * 1. 鉴权守卫只在 src/app/route-guard.tsx 一处；
 * 2. 只判一件事：内存里有没有设备令牌；
 * 3. 没有就强制渲染 `#/pair`；
 * 4. `#/pair` 是唯一免守卫路由；
 * 5. 禁止在页面或容器里再判一次登录态；禁止做角色/权限。
 */
export function RouteGuard({
	children,
	hasToken = hasDeviceToken,
	currentRoute,
	pairElement,
}: RouteGuardProps) {
	const activeRoute = useRoute();
	const targetRoute = currentRoute
		? typeof currentRoute === 'string'
			? matchRoute(currentRoute)
			: typeof currentRoute === 'object' && 'id' in currentRoute
				? currentRoute
				: activeRoute
		: activeRoute;

	const authenticated = hasToken();
	const publicRoute = isPublicRoute(targetRoute);

	// When protected route accessed without token, force navigate to #/pair
	useEffect(() => {
		if (!authenticated && !publicRoute) {
			navigateTo(ROUTE_PATHS.pair, { replace: true });
		}
	}, [authenticated, publicRoute]);

	// Block protected content from rendering before pairing
	if (!authenticated && !publicRoute) {
		if (pairElement) {
			return <>{pairElement}</>;
		}

		return (
			<div
				data-testid="route-guard-unpaired"
				className="flex min-h-[calc(100vh-var(--topbar-h))] flex-col items-center justify-center p-6 bg-page text-ink-1 font-ui text-center"
			>
				<div className="max-w-md flex flex-col items-center gap-4">
					<div className="font-mono text-num text-needs font-semibold">PAIRING REQUIRED</div>
					<h1 className="text-lead font-semibold text-ink-1">需要设备配对</h1>
					<p className="text-meta text-ink-2">
						内存中未检测到有效的设备令牌。请先完成配对以访问调度服务。
					</p>
					<button
						type="button"
						onClick={() => navigateTo(ROUTE_PATHS.pair)}
						className="h-btn px-4 rounded-sm bg-needs text-on-needs font-medium text-body inline-flex items-center justify-center transition-colors hover:brightness-105 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-needs-soft"
					>
						前往配对
					</button>
				</div>
			</div>
		);
	}

	return <>{children}</>;
}
