import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
	appId: 'com.agentscheduler.app',
	appName: 'Agent任务调度器',
	webDir: '../web/dist',
	server: {
		androidScheme: 'https',
	},
};

export default config;
