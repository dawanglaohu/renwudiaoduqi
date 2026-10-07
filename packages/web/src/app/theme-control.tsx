import { useRef } from 'react';
import { UI_STRINGS } from '../i18n/ui-strings.ts';
import { type Theme, useTheme } from './theme-provider.tsx';

const THEMES: readonly Theme[] = ['light', 'dark', 'system'];

export function ThemeControl() {
	const { theme, setTheme } = useTheme();
	const details = useRef<HTMLDetailsElement>(null);
	const trigger = useRef<HTMLElement>(null);

	return (
		<details
			ref={details}
			className="theme-control"
			data-testid="theme-control"
			onBlur={(event) => {
				if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
					event.currentTarget.open = false;
				}
			}}
			onKeyDown={(event) => {
				if (event.key === 'Escape') {
					event.currentTarget.open = false;
					trigger.current?.focus();
				}
			}}
		>
			<summary ref={trigger} className="theme-trigger" aria-label={UI_STRINGS.appearance.choose}>
				<svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true">
					<circle cx="10" cy="10" r="6.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
					<path d="M10 3.5a6.5 6.5 0 0 1 0 13Z" fill="currentColor" />
				</svg>
				<span>{UI_STRINGS.appearance.label}</span>
				<span className="hidden min-[600px]:inline text-ink-3">{UI_STRINGS.appearance[theme]}</span>
				<span aria-hidden="true" className="text-ink-3">
					⌄
				</span>
			</summary>
			<fieldset className="theme-options" aria-label={UI_STRINGS.appearance.choose}>
				{THEMES.map((option) => (
					<button
						key={option}
						type="button"
						data-testid={`theme-${option}`}
						aria-pressed={theme === option}
						onClick={() => {
							setTheme(option);
							if (details.current) details.current.open = false;
							trigger.current?.focus();
						}}
					>
						<span>{UI_STRINGS.appearance[option]}</span>
						<span aria-hidden="true">{theme === option ? '✓' : ''}</span>
					</button>
				))}
			</fieldset>
		</details>
	);
}
