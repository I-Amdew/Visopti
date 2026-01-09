import { mkdir, rm, readdir, copyFile } from "node:fs/promises";
import path from "node:path";

const srcDir = path.resolve("Assets");
const publicDir = path.resolve("public");
const destDir = path.join(publicDir, "Assets");

async function ensureExists(directory) {
  await mkdir(directory, { recursive: true });
}

async function copyDirectory(src, dest) {
  await ensureExists(dest);
  const entries = await readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      await copyDirectory(srcPath, destPath);
    } else if (entry.isFile()) {
      await copyFile(srcPath, destPath);
    }
  }
}

async function main() {
  try {
    await ensureExists(publicDir);
    await rm(destDir, { recursive: true, force: true });
    await ensureExists(destDir);
    await copyDirectory(srcDir, destDir);
    console.log(`[sync-assets] Copied assets to ${destDir}`);
  } catch (err) {
    console.error("[sync-assets] Failed to copy Assets", err);
    process.exitCode = 1;
  }
}

main();
