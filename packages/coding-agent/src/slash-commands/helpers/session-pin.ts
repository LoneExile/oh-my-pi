import type { AccountPinScope, OAuthAccountSummary } from "../../session/auth-storage";
import { formatActiveAccountLabel } from "./active-oauth-account";

/** Stored OAuth account rendered and matched by `/session pin`. */
export interface SessionPinAccount extends OAuthAccountSummary {
	label: string;
}

/** Add stable user-facing labels to provider account summaries. */
export function toSessionPinAccounts(accounts: readonly OAuthAccountSummary[]): SessionPinAccount[] {
	return accounts.map(account => {
		const enterpriseUrl = account.enterpriseUrl?.trim();
		return {
			...account,
			label: (formatActiveAccountLabel(account) ?? enterpriseUrl) || `OAuth credential #${account.credentialId}`,
		};
	});
}

export type { AccountPinScope };

export interface ParsedPinArgs {
	scope: AccountPinScope;
	/** Account selector, or "auto" to clear the pin at `scope`. Empty means "open the picker". */
	selector: string;
}

/**
 * Parse the argument tail of `/session pin`, accepting a leading `--always`
 * (or bare `always`) scope flag and treating `auto`/`--auto`/`clear` as a
 * request to clear the pin at that scope.
 */
export function parsePinArgs(rest: string): ParsedPinArgs {
	let selector = rest.trim();
	let scope: AccountPinScope = "session";
	const scopeMatch = /^(--always|always|--session|session)\b/i.exec(selector);
	if (scopeMatch) {
		scope = scopeMatch[1].toLowerCase().endsWith("always") ? "always" : "session";
		selector = selector.slice(scopeMatch[0].length).trim();
	}
	if (/^(auto|--auto|clear|--clear|off)$/i.test(selector)) selector = "auto";
	return { scope, selector };
}

/** Match a `/session pin` selector by 1-based position or exact account identity. */
export function matchSessionPinAccounts(accounts: readonly SessionPinAccount[], selector: string): SessionPinAccount[] {
	const wanted = selector.trim().toLowerCase();
	if (!wanted) return [];
	if (wanted === "active") return accounts.filter(account => account.active);

	if (/^\d+$/.test(wanted)) {
		const position = Number(wanted) - 1;
		const positioned = accounts.find(account => account.position === position);
		if (positioned) return [positioned];
	}

	return accounts.filter(account =>
		[
			account.label,
			account.email,
			account.accountId,
			account.projectId,
			account.enterpriseUrl,
			account.orgId,
			account.orgName,
			`OAuth credential #${account.credentialId}`,
		].some(value => value?.trim().toLowerCase() === wanted),
	);
}
