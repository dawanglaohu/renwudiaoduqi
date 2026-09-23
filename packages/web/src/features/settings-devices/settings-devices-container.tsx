import type { RouteComponentProps } from '../../app/routes.tsx';
import { DeviceListView } from './device-list-view.tsx';
import { useSettingsDevices } from './use-settings-devices.ts';

export interface SettingsDevicesContainerProps extends Partial<RouteComponentProps> {}

/**
 * Settings Devices Container (M9-T15 / AC 2 / AC 4 / E-125 / E-127).
 * Adheres strictly to 07-前端架构: container root contains ONLY layout classes
 * (flex/grid/gap/padding), with zero color, font-size, or border-radius classes.
 */
export function SettingsDevicesContainer(_props: SettingsDevicesContainerProps) {
	const devicesState = useSettingsDevices();

	return (
		<div
			data-component="settings-devices-container"
			className="flex flex-col gap-6 w-full max-w-4xl mx-auto p-4 sm:p-6 min-h-[calc(100vh-var(--topbar-h))]"
		>
			<DeviceListView devicesState={devicesState} />
		</div>
	);
}

export const SettingsDevicesPage = SettingsDevicesContainer;
