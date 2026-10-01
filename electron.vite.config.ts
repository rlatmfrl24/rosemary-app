import { resolve } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "electron-vite";

export default defineConfig({
	main: {},
	preload: { build: { externalizeDeps: false } },
	renderer: {
		server: {
			host: "127.0.0.1",
			port: 3000,
			strictPort: true,
		},
		resolve: {
			alias: {
				"@renderer": resolve("src/renderer/src"),
			},
		},
		plugins: [react(), tailwindcss()],
	},
});
