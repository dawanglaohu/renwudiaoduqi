import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app/app.tsx';
import { bootstrap } from './app/bootstrap.ts';
import { ThemeProvider } from './app/theme-provider.tsx';
import { ConnectionStatusBanner } from './features/run-deck/use-connection-state.ts';
import './styles/tokens.css';
import './styles/base.css';
import './styles/fonts.css';

async function start(): Promise<void> {
	try {
		await bootstrap();
	} catch (error: unknown) {
		// 启动序列出错也要挂载：守卫会把用户送去配对页，绝不白屏
		console.error('[main] bootstrap failed, mounting in unpaired state:', error);
	}
	const rootElement = document.getElementById('root');
	if (rootElement) {
		createRoot(rootElement).render(
			<React.StrictMode>
				<ThemeProvider>
					<App renderTopbar={() => <ConnectionStatusBanner />} />
				</ThemeProvider>
			</React.StrictMode>,
		);
	}
}

void start();
