import { registerHooks } from "node:module";
import { DatabaseSync } from "node:sqlite";

// Only Electron's host shell is substituted; filesystem and SQLite stay real.
export const loadMainModules = (profilePath) => {
	const databases = [];
	globalThis.rosemaryTestProfile = profilePath;
	globalThis.rosemaryTestDatabase = class extends DatabaseSync {
		constructor(...args) {
			super(...args);
			databases.push(this);
		}
	};
	const hooks = registerHooks({
		resolve(specifier, context, nextResolve) {
			if (specifier === "electron")
				return { url: "rosemary-test:electron", shortCircuit: true };
			if (specifier === "node:sqlite")
				return { url: "rosemary-test:sqlite", shortCircuit: true };
			try {
				return nextResolve(specifier, context);
			} catch (error) {
				if (specifier.startsWith(".") && !specifier.endsWith(".ts"))
					return nextResolve(`${specifier}.ts`, context);
				throw error;
			}
		},
		load(url, context, nextLoad) {
			if (url === "rosemary-test:electron")
				return {
					format: "module",
					source:
						"export const app = { getPath: () => globalThis.rosemaryTestProfile }; export const shell = {}; export const net = { request: (...args) => globalThis.rosemaryTestNet(...args) };",
					shortCircuit: true,
				};
			if (url === "rosemary-test:sqlite")
				return {
					format: "module",
					source:
						"export const DatabaseSync = globalThis.rosemaryTestDatabase;",
					shortCircuit: true,
				};
			return nextLoad(url, context);
		},
	});
	return () => {
		for (const db of databases) db.close();
		hooks.deregister();
	};
};
