const path = require("path");

const builderLib = path.dirname(require.resolve("app-builder-lib/package.json"));
const fsExtra = require(require.resolve("fs-extra", { paths: [builderLib] }));
const stockLauncher = path.join(builderLib, "templates", "nsis", "portable.nsi");
const customLauncher = path.join(__dirname, "..", "build", "portable.nsi");

let launcherReplaced = false;
const readFile = fsExtra.readFile;
fsExtra.readFile = function (file, ...rest) {
  if (typeof file === "string" && path.resolve(file) === stockLauncher) {
    launcherReplaced = true;
    return readFile.call(this, customLauncher, ...rest);
  }
  return readFile.call(this, file, ...rest);
};

process.on("exit", (code) => {
  if (code === 0 && process.argv.includes("portable") && !launcherReplaced) {
    console.error("O lançador do portátil não foi trocado: o electron-builder deixou de ler templates/nsis/portable.nsi.");
    process.exitCode = 1;
  }
});

require("electron-builder/out/cli/cli");
