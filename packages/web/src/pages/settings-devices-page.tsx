import type { RouteComponentProps } from '../app/routes.tsx';
import { SettingsDevicesContainer } from '../features/settings-devices/settings-devices-container.tsx';

export function SettingsDevicesPage(props: RouteComponentProps) {
	return (
		<section data-component="settings-devices-page">
			<SettingsDevicesContainer {...props} />
		</section>
	);
}

export default SettingsDevicesPage;
