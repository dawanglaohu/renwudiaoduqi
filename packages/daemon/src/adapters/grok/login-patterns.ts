/**
 * Grok login error detection patterns.
 *
 * Per Section 04 & 08-后端架构:
 * grok/login-patterns.ts holds the stderr keyword rules for detecting unauthenticated state.
 * Exit code 0 -> logged_in;
 * Non-zero exit code + auth/login stderr keywords -> logged_out;
 * Timeout (including network disconnect) or non-zero without auth keywords -> unknown.
 */

export const GROK_AUTH_ERROR_PATTERNS: readonly RegExp[] = Object.freeze([
	/\b(?:unauthorized|unauthenticated)\b/i,
	/\bauth(?:entication)?\s+(?:required|failed|error)\b/i,
	/\b(?:please\s+)?logged in\b/i,
	/\bnot\s+logged in\b/i,
	/\blogin\s+(?:required|failed)\b/i,
	/\b(?:api\s*key|token)\s+(?:is\s+)?(?:missing|invalid|expired|not\s+set)\b/i,
	/\b(?:invalid|missing)\s+(?:api\s*key|bearer\s*token)\b/i,
]);

export function isGrokAuthError(stderr: string): boolean {
	if (!stderr) return false;
	return GROK_AUTH_ERROR_PATTERNS.some((pattern) => pattern.test(stderr));
}
