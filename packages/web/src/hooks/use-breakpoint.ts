/**
 * packages/web/src/hooks/use-breakpoint.ts
 *
 * 视口断点与密度档位 Hook（M9-T9 / AC 1, AC 8, AC 9, AC 11, E-163, E-164, E-168, E-235, E-239）
 *
 * 规范依据（11 节 UI 与 07 节前端架构）：
 * - 档位是单点计算的枚举（full/compact/narrow/phone/phone-xs）并以 prop 下传，不散落多处（AC 1, E-235）
 * - 档位只依据视口宽度 + 指针类型，绝不按 UA 猜设备（AC 8, E-239）
 * - 流数 >= 4 时默认紧凑档（compact），用 auto-fill 换行网格（AC 2, E-164）
 * - 流数 <= 3 且窗口 >= 1440px 时默认完整档（full），不出现横向滚动，档位选择记忆到本地（AC 9, E-163）
 * - 桌面窗口 < 1100px 退化为单列列表（narrow），不套用手机端规则，也不允许在 900px 硬塞三栏（AC 11, E-168）
 * - 触屏笔电 / 平板横竖屏切换：触屏下仍走 narrow（width < 1100），只把命中区放大到 44px（E-239）
 * - 极窄手机屏（< 400px，触控）：phone-xs 档（11 节）
 * - 手机竖屏（>= 400px 且 < 600px，触控）：phone 档（11 节）
 */

import { useCallback, useEffect, useState } from 'react';

/**
 * 密度档位枚举（单点计算，E-235）。
 */
export type DensityTier = 'full' | 'compact' | 'narrow' | 'phone' | 'phone-xs';

/**
 * 用户主动偏好设置（持久化至 localStorage 白名单 'agsched.ui.density'）。
 */
export type DensityPreference = 'full' | 'compact' | 'auto';

/**
 * localStorage 存储键名（07 节架构白名单：theme/density/lastDocId 三个字段进 localStorage）。
 */
export const DENSITY_STORAGE_KEY = 'agsched.ui.density';

/**
 * 断点常量（11 节 UI 响应式断点表）。
 */
export const BREAKPOINTS = {
	DESKTOP_FULL: 1440,
	DESKTOP_COMPACT: 1100,
	PHONE_MAX: 600,
	PHONE_XS_MAX: 400,
} as const;

/**
 * 单点计算输入参数。
 */
export interface ComputeDensityTierParams {
	/** 视口宽度（px） */
	readonly width: number;
	/** 是否为粗指针/触控设备（pointer: coarse） */
	readonly isTouch?: boolean;
	/** 当前并行流/泳道数（对应 lanes.length，AC 12） */
	readonly streamCount?: number;
	/** 用户本地记忆的主动偏好 */
	readonly userPreference?: DensityPreference | null;
}

/**
 * 单点计算密度档位纯函数（E-235, E-239）。
 *
 * 绝不依据 navigator.userAgent，仅依据视口宽度与指针类型。
 */
export function computeDensityTier(params: ComputeDensityTierParams): DensityTier {
	const { width, isTouch = false, streamCount = 1, userPreference = null } = params;

	// 1. 手机端判定（E-239, 11 节）：
	// 必须同时满足：为触控设备（pointer: coarse）且视口宽度极窄（< 600px）
	// 触屏笔电/平板在此宽度之上绝不套用手机端规则！
	if (isTouch && width < BREAKPOINTS.PHONE_MAX) {
		if (width < BREAKPOINTS.PHONE_XS_MAX) {
			return 'phone-xs';
		}
		return 'phone';
	}

	// 2. 桌面窄窗与平板退化判定（AC 11, E-168, E-239）：
	// 宽度 < 1100px 一律退化为 narrow 档（单列垂直列表），绝不硬塞三栏，也绝不套用手机端规则。
	// 触屏笔电/平板（width < 1100px）同样进入 narrow，仅由 isTouch 放大命中区至 44px（E-239）。
	if (width < BREAKPOINTS.DESKTOP_COMPACT) {
		return 'narrow';
	}

	// 3. 视口 >= 1100px 桌面宽屏：
	// 优先尊重用户在本地主动记忆的偏好（E-163）
	if (userPreference === 'compact') {
		return 'compact';
	}
	if (userPreference === 'full') {
		return 'full';
	}

	// 4. 默认策略（未设置或设为 'auto'）：
	// E-164: 流数 >= 4 默认紧凑档，换行网格而非横向滚动
	if (streamCount >= 4) {
		return 'compact';
	}

	// E-163: 流数 <= 3 且窗口 >= 1440px 默认完整档
	if (width >= BREAKPOINTS.DESKTOP_FULL) {
		return 'full';
	}

	// 1100px <= width < 1440px 时的微调：
	// 1~2 条流可从容铺开为 full，3 条流在 1100-1440px 默认 compact 避免过挤
	return streamCount <= 2 ? 'full' : 'compact';
}

/**
 * 从 localStorage 读取偏好。
 */
export function getStoredDensityPreference(): DensityPreference | null {
	if (typeof localStorage === 'undefined') {
		return null;
	}
	try {
		const stored = localStorage.getItem(DENSITY_STORAGE_KEY);
		if (stored === 'full' || stored === 'compact' || stored === 'auto') {
			return stored;
		}
		return null;
	} catch {
		return null;
	}
}

/**
 * 将偏好写入 localStorage。
 */
export function setStoredDensityPreference(pref: DensityPreference | null): void {
	if (typeof localStorage === 'undefined') {
		return;
	}
	try {
		if (pref === null || pref === 'auto') {
			localStorage.removeItem(DENSITY_STORAGE_KEY);
		} else {
			localStorage.setItem(DENSITY_STORAGE_KEY, pref);
		}
	} catch {
		// 忽略无权限或隐私模式异常
	}
}

/**
 * 检测当前是否为粗指针/触控环境（AC 8, E-239）。
 * 绝不读取 navigator.userAgent。
 */
export function detectIsTouchPointer(): boolean {
	if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
		return false;
	}
	return window.matchMedia('(pointer: coarse)').matches;
}

/**
 * useDensityTier Hook 配置项。
 */
export interface UseDensityTierOptions {
	/** 流数（默认为 1） */
	readonly streamCount?: number;
	/** 外部初始偏好覆盖（可选） */
	readonly defaultPreference?: DensityPreference;
}

/**
 * useDensityTier Hook 响应对象。
 */
export interface UseDensityTierResult {
	/** 单点计算得出的最终档位（AC 1, E-235） */
	readonly tier: DensityTier;
	/** 是否为粗指针/触控设备（用于放大按钮至 44px，E-239） */
	readonly isTouch: boolean;
	/** 当前视口宽度 */
	readonly width: number;
	/** 用户本地记忆的主动偏好 */
	readonly userPreference: DensityPreference;
	/** 更新偏好（并同步持久化） */
	readonly setUserPreference: (pref: DensityPreference) => void;
	/** 在 full 与 compact 之间快速切换 */
	readonly togglePreference: () => void;
}

/**
 * 单点计算并派发密度档位的全局唯一 Hook（AC 1, E-235）。
 *
 * 桌面与移动端统一由此 Hook 派发 tier prop，所有业务组件以 prop 接收，禁止散落自行判断。
 */
export function useDensityTier(options: UseDensityTierOptions = {}): UseDensityTierResult {
	const { streamCount = 1, defaultPreference } = options;

	const [width, setWidth] = useState<number>(() => {
		if (typeof window !== 'undefined') {
			return window.innerWidth;
		}
		return BREAKPOINTS.DESKTOP_FULL;
	});

	const [isTouch, setIsTouch] = useState<boolean>(() => detectIsTouchPointer());

	const [userPreference, setUserPreferenceState] = useState<DensityPreference>(() => {
		return getStoredDensityPreference() ?? defaultPreference ?? 'auto';
	});

	// 监听视口宽度变化
	useEffect(() => {
		if (typeof window === 'undefined') {
			return;
		}

		let rafId: number | null = null;
		const handleResize = () => {
			if (rafId !== null) {
				cancelAnimationFrame(rafId);
			}
			rafId = requestAnimationFrame(() => {
				setWidth(window.innerWidth);
			});
		};

		window.addEventListener('resize', handleResize, { passive: true });
		return () => {
			if (rafId !== null) {
				cancelAnimationFrame(rafId);
			}
			window.removeEventListener('resize', handleResize);
		};
	}, []);

	// 监听指针类型变化（如平板外接鼠标或键盘）
	useEffect(() => {
		if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
			return;
		}

		const mediaQuery = window.matchMedia('(pointer: coarse)');
		const handlePointerChange = (e: MediaQueryListEvent) => {
			setIsTouch(e.matches);
		};

		if (typeof mediaQuery.addEventListener === 'function') {
			mediaQuery.addEventListener('change', handlePointerChange);
			return () => mediaQuery.removeEventListener('change', handlePointerChange);
		}
		// 降级旧 API
		mediaQuery.addListener(handlePointerChange);
		return () => mediaQuery.removeListener(handlePointerChange);
	}, []);

	// 监听跨标签页 localStorage 同步
	useEffect(() => {
		if (typeof window === 'undefined') {
			return;
		}

		const handleStorage = (e: StorageEvent) => {
			if (e.key === DENSITY_STORAGE_KEY) {
				const val = (e.newValue as DensityPreference) ?? 'auto';
				if (val === 'full' || val === 'compact' || val === 'auto') {
					setUserPreferenceState(val);
				}
			}
		};

		window.addEventListener('storage', handleStorage);
		return () => window.removeEventListener('storage', handleStorage);
	}, []);

	const setUserPreference = useCallback((pref: DensityPreference) => {
		setUserPreferenceState(pref);
		setStoredDensityPreference(pref);
	}, []);

	const tier = computeDensityTier({
		width,
		isTouch,
		streamCount,
		userPreference,
	});

	const togglePreference = useCallback(() => {
		const next: DensityPreference = tier === 'compact' ? 'full' : 'compact';
		setUserPreference(next);
	}, [tier, setUserPreference]);

	return {
		tier,
		isTouch,
		width,
		userPreference,
		setUserPreference,
		togglePreference,
	};
}

/**
 * 视口通用查询 Hook（针对通用宽度感知）。
 */
export function useBreakpoint() {
	const { width, isTouch, tier } = useDensityTier();
	return {
		width,
		isTouch,
		tier,
		isDesktop: width >= BREAKPOINTS.DESKTOP_COMPACT,
		isNarrow: tier === 'narrow',
		isPhone: tier === 'phone' || tier === 'phone-xs',
	};
}
