import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

interface PackageJson {
  bin?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  files?: string[];
  main?: string;
  module?: string;
  name: string;
  private?: boolean;
  types?: string;
  version: string;
}

interface PackResult {
  filename: string;
  files: Array<{ path: string }>;
  name: string;
  version: string;
}

interface PublishedPackage {
  directory: string;
  manifest: PackageJson;
  tarball?: string;
}

const repositoryRoot = resolve(dirname(import.meta.filename), "..");
const packagesRoot = join(repositoryRoot, "packages");

function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

async function readJson<T>(filePath: string): Promise<T> {
  return JSON.parse(await readFile(filePath, "utf8")) as T;
}

async function run(
  command: string[],
  cwd: string,
): Promise<{ stderr: string; stdout: string }> {
  const child = Bun.spawn(command, {
    cwd,
    env: process.env,
    stderr: "pipe",
    stdout: "pipe",
  });
  const [exitCode, stderr, stdout] = await Promise.all([
    child.exited,
    new Response(child.stderr).text(),
    new Response(child.stdout).text(),
  ]);

  if (exitCode !== 0) {
    const output = [stdout.trim(), stderr.trim()].filter(Boolean).join("\n");
    throw new Error(
      `Command failed (${exitCode}): ${command.join(" ")}\n${output}`,
    );
  }

  return { stderr, stdout };
}

async function discoverPackages(): Promise<PublishedPackage[]> {
  const directories = await readdir(packagesRoot, { withFileTypes: true });
  const packages = await Promise.all(
    directories
      .filter((entry) => entry.isDirectory())
      .map(async (entry) => {
        const directory = join(packagesRoot, entry.name);
        const manifest = await readJson<PackageJson>(
          join(directory, "package.json"),
        );
        return { directory, manifest };
      }),
  );

  return packages
    .filter(({ manifest }) => !manifest.private)
    .sort((left, right) => left.manifest.name.localeCompare(right.manifest.name));
}

function validateSourceManifest(manifest: PackageJson) {
  invariant(manifest.name, "Every publishable package must have a name");
  invariant(manifest.version, `${manifest.name} must have an explicit version`);
  invariant(
    !JSON.stringify(manifest).includes('"workspace:'),
    `${manifest.name} contains a workspace dependency that npm would publish verbatim`,
  );
  invariant(
    manifest.bin?.patchworks,
    `${manifest.name} must publish the patchworks binary`,
  );
}

async function packPackage(
  packageInfo: PublishedPackage,
  tarballDirectory: string,
) {
  const { stdout } = await run(
    [
      "npm",
      "pack",
      "--ignore-scripts",
      "--json",
      "--pack-destination",
      tarballDirectory,
      packageInfo.directory,
    ],
    repositoryRoot,
  );
  const result = (JSON.parse(stdout) as PackResult[])[0];

  invariant(result, `npm pack returned no metadata for ${packageInfo.manifest.name}`);
  invariant(result.name === packageInfo.manifest.name, `Packed unexpected package ${result.name}`);
  invariant(
    result.version === packageInfo.manifest.version,
    `${result.name} packed ${result.version}; expected ${packageInfo.manifest.version}`,
  );

  const packedFiles = new Set(result.files.map(({ path }) => path));
  const requiredFiles = new Set(["LICENSE", "README.md", "package.json"]);
  for (const target of [
    packageInfo.manifest.main,
    packageInfo.manifest.module,
    packageInfo.manifest.types,
    ...Object.values(packageInfo.manifest.bin ?? {}),
  ]) {
    if (target?.startsWith("./")) {
      requiredFiles.add(target.slice(2));
    }
  }
  for (const file of requiredFiles) {
    invariant(
      packedFiles.has(file),
      `${packageInfo.manifest.name} tarball is missing ${file}`,
    );
  }

  const tarball = join(tarballDirectory, result.filename);
  const { stdout: packedManifestText } = await run(
    ["tar", "-xOf", tarball, "package/package.json"],
    repositoryRoot,
  );
  const packedManifest = JSON.parse(packedManifestText) as PackageJson;
  invariant(
    JSON.stringify(packedManifest.dependencies ?? {}) ===
      JSON.stringify(packageInfo.manifest.dependencies ?? {}),
    `${packageInfo.manifest.name} tarball changed dependencies while packing`,
  );

  packageInfo.tarball = tarball;
}

async function verifyConsumer(
  manager: "bun" | "npm",
  directory: string,
  packageInfo: PublishedPackage,
) {
  invariant(packageInfo.tarball, "Package must be packed before verification");
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, "package.json"),
    `${JSON.stringify(
      {
        name: `patchworks-${manager}-artifact-smoke`,
        private: true,
        version: "0.0.0",
        dependencies: {
          patchworks: `file:${packageInfo.tarball}`,
        },
      },
      null,
      2,
    )}\n`,
  );

  const installCommand =
    manager === "npm"
      ? ["npm", "install", "--ignore-scripts", "--no-audit", "--no-fund"]
      : ["bun", "install", "--ignore-scripts"];
  await run(installCommand, directory);

  const executable = join(directory, "node_modules", ".bin", "patchworks");
  const version = await run([executable, "--version"], directory);
  invariant(
    version.stdout.includes(packageInfo.manifest.version),
    `${manager} smoke test returned an unexpected version: ${version.stdout.trim()}`,
  );
  await run([executable, "--help"], directory);
  await run(
    ["node", "--input-type=commonjs", "--eval", "require('patchworks')"],
    directory,
  );
  await run(
    ["node", "--input-type=module", "--eval", "import('patchworks')"],
    directory,
  );
}

async function main() {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "patchworks-package-"));
  const keepTemporaryFiles = process.env.KEEP_PACKAGE_SMOKE_TEMP === "1";

  try {
    const packages = await discoverPackages();
    invariant(packages.length === 1, `Expected one publishable package; found ${packages.length}`);
    const packageInfo = packages[0];
    invariant(packageInfo, "No publishable package was found");
    validateSourceManifest(packageInfo.manifest);

    const tarballDirectory = join(temporaryRoot, "tarballs");
    await mkdir(tarballDirectory);
    await packPackage(packageInfo, tarballDirectory);
    console.log(
      `Packed ${packageInfo.manifest.name}@${packageInfo.manifest.version} (${basename(packageInfo.tarball ?? "")})`,
    );

    for (const manager of ["npm", "bun"] as const) {
      await verifyConsumer(
        manager,
        join(temporaryRoot, `${manager}-consumer`),
        packageInfo,
      );
      console.log(`Verified clean ${manager} install and CLI execution.`);
    }
  } finally {
    if (keepTemporaryFiles) {
      console.log(`Kept package smoke files at ${temporaryRoot}`);
    } else {
      await rm(temporaryRoot, { force: true, recursive: true });
    }
  }
}

await main();
