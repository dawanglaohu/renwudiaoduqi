/**
 * packages/web/src/lib/login-freshness.test.ts
 *
 * 登录态状态谓词、新鲜度判定与探测时间格式化单测（AC 1, AC 5, E-335, E-357）
 */

import type { LoginState } from '@agent-scheduler/shared/api/agents';
import { describe, expect, it } from 'vitest';
import {
	formatProbeTime,
	getLoginBadgeText,
	getLoginBadgeVariant,
	isLoggedIn,
	isLoggedOut,
	isLoginExpired,
	isLoginUnknown,
} from './login-freshness.ts';

describe('login-freshness: predicates', () => {
	it('correctly identifies logged_in, logged_out, and unknown states', () => {
		const loggedInLogin: LoginState = {
			state: 'logged_in',
			reason: null,
			checkedAt: '2026-09-30T00:00:00.000Z',
			loginCommand: null,
			warningCode: null,
		};
		const loggedOutLogin: LoginState = {
			state: 'logged_out',
			reason: 'exit_nonzero',
			checkedAt: '2026-09-30T00:00:00.000Z',
			loginCommand: 'codex login',
			warningCode: null,
		};
		const unknownLogin: LoginState = {
			state: 'unknown',
			reason: 'timeout',
			checkedAt: '2026-09-30T00:00:00.000Z',
			loginCommand: null,
			warningCode: 'E_AGENT_LOGIN_PROBE_FAILED',
		};

		expect(isLoggedIn(loggedInLogin)).toBe(true);
		expect(isLoggedIn(loggedOutLogin)).toBe(false);
		expect(isLoggedIn(unknownLogin)).toBe(false);
		expect(isLoggedIn(null)).toBe(false);
		expect(isLoggedIn(undefined)).toBe(false);

		expect(isLoggedOut(loggedOutLogin)).toBe(true);
		expect(isLoggedOut(loggedInLogin)).toBe(false);
		expect(isLoggedOut(unknownLogin)).toBe(false);

		expect(isLoginUnknown(unknownLogin)).toBe(true);
		expect(isLoginUnknown(loggedInLogin)).toBe(false);
		expect(isLoginUnknown(loggedOutLogin)).toBe(false);
	});
});

describe('login-freshness: expiration and clock skew (E-335, E-357)', () => {
	const baseNow = new Date('2026-09-30T12:00:00.000Z').getTime();

	it('handles missing or malformed checkedAt without crashing', () => {
		expect(isLoginExpired(null, baseNow)).toBe(false);
		expect(isLoginExpired(undefined, baseNow)).toBe(false);
		expect(isLoginExpired('invalid-date', baseNow)).toBe(false);
		expect(formatProbeTime(null, baseNow)).toBe('—');
		expect(formatProbeTime('invalid-date', baseNow)).toBe('—');
	});

	it('does not expire when clock skew sets checkedAt in the future', () => {
		const futureTime = new Date('2026-09-30T13:00:00.000Z').toISOString();
		expect(isLoginExpired(futureTime, baseNow)).toBe(false);
		expect(formatProbeTime(futureTime, baseNow)).toBe('刚刚');
	});

	it('handles sub-minute probes as 刚刚', () => {
		const fortySecondsAgo = new Date(baseNow - 40_000).toISOString();
		expect(formatProbeTime(fortySecondsAgo, baseNow)).toBe('刚刚');
	});

	it('formats probe minutes correctly', () => {
		const fiveMinutesAgo = new Date(baseNow - 5 * 60_000).toISOString();
		expect(formatProbeTime(fiveMinutesAgo, baseNow)).toBe('5 分钟前探测');
	});

	it('strictly tests the 24 hour boundary', () => {
		const twentyThreeHoursFiftyNineMinAgo = new Date(
			baseNow - (23 * 3600_000 + 59 * 60_000),
		).toISOString();
		const exactlyTwentyFourHoursAgo = new Date(baseNow - 24 * 3600_000).toISOString();
		const twentyFiveHoursAgo = new Date(baseNow - 25 * 3600_000).toISOString();

		expect(isLoginExpired(twentyThreeHoursFiftyNineMinAgo, baseNow)).toBe(false);
		expect(isLoginExpired(exactlyTwentyFourHoursAgo, baseNow)).toBe(true);
		expect(isLoginExpired(twentyFiveHoursAgo, baseNow)).toBe(true);
	});
});

describe('login-freshness: badge text and variant', () => {
	const baseNow = new Date('2026-09-30T12:00:00.000Z').getTime();

	it('returns null when login is missing', () => {
		expect(getLoginBadgeText(null)).toBeNull();
		expect(getLoginBadgeText(undefined)).toBeNull();
		expect(getLoginBadgeVariant(null)).toBe('neutral');
	});

	it('formats three states under 24 hours', () => {
		const loggedIn: LoginState = {
			state: 'logged_in',
			reason: null,
			checkedAt: new Date(baseNow - 10 * 60_000).toISOString(),
			loginCommand: null,
			warningCode: null,
		};
		const loggedOut: LoginState = {
			state: 'logged_out',
			reason: 'exit_nonzero',
			checkedAt: new Date(baseNow - 10 * 60_000).toISOString(),
			loginCommand: 'login command',
			warningCode: null,
		};
		const unknown: LoginState = {
			state: 'unknown',
			reason: 'timeout',
			checkedAt: new Date(baseNow - 10 * 60_000).toISOString(),
			loginCommand: null,
			warningCode: null,
		};

		expect(getLoginBadgeText(loggedIn, baseNow)).toBe('已登录');
		expect(getLoginBadgeVariant(loggedIn, baseNow)).toBe('neutral');

		expect(getLoginBadgeText(loggedOut, baseNow)).toBe('未登录');
		expect(getLoginBadgeVariant(loggedOut, baseNow)).toBe('warm');

		expect(getLoginBadgeText(unknown, baseNow)).toBe('无法判定');
		expect(getLoginBadgeVariant(unknown, baseNow)).toBe('neutral');
	});

	it('appends · 已过期 and degrades to expired variant when checkedAt > 24h', () => {
		const expiredLoggedIn: LoginState = {
			state: 'logged_in',
			reason: null,
			checkedAt: new Date(baseNow - 25 * 3600_000).toISOString(),
			loginCommand: null,
			warningCode: null,
		};
		const expiredLoggedOut: LoginState = {
			state: 'logged_out',
			reason: 'exit_nonzero',
			checkedAt: new Date(baseNow - 25 * 3600_000).toISOString(),
			loginCommand: 'login command',
			warningCode: null,
		};

		expect(getLoginBadgeText(expiredLoggedIn, baseNow)).toBe('已登录 · 已过期');
		expect(getLoginBadgeVariant(expiredLoggedIn, baseNow)).toBe('expired');

		expect(getLoginBadgeText(expiredLoggedOut, baseNow)).toBe('未登录 · 已过期');
		expect(getLoginBadgeVariant(expiredLoggedOut, baseNow)).toBe('expired');
	});
});
