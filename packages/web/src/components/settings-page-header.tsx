import { UI_STRINGS } from '../i18n/ui-strings.ts';

export function SettingsPageHeader({
	title,
	description,
}: {
	readonly title: string;
	readonly description: string;
}) {
	return (
		<header className="settings-page-header" aria-label={UI_STRINGS.settings.title}>
			<div className="min-w-0">
				<h1>{title}</h1>
				<p>{description}</p>
			</div>
			<span className="settings-save-hint">{UI_STRINGS.settings.saveHint}</span>
		</header>
	);
}
