/**
 * Autostart behavior on mobile (AC 5, E-211).
 * Mobile shells (Android) have no OS-level autostart registration concept.
 * The mobile container completely omits invoking any autostart trigger interface,
 * and unregistered autostart MUST NOT produce any warning, toast, console error, or UI notice.
 * The asymmetry between desktop and mobile is strictly "one fewer interface call".
 */
export const MOBILE_AUTOSTART_SUPPORTED = false as const;

export interface MobileAutostartStatus {
	readonly isSupported: false;
	readonly isRegistered: false;
	readonly hasWarningOrUi: false;
	readonly suppressed: true;
}

/**
 * Returns the verified mobile autostart suppression status.
 * Ensures zero native calls and zero UI or alert disturbances (E-211).
 */
export function getMobileAutostartStatus(): MobileAutostartStatus {
	return Object.freeze({
		isSupported: false,
		isRegistered: false,
		hasWarningOrUi: false,
		suppressed: true,
	});
}

/**
 * Validates that autostart registration is safely skipped without side effects.
 */
export function skipMobileAutostartRegistration(logger?: {
	warn?: (msg: string) => void;
	error?: (msg: string) => void;
}): MobileAutostartStatus {
	// Must NOT invoke logger.warn or logger.error (E-211: 不产生任何告警或 UI)
	void logger;
	return getMobileAutostartStatus();
}
