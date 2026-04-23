export interface ExtensionUIContext {
	notify(message: string, type?: "info" | "warning" | "error" | "success"): void;
	input(title: string, placeholder?: string): Promise<string | undefined>;
	select(
		title: string,
		options: string[],
		opts?: { signal?: AbortSignal; allowMultiple?: boolean; timeout?: number },
	): Promise<string | string[] | undefined>;
}

export interface ExtensionCommandContext {
	ui: ExtensionUIContext;
	modelRegistry: {
		authStorage: {
			reload(): void;
		};
	};
}

export interface ExtensionContext {
	modelRegistry: {
		authStorage: {
			reload(): void;
		};
	};
}

export interface ExtensionAPI {
	on(event: string, handler: (event: unknown, ctx: any) => Promise<void> | void): void;
	registerCommand(
		name: string,
		command: {
			description: string;
			getArgumentCompletions?: (prefix: string) => Array<{ value: string; label: string }>;
			handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> | void;
		},
	): void;
}
