import { beforeAll, describe, expect, it, vi } from "bun:test";
import { SessionAccountSelectorComponent } from "@oh-my-pi/pi-coding-agent/modes/components/session-account-selector";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { toSessionPinAccounts } from "@oh-my-pi/pi-coding-agent/slash-commands/helpers/session-pin";

beforeAll(async () => {
	await initTheme();
});

const accounts = toSessionPinAccounts([
	{ position: 0, credentialId: 11, email: "first@example.com", active: false, pinned: false, sessionPinned: false },
	{ position: 1, credentialId: 12, email: "second@example.com", active: true, pinned: false, sessionPinned: false },
]);

/** First account holds the durable pin; second is this session's deliberate pin. */
const pinnedAccounts = toSessionPinAccounts([
	{ position: 0, credentialId: 11, email: "first@example.com", active: false, pinned: true, sessionPinned: false },
	{ position: 1, credentialId: 12, email: "second@example.com", active: true, pinned: false, sessionPinned: true },
]);

describe("SessionAccountSelectorComponent", () => {
	it("handles navigation, selection, Escape, and Ctrl+C while focused", () => {
		const selected: number[] = [];
		let cancellations = 0;
		const component = new SessionAccountSelectorComponent(
			"Anthropic",
			accounts,
			"session",
			account => {
				if (account !== "auto") selected.push(account.credentialId);
			},
			() => {
				cancellations += 1;
			},
		);

		component.handleInput("\x1b[A");
		component.handleInput("\n");
		expect(selected).toEqual([11]);

		const escapeComponent = new SessionAccountSelectorComponent(
			"Anthropic",
			accounts,
			"session",
			() => {},
			() => {
				cancellations += 1;
			},
		);
		escapeComponent.handleInput("\x1b");

		const ctrlCComponent = new SessionAccountSelectorComponent(
			"Anthropic",
			accounts,
			"session",
			() => {},
			() => {
				cancellations += 1;
			},
		);
		ctrlCComponent.handleInput("\x03");
		expect(cancellations).toBe(2);
	});

	it("renders both pin markers and a scope-appropriate Auto row", () => {
		const rendered = new SessionAccountSelectorComponent("Anthropic", pinnedAccounts, "session", vi.fn(), vi.fn())
			.render(100)
			.map(line => Bun.stripANSI(line))
			.join("\n");
		expect(rendered).toContain("for this session");
		expect(rendered).toContain("pinned for this session");
		expect(rendered).toContain("pinned always");
		expect(rendered).toContain("clear this session's pin");
	});

	it("titles the durable scope for durability and clears the durable pin via Auto", () => {
		const onSelect = vi.fn();
		const selector = new SessionAccountSelectorComponent("Anthropic", pinnedAccounts, "always", onSelect, vi.fn());
		const rendered = selector
			.render(100)
			.map(line => Bun.stripANSI(line))
			.join("\n");
		expect(rendered).toContain("always use");
		expect(rendered).toContain("clear the durable pin");

		// Durable scope opens on the durably-pinned row (index 0), so Enter
		// re-affirms the existing pin instead of silently reassigning it.
		selector.handleInput("\n");
		expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ credentialId: 11 }));
	});

	it("session scope opens on the session-active account", () => {
		const onSelect = vi.fn();
		const selector = new SessionAccountSelectorComponent("Anthropic", pinnedAccounts, "session", onSelect, vi.fn());
		selector.handleInput("\n");
		expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ credentialId: 12 }));
	});

	it("selecting the trailing Auto row reports a clear rather than an account", () => {
		const onSelect = vi.fn();
		const selector = new SessionAccountSelectorComponent("Anthropic", pinnedAccounts, "session", onSelect, vi.fn());
		selector.handleInput("\x1b[B"); // session-active index 1 -> Auto at index 2
		selector.handleInput("\n");
		expect(onSelect).toHaveBeenCalledWith("auto");
	});
});
