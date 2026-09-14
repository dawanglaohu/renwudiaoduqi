import { App as CapacitorApp } from '@capacitor/app';

export interface BackButtonEvent {
	readonly canGoBack: boolean;
}

export interface AppPluginLike {
	exitApp(): Promise<void> | void;
	addListener?(
		eventName: 'backButton',
		listenerFunc: (event: BackButtonEvent) => void,
	): Promise<{ remove: () => Promise<void> }>;
}

export interface HistoryLike {
	back(): void;
	readonly length?: number;
}

export interface LocationLike {
	hash: string;
}

export interface BackButtonHandlerOptions {
	readonly app?: AppPluginLike;
	readonly history?: HistoryLike;
	readonly location?: LocationLike;
	readonly onBack?: () => void;
	readonly onExit?: () => void;
}

export interface BackButtonHandler {
	readonly getStackDepth: () => number;
	readonly recordForwardNavigation: () => void;
	readonly handleBackPress: (event?: Partial<BackButtonEvent>) => void;
	readonly destroy: () => void;
}

function normalizeHash(hash?: string | null): string {
	if (!hash) return '#/';
	const index = hash.indexOf('#');
	const clean = index !== -1 ? hash.slice(index + 1) : hash;
	if (!clean || clean === '/') return '#/';
	return clean.startsWith('/') ? `#${clean}` : `#/${clean}`;
}

const defaultAppPlugin: AppPluginLike = {
	exitApp(): void {},
};

function resolveAppPlugin(customApp?: AppPluginLike): AppPluginLike {
	if (customApp) return customApp;
	if (typeof window !== 'undefined' && typeof document !== 'undefined') {
		return CapacitorApp;
	}
	return defaultAppPlugin;
}

/**
 * Handles Android hardware back button (AC 3, E-225).
 * Maps hardware back key to `history.back()` and only allows exiting when the hash stack
 * has completely retreated to the root (`#/`), prohibiting accidental immediate exit.
 */
export function createBackButtonHandler(options: BackButtonHandlerOptions = {}): BackButtonHandler {
	const app: AppPluginLike = resolveAppPlugin(options.app);
	const history: HistoryLike =
		options.history ?? (typeof window !== 'undefined' ? window.history : { back: () => {} });
	const location: LocationLike =
		options.location ?? (typeof window !== 'undefined' ? window.location : { hash: '#/' });

	let stackDepth = 0;
	let isBackActionInProgress = false;

	function getNormalizedCurrentHash(): string {
		return normalizeHash(location.hash);
	}

	function onHashChange(): void {
		if (isBackActionInProgress) {
			isBackActionInProgress = false;
		} else {
			stackDepth += 1;
		}
	}

	if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
		window.addEventListener('hashchange', onHashChange);
	}

	function handleBackPress(event?: Partial<BackButtonEvent>): void {
		const currentHash = getNormalizedCurrentHash();
		const isAtRoot = currentHash === '#/';
		const canNavigateBack = stackDepth > 0 || event?.canGoBack === true || !isAtRoot;

		if (canNavigateBack) {
			isBackActionInProgress = true;
			stackDepth = Math.max(0, stackDepth - 1);
			history.back();
			if (options.onBack) {
				options.onBack();
			}
		} else {
			void app.exitApp();
			if (options.onExit) {
				options.onExit();
			}
		}
	}

	let appListenerPromise: Promise<{ remove: () => Promise<void> }> | null = null;
	if (app.addListener) {
		appListenerPromise = Promise.resolve(
			app.addListener('backButton', (event: BackButtonEvent) => {
				handleBackPress(event);
			}),
		);
	}

	return {
		getStackDepth(): number {
			return stackDepth;
		},

		recordForwardNavigation(): void {
			stackDepth += 1;
		},

		handleBackPress,

		destroy(): void {
			if (typeof window !== 'undefined' && typeof window.removeEventListener === 'function') {
				window.removeEventListener('hashchange', onHashChange);
			}
			if (appListenerPromise) {
				void appListenerPromise.then((handle) => handle?.remove?.());
			}
		},
	};
}
