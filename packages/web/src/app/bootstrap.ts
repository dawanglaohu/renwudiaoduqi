/**
 * packages/web/src/app/bootstrap.ts
 *
 * 启动序列的唯一实现（07-前端架构 §注入点，M9-T26）。顺序固定：
 *   探壳 → `tokenStore.get()` 并 `registerTokenProvider()` → `registerShellHostHint()` 后
 *   `resolveBaseUrl()` → 有令牌才开流，无令牌置 `needsPairing`。
 * SSE 的生产开流调用在 `packages/web/src` 下只许出现一处（`test/wiring-arch.test.ts` 机检）。
 *
 * 开流的唯一闸门是「模块缓存里有没有令牌」——没有按主机、网段或 loopback 放行的分支，
 * 隧道暴露到公网时鉴权同样生效（E-08）。
 */

import type {
	ShellBridge,
	ShellCapabilities,
	ShellPlatform,
} from '@agent-scheduler/shared/shell/bridge-contract';
import { registerShellHostHint, resolveBaseUrl } from '../api/base-url.ts';
import { eventBus } from '../api/event-bus.ts';
import { onTokenChange, registerTokenProvider, setCachedToken } from '../api/http-client.ts';
import { type SseClient, sseClient as defaultSseClient } from '../api/sse-client.ts';
import { bindConnectionState } from '../features/run-deck/use-connection-state.ts';
import { shellBridge } from '../shell/shell-bridge.ts';
import { type ConnectionStatus, useConnectionStore } from '../store/connection-store.ts';

export interface BootstrapDeps {
	readonly shell: ShellBridge;
	readonly sseClient: SseClient;
	readonly resolveBaseUrl: () => Promise<string>;
}

export interface BootstrapResult {
	readonly platform: ShellPlatform;
	readonly capabilities: ShellCapabilities;
	readonly hasToken: boolean;
	/** 三级发现的结果（壳注入 → 用户手填 → location.origin）；空串表示三级都没给出地址 */
	readonly baseUrl: string;
	readonly needsPairing: boolean;
	/** 撤销全部注册并停流（HMR / 测试用）；生产运行期不会调用 */
	teardown(): void;
}

/**
 * 承载 `data-connection-status` 的根元素。M10-T6 的壳 smoke 与 M1-T11 的端到端冒烟轮询
 * `document.documentElement.dataset.connectionStatus`，所以镜像写在 `<html>` 上；
 * 顶栏展示组件（`components/offline-banner.tsx`）从 store 拿同一个值写在自己的根元素上。
 */
interface ConnectionStatusRoot {
	readonly dataset: { connectionStatus?: string };
}

const DEFAULT_DEPS: BootstrapDeps = {
	shell: shellBridge,
	sseClient: defaultSseClient,
	resolveBaseUrl,
};

async function readShellToken(shell: ShellBridge): Promise<string | null> {
	try {
		const token = await shell.tokenStore.get();
		return typeof token === 'string' && token.trim().length > 0 ? token : null;
	} catch (error) {
		// 壳的凭据库读失败按「未配对」处理：界面照常挂载并引导重新配对，不能白屏
		console.error('[bootstrap] shell tokenStore.get failed, treating as unpaired:', error);
		return null;
	}
}

function resolveConnectionStatusRoot(): ConnectionStatusRoot | null {
	if (typeof document === 'undefined' || !document.documentElement) {
		return null;
	}
	return document.documentElement;
}

/**
 * 把 connection-store 的 `status` 镜像成 `<html data-connection-status>`（E-12 的离线态对壳可见）。
 */
function mirrorConnectionStatus(root: ConnectionStatusRoot | null): () => void {
	if (!root) {
		return () => {};
	}
	const apply = (status: ConnectionStatus): void => {
		root.dataset.connectionStatus = status;
	};
	apply(useConnectionStore.getState().status);
	return useConnectionStore.subscribe((state, previous) => {
		if (state.status !== previous.status) {
			apply(state.status);
		}
	});
}

export async function bootstrap(overrides: Partial<BootstrapDeps> = {}): Promise<BootstrapResult> {
	const deps: BootstrapDeps = { ...DEFAULT_DEPS, ...overrides };
	const { shell, sseClient } = deps;
	const store = useConnectionStore;

	// 1. 探壳：`SHELL` 在 detect-shell.ts 模块加载期冻结，这里只读结果
	const platform = shell.platform;
	const capabilities = shell.capabilities;

	// 2. 令牌：从壳异步取一次，缓存在 http-client 的模块变量里（不进 store），之后由 provider 按需补读
	const token = await readShellToken(shell);
	registerTokenProvider(() => shell.tokenStore.get());
	// Always replace the module cache, including with null. HMR/tests may reuse the module after a
	// previous authenticated bootstrap; a missing native credential must never inherit that token.
	setCachedToken(token);

	// 3. 先把壳的 hostHint 挂进三级发现，再解析 baseUrl
	registerShellHostHint(() => shell.hostHint());
	const baseUrl = await deps.resolveBaseUrl();

	// 4. 连接状态：SSE 状态与事件单向映射进 store，再镜像到 <html data-connection-status>
	const unbindConnectionState = bindConnectionState(sseClient);
	const unmirror = mirrorConnectionStatus(resolveConnectionStatusRoot());

	// 5. 有令牌才开流；无令牌只置 needsPairing，守卫会把用户送去 #/pair（E-156）
	const startStream = (): void => {
		sseClient.connect();
	};
	if (token !== null) {
		store.getState().setNeedsPairing(false);
		startStream();
	} else {
		store.getState().setNeedsPairing(true);
	}

	// 6. 之后令牌进出模块缓存（配对成功 `setCachedToken` / 401 路径 `clearCachedToken`）由同一个开流点接管
	const unsubscribeToken = onTokenChange((nextToken) => {
		if (nextToken !== null) {
			store.getState().setNeedsPairing(false);
			startStream();
			return;
		}
		store.getState().setNeedsPairing(true);
		sseClient.disconnect();
		// A revoked credential must not survive in the native keychain/Preferences and reappear on
		// the next process start. Browser mode uses the same bridge call to clear sessionStorage.
		void shell.tokenStore.clear().catch((error: unknown) => {
			console.error('[bootstrap] failed to clear revoked shell token:', error);
		});
	});

	return {
		platform,
		capabilities,
		hasToken: token !== null,
		baseUrl,
		needsPairing: token === null,
		teardown(): void {
			unsubscribeToken();
			unmirror();
			unbindConnectionState();
			sseClient.disconnect();
			eventBus.clearAll();
			registerShellHostHint(null);
			registerTokenProvider(null);
		},
	};
}
