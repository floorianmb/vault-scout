// Copies the built plugin into a vault: node scripts/deploy.mjs <vault path>
import fs from "fs";
import path from "path";

const vault = process.argv[2];
if (!vault || !fs.existsSync(path.join(vault, ".obsidian"))) {
	console.error("Usage: npm run deploy -- <vault path> (the folder that contains .obsidian)");
	process.exit(1);
}
const target = path.join(vault, ".obsidian", "plugins", "vault-scout");
fs.mkdirSync(target, { recursive: true });
for (const file of ["main.js", "manifest.json", "styles.css"]) {
	fs.copyFileSync(file, path.join(target, file));
}
console.log(target);
