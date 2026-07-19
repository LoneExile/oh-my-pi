import { Container, type SelectItem, SelectList, type SgrMouseEvent, Spacer, TruncatedText } from "@oh-my-pi/pi-tui";
import { getSelectListTheme, theme } from "../../modes/theme/theme";
import type { AccountPinScope, SessionPinAccount } from "../../slash-commands/helpers/session-pin";
import { DynamicBorder } from "./dynamic-border";

const ACCOUNT_SELECTOR_MAX_VISIBLE = 10;
const ACCOUNT_LIST_ROW_OFFSET = 4;
/** Sentinel value of the trailing row that clears the pin at the selected scope. */
const AUTO_VALUE = "\u0000auto";

/** What the account picker resolved to: a specific account, or "clear the pin". */
export type SessionAccountChoice = SessionPinAccount | "auto";

/** Account picker opened by `/session pin`, at either session or durable scope. */
export class SessionAccountSelectorComponent extends Container {
	#selectList: SelectList;

	constructor(
		providerName: string,
		accounts: readonly SessionPinAccount[],
		scope: AccountPinScope,
		onSelect: (choice: SessionAccountChoice) => void,
		onCancel: () => void,
	) {
		super();
		const accountsByValue = new Map<string, SessionPinAccount>();
		const items: SelectItem[] = accounts.map(account => {
			const value = String(account.credentialId);
			accountsByValue.set(value, account);
			// Describe the strongest fact about the row: a deliberate pin, then the
			// durable pin, then mere session stickiness.
			const notes: string[] = [];
			if (account.sessionPinned) notes.push("pinned for this session");
			else if (account.active) notes.push("active for this session");
			if (account.pinned) notes.push("pinned always");
			return { value, label: account.label, description: notes.join(" · ") || undefined };
		});
		items.push({
			value: AUTO_VALUE,
			label: "Auto",
			description: scope === "always" ? "clear the durable pin" : "clear this session's pin",
		});

		this.addChild(new DynamicBorder());
		this.addChild(new Spacer(1));
		const title =
			scope === "always"
				? `Select a ${providerName} account to always use:`
				: `Select a ${providerName} account for this session:`;
		this.addChild(new TruncatedText(theme.bold(title)));
		this.addChild(new Spacer(1));

		this.#selectList = new SelectList(
			items,
			Math.min(Math.max(items.length, 1), ACCOUNT_SELECTOR_MAX_VISIBLE),
			getSelectListTheme(),
		);
		// Start on the row the chosen scope currently points at, so Enter is a no-op
		// rather than a surprise reassignment.
		const startIndex = accounts.findIndex(account => (scope === "always" ? account.pinned : account.active));
		if (startIndex >= 0) this.#selectList.setSelectedIndex(startIndex);
		this.#selectList.onSelect = item => {
			if (item.value === AUTO_VALUE) {
				onSelect("auto");
				return;
			}
			const account = accountsByValue.get(item.value);
			if (account) onSelect(account);
		};
		this.#selectList.onCancel = onCancel;
		this.addChild(this.#selectList);
		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder());
	}

	/** Forward keyboard navigation and cancellation when the wrapper owns focus. */
	handleInput(keyData: string): void {
		this.#selectList.handleInput(keyData);
	}

	/** Route mouse selection through the title rows into the account list. */
	routeMouse(event: SgrMouseEvent, line: number, col: number): void {
		this.#selectList.routeMouse(event, line - ACCOUNT_LIST_ROW_OFFSET, col);
	}
}
