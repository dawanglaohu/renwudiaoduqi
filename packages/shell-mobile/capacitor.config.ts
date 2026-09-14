import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
	appId: 'com.agentscheduler.app',
	appName: 'Agent任务调度器',
	webDir: '../web/dist',
	server: {
		androidScheme: 'https',
	},
	// 自托管 daemon 只有明文 HTTP、页面源恒为 https://localhost，必须开启混合内容允许 WebView 发起局域网 HTTP 请求与 SSE 长连
	android: {
		allowMixedContent: true,
	},
};

export default config;
