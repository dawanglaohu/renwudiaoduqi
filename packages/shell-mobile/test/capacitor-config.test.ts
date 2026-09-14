import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import capacitorConfig from '../capacitor.config.ts';

describe('Capacitor Mobile Shell Configuration (AC 1)', () => {
	it('AC 1: webDir points to same build artifact ../web/dist without separate shell build', () => {
		// Acceptance Criterion 1: 同一份 web 产物，webDir 指向同一次构建，不为壳单独打第二份产物
		expect(capacitorConfig.webDir).toBe('../web/dist');
		expect(capacitorConfig.appId).toBe('com.agentscheduler.app');
		expect(capacitorConfig.appName).toBe('Agent任务调度器');
	});

	it('server config serves from https scheme (https://localhost in Capacitor)', () => {
		expect(capacitorConfig.server?.androidScheme).toBe('https');
	});

	it('allows mixed content for local plaintext HTTP daemon connections from https://localhost', () => {
		// usesCleartextTraffic 管控 Android OS 层明文套接字，allowMixedContent 管控 WebView 内 https://localhost 向明文 HTTP daemon 发起 fetch/SSE
		expect(capacitorConfig.android?.allowMixedContent).toBe(true);
	});

	it('AndroidManifest.xml enables cleartext traffic for local daemon HTTP and requires INTERNET permission', () => {
		const manifestPath = resolve(__dirname, '../android/app/src/main/AndroidManifest.xml');
		const content = readFileSync(manifestPath, 'utf8');

		expect(content).toContain('android.permission.INTERNET');
		expect(content).toContain('android:usesCleartextTraffic="true"');

		const stringsPath = resolve(__dirname, '../android/app/src/main/res/values/strings.xml');
		const stringsContent = readFileSync(stringsPath, 'utf8');
		expect(stringsContent).toContain('com.agentscheduler.app');
		expect(stringsContent).toContain('Agent任务调度器');
	});
});
