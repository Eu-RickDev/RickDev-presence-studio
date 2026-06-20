const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createStartupManager } = require("../src/startup");

async function createContext(version = "1.0.4") {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rickdev-startup-"));
  const source = path.join(root, "arquivo-renomeado.exe");
  await fs.writeFile(source, Buffer.from(`portable-${version}`));

  let loginSettings;
  const app = {
    isPackaged: true,
    getVersion: () => version,
    getPath: () => root,
    setLoginItemSettings: (settings) => { loginSettings = settings; },
    getLoginItemSettings: () => ({
      openAtLogin: Boolean(loginSettings?.openAtLogin),
      executableWillLaunchAtLogin: Boolean(loginSettings?.openAtLogin)
    })
  };
  const options = {
    platform: "win32",
    environment: {
      LOCALAPPDATA: root,
      PORTABLE_EXECUTABLE_FILE: source
    },
    executablePath: path.join(root, "app-interno.exe")
  };

  return {
    app,
    manager: createStartupManager(app, options),
    options,
    root,
    source,
    getLoginSettings: () => loginSettings
  };
}

test("cria uma copia gerenciada e registra seu caminho", async (t) => {
  const context = await createContext();
  t.after(() => fs.rm(context.root, { recursive: true, force: true }));

  const result = await context.manager.configure(true);
  const target = context.manager.managedExecutable();

  assert.equal(result.ok, true);
  assert.equal(result.active, true);
  assert.equal(result.managed, true);
  assert.equal(result.updated, true);
  assert.equal(await fs.readFile(target, "utf8"), "portable-1.0.4");
  assert.equal(context.getLoginSettings().path, target);
  assert.deepEqual(context.getLoginSettings().args, ["--hidden"]);
});

test("a copia continua valida depois que o original e movido ou renomeado", async (t) => {
  const context = await createContext();
  t.after(() => fs.rm(context.root, { recursive: true, force: true }));
  await context.manager.configure(true);

  const target = context.manager.managedExecutable();
  await fs.rename(context.source, `${context.source}.movido`);

  const managedManager = createStartupManager(context.app, {
    ...context.options,
    environment: {
      ...context.options.environment,
      PORTABLE_EXECUTABLE_FILE: target
    }
  });
  const result = await managedManager.configure(true);

  assert.equal(result.ok, true);
  assert.equal(result.updated, false);
  assert.equal(context.getLoginSettings().path, target);
});

test("uma versao mais nova substitui a copia anterior", async (t) => {
  const context = await createContext("1.0.4");
  t.after(() => fs.rm(context.root, { recursive: true, force: true }));
  await context.manager.configure(true);

  const newSource = path.join(context.root, "nova-versao.exe");
  await fs.writeFile(newSource, Buffer.from("portable-1.0.5-atualizado"));
  const newApp = { ...context.app, getVersion: () => "1.0.5" };
  const newManager = createStartupManager(newApp, {
    ...context.options,
    environment: {
      ...context.options.environment,
      PORTABLE_EXECUTABLE_FILE: newSource
    }
  });

  const result = await newManager.configure(true);

  assert.equal(result.ok, true);
  assert.equal(result.updated, true);
  assert.equal(await fs.readFile(newManager.managedExecutable(), "utf8"), "portable-1.0.5-atualizado");
});

test("desativar remove a copia quando ela nao esta em execucao", async (t) => {
  const context = await createContext();
  t.after(() => fs.rm(context.root, { recursive: true, force: true }));
  await context.manager.configure(true);

  const target = context.manager.managedExecutable();
  const result = await context.manager.configure(false);

  assert.equal(result.ok, true);
  assert.equal(result.retained, false);
  await assert.rejects(fs.stat(target), { code: "ENOENT" });
  assert.equal(context.getLoginSettings().openAtLogin, false);
});

test("desativar nao tenta apagar o executavel que esta em uso", async (t) => {
  const context = await createContext();
  t.after(() => fs.rm(context.root, { recursive: true, force: true }));
  await context.manager.configure(true);

  const target = context.manager.managedExecutable();
  const managedManager = createStartupManager(context.app, {
    ...context.options,
    environment: {
      ...context.options.environment,
      PORTABLE_EXECUTABLE_FILE: target
    }
  });
  const result = await managedManager.configure(false);

  assert.equal(result.ok, true);
  assert.equal(result.retained, true);
  assert.equal((await fs.stat(target)).isFile(), true);
  assert.equal(context.getLoginSettings().openAtLogin, false);
});

test("nao registra um caminho quando a origem nao existe", async (t) => {
  const context = await createContext();
  t.after(() => fs.rm(context.root, { recursive: true, force: true }));
  await fs.rm(context.source);

  const result = await context.manager.configure(true);

  assert.equal(result.ok, false);
  assert.equal(result.active, false);
  assert.equal(context.getLoginSettings(), undefined);
});

test("a ultima escolha prevalece em alteracoes simultaneas", async (t) => {
  const context = await createContext();
  t.after(() => fs.rm(context.root, { recursive: true, force: true }));

  const enabling = context.manager.configure(true);
  const disabling = context.manager.configure(false);
  const [, disabled] = await Promise.all([enabling, disabling]);

  assert.equal(disabled.ok, true);
  assert.equal(disabled.active, false);
  assert.equal(context.getLoginSettings().openAtLogin, false);
  await assert.rejects(fs.stat(context.manager.managedExecutable()), { code: "ENOENT" });
});
