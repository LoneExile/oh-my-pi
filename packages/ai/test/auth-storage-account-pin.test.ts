import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type AuthCredentialStore, AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai/auth-storage";
import { registerOAuthProvider, unregisterOAuthProviders } from "@oh-my-pi/pi-ai/registry/oauth";
import { removeWithRetries } from "../../utils/src/temp";

const PROVIDER = "unit-pin-oauth";
const SOURCE = "auth-storage-account-pin-test";

function farExpiry(): number {
	return Date.now() + 60 * 60_000;
}

/**
 * Two OAuth accounts with distinct access tokens. `getApiKey` returns the
 * access token verbatim, so the returned string identifies which account the
 * selector chose. No ranking strategy is registered, so selection follows the
 * plain hash/round-robin order — the clean baseline for asserting that a pin
 * overrides it.
 */
async function seedTwoAccounts(authStorage: AuthStorage): Promise<{ idA: number; idB: number }> {
	await authStorage.set(PROVIDER, [
		{ type: "oauth", access: "access-A", refresh: "refresh-A", expires: farExpiry(), email: "a@example.com" },
		{ type: "oauth", access: "access-B", refresh: "refresh-B", expires: farExpiry(), email: "b@example.com" },
	]);
	const stored = authStorage.listStoredCredentials(PROVIDER);
	const idA = stored.find(row => row.credential.type === "oauth" && row.credential.email === "a@example.com")?.id;
	const idB = stored.find(row => row.credential.type === "oauth" && row.credential.email === "b@example.com")?.id;
	if (idA === undefined || idB === undefined) throw new Error("seed failed");
	return { idA, idB };
}

describe("AuthStorage account pin", () => {
	let tempDir = "";
	let dbPath = "";
	let store: AuthCredentialStore | undefined;
	let authStorage: AuthStorage | undefined;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-ai-pin-"));
		dbPath = path.join(tempDir, "agent.db");
		store = await SqliteAuthCredentialStore.open(dbPath);
		authStorage = new AuthStorage(store);
		registerOAuthProvider({
			id: PROVIDER,
			name: "Pin Unit",
			sourceId: SOURCE,
			async login() {
				return { access: "login", refresh: "login", expires: farExpiry() };
			},
			async refreshToken(credentials) {
				return { ...credentials, expires: farExpiry() };
			},
			getApiKey(credentials) {
				return credentials.access;
			},
		});
	});

	afterEach(async () => {
		unregisterOAuthProviders(SOURCE);
		store?.close();
		store = undefined;
		authStorage = undefined;
		if (tempDir) {
			await removeWithRetries(tempDir);
			tempDir = "";
		}
	});

	test("pin forces every session to the pinned account, overriding hash balancing", async () => {
		if (!authStorage) throw new Error("setup failed");
		const { idB } = await seedTwoAccounts(authStorage);

		// Sessions whose unpinned hash maps to different accounts prove balancing
		// is live before the pin: with 2 accounts, xxHash32(sessionId) % 2 spreads
		// across a handful of ids. Collect the unpinned choice for several sessions.
		const sessions = ["s0", "s1", "s2", "s3", "s4", "s5"];
		const unpinned = new Set<string>();
		for (const s of sessions) unpinned.add((await authStorage.getApiKey(PROVIDER, s)) ?? "none");
		expect(unpinned.has("access-A") && unpinned.has("access-B")).toBe(true);

		// Pin account B. Every session — including ones that hash-mapped to A and
		// already recorded A as session-sticky above — must now resolve to B.
		expect(authStorage.setPinnedCredential(PROVIDER, idB)).toBe(true);
		expect(authStorage.getPinnedCredentialId(PROVIDER)).toBe(idB);
		for (const s of sessions) {
			expect(await authStorage.getApiKey(PROVIDER, s)).toBe("access-B");
		}
	});

	test("clearing the pin restores balancing", async () => {
		if (!authStorage) throw new Error("setup failed");
		const { idA, idB } = await seedTwoAccounts(authStorage);

		authStorage.setPinnedCredential(PROVIDER, idA);
		expect(await authStorage.getApiKey(PROVIDER, "sX")).toBe("access-A");

		authStorage.setPinnedCredential(PROVIDER, null);
		expect(authStorage.getPinnedCredentialId(PROVIDER)).toBeUndefined();
		// Sticky from the pinned call may persist for sX, so assert via a fresh
		// session that the pin no longer forces A: at least one of a spread of
		// sessions resolves to B once balancing is restored.
		void idB;
		const fresh = new Set<string>();
		for (const s of ["u0", "u1", "u2", "u3", "u4", "u5"]) {
			fresh.add((await authStorage.getApiKey(PROVIDER, s)) ?? "none");
		}
		expect(fresh.has("access-B")).toBe(true);
	});

	test("pin is durable across store reopen", async () => {
		if (!authStorage || !store) throw new Error("setup failed");
		const { idB } = await seedTwoAccounts(authStorage);
		authStorage.setPinnedCredential(PROVIDER, idB);

		store.close();
		store = await SqliteAuthCredentialStore.open(dbPath);
		authStorage = new AuthStorage(store);
		await authStorage.reload();

		expect(authStorage.getPinnedCredentialId(PROVIDER)).toBe(idB);
		expect(await authStorage.getApiKey(PROVIDER, "reopened")).toBe("access-B");
	});

	test("a stale pin (removed account) falls back to balancing instead of breaking", async () => {
		if (!authStorage) throw new Error("setup failed");
		const { idB } = await seedTwoAccounts(authStorage);
		authStorage.setPinnedCredential(PROVIDER, idB);

		// Drop account B, leaving only A. The pin id no longer resolves to a row.
		await authStorage.set(PROVIDER, [
			{ type: "oauth", access: "access-A", refresh: "refresh-A", expires: farExpiry(), email: "a@example.com" },
		]);
		expect(await authStorage.getApiKey(PROVIDER, "stale")).toBe("access-A");
	});

	test("setPinnedCredential rejects an unknown credential id", async () => {
		if (!authStorage) throw new Error("setup failed");
		await seedTwoAccounts(authStorage);
		expect(authStorage.setPinnedCredential(PROVIDER, 999_999)).toBe(false);
		expect(authStorage.getPinnedCredentialId(PROVIDER)).toBeUndefined();
	});

	test("an explicit /session pin outranks the durable pin for that session only", async () => {
		if (!authStorage) throw new Error("setup failed");
		const { idA, idB } = await seedTwoAccounts(authStorage);
		authStorage.setPinnedCredential(PROVIDER, idA);

		// The narrower, deliberate choice wins in the session that made it…
		expect(authStorage.pinSessionOAuthAccount(PROVIDER, "pinned-session", idB)).toBe(true);
		expect(await authStorage.getApiKey(PROVIDER, "pinned-session")).toBe("access-B");
		// …and leaves every other session on the durable pin.
		expect(await authStorage.getApiKey(PROVIDER, "other-session")).toBe("access-A");
	});

	test("an explicit session pin survives repeated resolutions", async () => {
		if (!authStorage) throw new Error("setup failed");
		const { idA, idB } = await seedTwoAccounts(authStorage);
		authStorage.setPinnedCredential(PROVIDER, idA);
		authStorage.pinSessionOAuthAccount(PROVIDER, "repeat", idB);

		// Each resolution re-records the session's credential. That bookkeeping write
		// is an automatic landing, so it must not downgrade the deliberate pin and
		// hand the session back to the durable pin on the next call.
		for (let call = 0; call < 3; call++) {
			expect(await authStorage.getApiKey(PROVIDER, "repeat")).toBe("access-B");
			expect(authStorage.hasExplicitSessionOAuthPin(PROVIDER, "repeat")).toBe(true);
		}
	});

	test("clearing the explicit session pin falls back to the durable pin", async () => {
		if (!authStorage) throw new Error("setup failed");
		const { idA, idB } = await seedTwoAccounts(authStorage);
		authStorage.setPinnedCredential(PROVIDER, idA);
		authStorage.pinSessionOAuthAccount(PROVIDER, "s", idB);
		expect(await authStorage.getApiKey(PROVIDER, "s")).toBe("access-B");

		expect(authStorage.clearSessionOAuthPin(PROVIDER, "s")).toBe(true);
		expect(authStorage.hasExplicitSessionOAuthPin(PROVIDER, "s")).toBe(false);
		expect(await authStorage.getApiKey(PROVIDER, "s")).toBe("access-A");
	});

	test("incidental stickiness does NOT outrank the durable pin", async () => {
		if (!authStorage) throw new Error("setup failed");
		const { idB } = await seedTwoAccounts(authStorage);

		// Let balancing record a sticky account for a spread of sessions first, so
		// some of them land on A. Pinning B afterwards must still win everywhere:
		// only a deliberate /session pin may outrank a durable pin.
		const sessions = ["i0", "i1", "i2", "i3", "i4", "i5"];
		for (const s of sessions) await authStorage.getApiKey(PROVIDER, s);
		for (const s of sessions) expect(authStorage.hasExplicitSessionOAuthPin(PROVIDER, s)).toBe(false);

		authStorage.setPinnedCredential(PROVIDER, idB);
		for (const s of sessions) expect(await authStorage.getApiKey(PROVIDER, s)).toBe("access-B");
	});

	test("listOAuthAccounts reports durable and explicit-session pins separately", async () => {
		if (!authStorage) throw new Error("setup failed");
		const { idA, idB } = await seedTwoAccounts(authStorage);
		authStorage.setPinnedCredential(PROVIDER, idA);
		authStorage.pinSessionOAuthAccount(PROVIDER, "s", idB);

		const rows = authStorage.listOAuthAccounts(PROVIDER, "s");
		const rowA = rows.find(row => row.credentialId === idA);
		const rowB = rows.find(row => row.credentialId === idB);
		expect(rowA?.pinned).toBe(true);
		expect(rowA?.sessionPinned).toBe(false);
		expect(rowB?.pinned).toBe(false);
		expect(rowB?.sessionPinned).toBe(true);
		// `active` tracks what this session actually routes to — the session pin.
		expect(rowB?.active).toBe(true);
	});

	test("attribution names the same account selection routes to", async () => {
		if (!authStorage) throw new Error("setup failed");
		const { idA, idB } = await seedTwoAccounts(authStorage);
		authStorage.setPinnedCredential(PROVIDER, idA);
		authStorage.pinSessionOAuthAccount(PROVIDER, "s", idB);

		// The token sent and the account the UI reports must not disagree.
		expect(await authStorage.getApiKey(PROVIDER, "s")).toBe("access-B");
		expect(authStorage.listOAuthAccounts(PROVIDER, "s").find(row => row.active)?.credentialId).toBe(idB);
		expect(await authStorage.getApiKey(PROVIDER, "t")).toBe("access-A");
		expect(authStorage.listOAuthAccounts(PROVIDER, "t").find(row => row.active)?.credentialId).toBe(idA);
	});
});
