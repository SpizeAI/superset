/**
 * Build-time guard for native runtime dependencies.
 *
 * This fails early when:
 * 1) libsql internals are accidentally bundled into dist/main (dynamic require risk)
 * 2) required native runtime packages are missing from apps/desktop/node_modules
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const projectRoot = join(import.meta.dirname, "..");

function fail(message: string): never {
	console.error(`[validate:native-runtime] ${message}`);
	process.exit(1);
}

function assertExists(path: string, reason: string): void {
	if (!existsSync(path)) {
		fail(`${reason}\nMissing path: ${path}`);
	}
}

function validateLibsqlNotBundled(): void {
	const sourceMapPath = join(projectRoot, "dist", "main", "index.js.map");
	assertExists(
		sourceMapPath,
		"Main bundle sourcemap not found. Run `bun run compile:app` first.",
	);

	const sourceMap = readFileSync(sourceMapPath, "utf8");
	if (sourceMap.includes("node_modules/.bun/libsql@")) {
		fail(
			[
				"Detected bundled `libsql` sources in dist/main/index.js.map.",
				"This usually causes runtime dynamic require failures in packaged apps.",
				"Ensure `libsql` stays in `rollupOptions.external` for the main process.",
			].join("\n"),
		);
	}

	const distMainDir = join(projectRoot, "dist", "main");
	assertExists(
		distMainDir,
		"Main bundle output not found. Run `bun run compile:app` first.",
	);

	const jsFiles = collectFiles(distMainDir).filter((filePath) =>
		filePath.endsWith(".js"),
	);
	for (const filePath of jsFiles) {
		const content = readFileSync(filePath, "utf8");
		const hasDynamicLibsqlRequirePattern = /@libsql\/\$\{target\}/.test(
			content,
		);
		if (
			hasDynamicLibsqlRequirePattern ||
			content.includes("commonjsRequire(`@libsql/")
		) {
			fail(
				[
					"Detected dynamic `@libsql/<platform>` require logic in bundled JS output.",
					"This indicates libsql internals were bundled instead of externalized.",
					`Offending file: ${filePath}`,
				].join("\n"),
			);
		}
	}

	console.log(
		"[validate:native-runtime] OK: libsql is externalized from main bundle",
	);
}

function collectFiles(rootDir: string): string[] {
	const entries = readdirSync(rootDir, { withFileTypes: true });
	const files: string[] = [];
	for (const entry of entries) {
		const fullPath = join(rootDir, entry.name);
		if (entry.isDirectory()) {
			files.push(...collectFiles(fullPath));
			continue;
		}
		files.push(fullPath);
	}
	return files;
}

function getPlatformLibsqlCandidates(): string[] {
	const targetArch = process.env.TARGET_ARCH || process.arch;
	const targetPlatform = process.env.TARGET_PLATFORM || process.platform;

	if (targetPlatform === "darwin") {
		return [
			targetArch === "arm64" ? "@libsql/darwin-arm64" : "@libsql/darwin-x64",
		];
	}

	if (targetPlatform === "linux") {
		if (targetArch === "arm64") {
			return ["@libsql/linux-arm64-gnu", "@libsql/linux-arm64-musl"];
		}
		if (targetArch === "arm") {
			return ["@libsql/linux-arm-gnueabihf", "@libsql/linux-arm-musleabihf"];
		}
		return ["@libsql/linux-x64-gnu", "@libsql/linux-x64-musl"];
	}

	if (targetPlatform === "win32") {
		return ["@libsql/win32-x64-msvc"];
	}

	return [];
}

function getPlatformAstGrepCandidates(): string[] {
	const targetArch = process.env.TARGET_ARCH || process.arch;
	const targetPlatform = process.env.TARGET_PLATFORM || process.platform;

	if (targetPlatform === "darwin") {
		return [
			targetArch === "arm64"
				? "@ast-grep/napi-darwin-arm64"
				: "@ast-grep/napi-darwin-x64",
		];
	}

	if (targetPlatform === "linux") {
		if (targetArch === "arm64") {
			return ["@ast-grep/napi-linux-arm64-gnu"];
		}
		return ["@ast-grep/napi-linux-x64-gnu", "@ast-grep/napi-linux-x64-musl"];
	}

	if (targetPlatform === "win32") {
		return ["@ast-grep/napi-win32-x64-msvc"];
	}

	return [];
}

function validateNativeModulesPrepared(): void {
	const nodeModulesDir = join(projectRoot, "node_modules");
	assertExists(
		nodeModulesDir,
		"node_modules not found. Run `bun install` and `bun run copy:native-modules` first.",
	);

	const requiredModules = [
		"libsql/package.json",
		"@neon-rs/load/package.json",
		"detect-libc/package.json",
	];
	for (const modulePath of requiredModules) {
		assertExists(
			join(nodeModulesDir, modulePath),
			"Required native runtime dependency is missing.",
		);
	}

	const platformCandidates = getPlatformLibsqlCandidates();
	if (platformCandidates.length === 0) {
		console.warn(
			`[validate:native-runtime] Skipping platform-specific @libsql check for ${process.platform}/${process.arch}`,
		);
		return;
	}

	const hasPlatformPackage = platformCandidates.some((pkg) =>
		existsSync(join(nodeModulesDir, pkg, "package.json")),
	);
	if (!hasPlatformPackage) {
		fail(
			[
				"Missing platform-specific @libsql package.",
				`Expected one of: ${platformCandidates.join(", ")}`,
				"Run `bun run copy:native-modules` and ensure optional dependencies are materialized.",
			].join("\n"),
		);
	}

	console.log(
		`[validate:native-runtime] OK: platform libsql package present (${platformCandidates.join(" | ")})`,
	);

	// Validate @ast-grep/napi platform package
	const astGrepCandidates = getPlatformAstGrepCandidates();
	if (astGrepCandidates.length > 0) {
		const hasAstGrepPlatformPackage = astGrepCandidates.some((pkg) =>
			existsSync(join(nodeModulesDir, pkg, "package.json")),
		);
		if (!hasAstGrepPlatformPackage) {
			fail(
				[
					"Missing platform-specific @ast-grep/napi package.",
					`Expected one of: ${astGrepCandidates.join(", ")}`,
					"Run `bun run copy:native-modules` and ensure optional dependencies are materialized.",
				].join("\n"),
			);
		}
		console.log(
			`[validate:native-runtime] OK: platform ast-grep package present (${astGrepCandidates.join(" | ")})`,
		);
	}
}

function validateVoiceRuntimePrepared(): void {
	const targetPlatform = process.env.TARGET_PLATFORM || process.platform;
	if (targetPlatform !== "darwin") {
		console.log(
			`[validate:native-runtime] Skipping voice native checks for ${targetPlatform}`,
		);
		return;
	}

	const nodeModulesDir = join(projectRoot, "node_modules");
	const requiredVoiceModules = [
		"@picovoice/pvrecorder-node/package.json",
		"@picovoice/porcupine-node/package.json",
		"whisper-node/package.json",
	];
	for (const modulePath of requiredVoiceModules) {
		assertExists(
			join(nodeModulesDir, modulePath),
			"Required voice runtime dependency is missing.",
		);
	}

	const whisperCppDir = join(nodeModulesDir, "whisper-node", "lib", "whisper.cpp");
	assertExists(
		whisperCppDir,
		"whisper.cpp runtime directory missing from whisper-node.",
	);

	const hasWhisperBinary = ["main", "main.exe"].some((entry) =>
		existsSync(join(whisperCppDir, entry)),
	);
	if (!hasWhisperBinary) {
		fail(
			[
				"whisper.cpp binary missing from whisper-node runtime package.",
				`Checked: ${join(whisperCppDir, "main")} and ${join(whisperCppDir, "main.exe")}`,
			].join("\n"),
		);
	}

	const modelsDir = join(whisperCppDir, "models");
	assertExists(
		modelsDir,
		"whisper.cpp models directory missing. Run model download before packaging.",
	);
	const hasGgmlModel = readdirSync(modelsDir).some(
		(entry) => entry.startsWith("ggml-") && entry.endsWith(".bin"),
	);
	if (!hasGgmlModel) {
		fail(
			[
				"No whisper.cpp GGML model found in runtime models directory.",
				`Checked: ${modelsDir}`,
				"Run `npx whisper-node download base.en` and re-run copy:native-modules.",
			].join("\n"),
		);
	}

	console.log("[validate:native-runtime] OK: voice native runtime modules present");
}

function main(): void {
	validateLibsqlNotBundled();
	validateNativeModulesPrepared();
	validateVoiceRuntimePrepared();
	console.log("[validate:native-runtime] All checks passed");
}

main();
