import type { ShellNotificationOptions } from '@agent-scheduler/shared/shell/bridge-contract';
import {
	type ActionPerformed,
	LocalNotifications,
	type PermissionStatus,
} from '@capacitor/local-notifications';

/**
 * E-11 boundary definition:
 * Truly offline push notifications require a hosted relay server with APNs/FCM credentials.
 * The scheduler explicitly rejects hosting user source code and credentials on third-party servers.
 * Mobile v1 guarantees native local notifications while app is in foreground / connected,
 * plus unread list catch-up upon reopen (E-11, E-147).
 */
export const OFFLINE_PUSH_SUPPORTED = false as const;

export interface LocalNotificationBackend {
	checkPermissions(): Promise<PermissionStatus>;
	requestPermissions(): Promise<PermissionStatus>;
	schedule(options: {
		notifications: Array<{
			title: string;
			body: string;
			id: number;
			extra?: Record<string, unknown>;
		}>;
	}): Promise<{ notifications: Array<{ id: number }> }>;
	addListener?(
		eventName: 'localNotificationActionPerformed',
		listenerFunc: (action: ActionPerformed) => void,
	): Promise<{ remove: () => Promise<void> }>;
}

export interface NotificationAdapterOptions {
	readonly backend?: LocalNotificationBackend;
	readonly onDeepLink?: (deepLink: string) => void;
}

let notificationIdCounter = 1;

export function createMobileNotificationNotifier(options: NotificationAdapterOptions = {}) {
	const backend: LocalNotificationBackend = options.backend ?? LocalNotifications;
	let listenerRegistered = false;

	function ensureActionListener(): void {
		if (listenerRegistered || !backend.addListener) {
			return;
		}
		listenerRegistered = true;
		void backend.addListener('localNotificationActionPerformed', (action: ActionPerformed) => {
			const deepLink = action.notification.extra?.deepLink;
			if (typeof deepLink === 'string' && deepLink.length > 0) {
				if (options.onDeepLink) {
					options.onDeepLink(deepLink);
				} else if (typeof window !== 'undefined' && window.location) {
					window.location.hash = deepLink;
				}
			}
		});
	}

	ensureActionListener();

	return async function notify(notificationOptions: ShellNotificationOptions): Promise<void> {
		try {
			const currentStatus = await backend.checkPermissions();
			let hasPermission = currentStatus.display === 'granted';

			if (!hasPermission && currentStatus.display === 'prompt') {
				const requested = await backend.requestPermissions();
				hasPermission = requested.display === 'granted';
			}

			if (!hasPermission) {
				return;
			}

			const notificationId = notificationIdCounter++;
			await backend.schedule({
				notifications: [
					{
						id: notificationId,
						title: notificationOptions.title,
						body: notificationOptions.body ?? '',
						extra: notificationOptions.deepLink
							? { deepLink: notificationOptions.deepLink }
							: undefined,
					},
				],
			});
		} catch {
			// Gracefully absorb notification errors without crashing UI
		}
	};
}
