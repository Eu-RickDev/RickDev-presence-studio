const fs = require("fs");
const path = require("path");

const APP_NAME = "RickDev Presence Studio";
const EXECUTABLE_NAME = `${APP_NAME}.exe`;
const MANIFEST_NAME = "managed-startup.json";

function samePath(left, right) {
  if (!left || !right) return false;
  return path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase();
}

function createStartupManager(app, options = {}) {
  const platform = options.platform || process.platform;
  const environment = options.environment || process.env;
  const executablePath = options.executablePath || process.execPath;
  const fileSystem = options.fileSystem || fs.promises;
  let operationQueue = Promise.resolve();

  function directory() {
    const localAppData = environment.LOCALAPPDATA || app.getPath("userData");
    return path.join(localAppData, APP_NAME);
  }

  function managedExecutable() {
    return path.join(directory(), EXECUTABLE_NAME);
  }

  function manifestPath() {
    return path.join(directory(), MANIFEST_NAME);
  }

  function portableSource() {
    return environment.PORTABLE_EXECUTABLE_FILE || "";
  }

  async function readManifest() {
    try {
      return JSON.parse(await fileSystem.readFile(manifestPath(), "utf8"));
    } catch {
      return undefined;
    }
  }

  async function writeManifest(size) {
    const target = manifestPath();
    const temporary = `${target}.new-${process.pid}`;
    const manifest = {
      version: app.getVersion(),
      size,
      updatedAt: new Date().toISOString()
    };

    await fileSystem.writeFile(temporary, JSON.stringify(manifest, null, 2), "utf8");
    await fileSystem.rm(target, { force: true });
    await fileSystem.rename(temporary, target);
  }

  async function ensureManagedExecutable() {
    const source = portableSource();
    if (!source) {
      return { path: executablePath, managed: false, updated: false };
    }

    const target = managedExecutable();
    await fileSystem.mkdir(directory(), { recursive: true });

    if (samePath(source, target)) {
      const stat = await fileSystem.stat(target);
      const manifest = await readManifest();
      if (manifest?.version !== app.getVersion() || manifest?.size !== stat.size) {
        await writeManifest(stat.size);
      }
      return { path: target, managed: true, updated: false };
    }

    const sourceStat = await fileSystem.stat(source);
    if (!sourceStat.isFile() || sourceStat.size === 0) {
      throw new Error("O executavel portatil atual nao e valido.");
    }

    let targetStat;
    try {
      targetStat = await fileSystem.stat(target);
    } catch {
      targetStat = undefined;
    }
    const manifest = await readManifest();
    if (targetStat?.isFile()
      && manifest?.version === app.getVersion()
      && manifest?.size === targetStat.size) {
      return { path: target, managed: true, updated: false };
    }

    const temporary = `${target}.new-${process.pid}`;
    try {
      await fileSystem.rm(temporary, { force: true });
      await fileSystem.copyFile(source, temporary);
      const copiedStat = await fileSystem.stat(temporary);
      if (copiedStat.size !== sourceStat.size) {
        throw new Error("A copia gerenciada ficou incompleta.");
      }

      await fileSystem.rm(target, { force: true });
      await fileSystem.rename(temporary, target);
      await writeManifest(copiedStat.size);
      return { path: target, managed: true, updated: true };
    } catch (error) {
      await fileSystem.rm(temporary, { force: true }).catch(() => {});
      if (["EBUSY", "EPERM", "EACCES"].includes(error.code)) {
        throw new Error("A copia de inicializacao esta em uso. Encerre o Studio e abra esta versao novamente.");
      }
      throw error;
    }
  }

  function setLoginItem(enabled, target) {
    const args = ["--hidden"];
    app.setLoginItemSettings({
      openAtLogin: enabled,
      enabled,
      path: target,
      args,
      name: APP_NAME
    });

    if (!enabled) return;
    const state = app.getLoginItemSettings({ path: target, args });
    if (!state.openAtLogin && !state.executableWillLaunchAtLogin) {
      throw new Error("O Windows nao confirmou o registro de inicializacao.");
    }
  }

  async function removeManagedExecutable() {
    const target = managedExecutable();
    if (samePath(portableSource(), target)) return { retained: true };

    await fileSystem.rm(target, { force: true });
    await fileSystem.rm(manifestPath(), { force: true });
    try {
      await fileSystem.rmdir(directory());
    } catch {
      // Keep the directory if another harmless file still exists.
    }
    return { retained: false };
  }

  async function configureNow(enabled) {
    if (platform !== "win32" || !app.isPackaged) {
      return { ok: true, active: false, development: true };
    }

    try {
      if (!enabled) {
        setLoginItem(false, managedExecutable());
        const cleanup = await removeManagedExecutable();
        return { ok: true, active: false, ...cleanup };
      }

      const managed = await ensureManagedExecutable();
      setLoginItem(true, managed.path);
      return { ok: true, active: true, ...managed };
    } catch (error) {
      return {
        ok: false,
        active: false,
        error: error.message || "Nao foi possivel configurar a inicializacao com o Windows."
      };
    }
  }

  function configure(enabled) {
    const operation = operationQueue.then(() => configureNow(enabled));
    operationQueue = operation.then(() => undefined, () => undefined);
    return operation;
  }

  return {
    configure,
    directory,
    managedExecutable,
    samePath
  };
}

module.exports = { createStartupManager, samePath };
