import { defineConfig, globalIgnores } from "eslint/config";
import obsidianmd from "eslint-plugin-obsidianmd";

export default defineConfig([
	globalIgnores(["node_modules/", "main.js", "esbuild.config.mjs", "scripts/"]),
	...obsidianmd.configs.recommended,
	{
		languageOptions: {
			parserOptions: {
				projectService: {
					allowDefaultProject: ["eslint.config.*"],
				},
			},
		},
		rules: {
			"obsidianmd/ui/sentence-case": ["warn", { brands: ["ChatGPT", "Vault Scout", "OpenAI"] }],
		},
	},
]);
