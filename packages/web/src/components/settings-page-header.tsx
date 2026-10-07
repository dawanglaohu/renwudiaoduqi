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
				<span className="mr-2 text-meta text-ink-3">{UI_STRINGS.settings.title} /</span>
				<h1 className="inline">{title}</h1>
				<p>{description}</p>
			</div>
			<span className="settings-save-hint">{UI_STRINGS.settings.saveHint}</span>
		</header>
	);
}
