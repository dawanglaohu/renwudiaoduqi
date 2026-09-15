import React from 'react';
import { createRoot } from 'react-dom/client';
import { RouterView } from './app/routes.tsx';
import { ThemeProvider } from './app/theme-provider.tsx';
import './styles/tokens.css';
import './styles/base.css';
import './styles/fonts.css';

const rootElement = document.getElementById('root');
if (rootElement) {
	const root = createRoot(rootElement);
	root.render(
		<React.StrictMode>
			<ThemeProvider>
				<RouterView />
			</ThemeProvider>
		</React.StrictMode>,
	);
}
