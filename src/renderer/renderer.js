const form = document.querySelector("#presenceForm");
const mediaTab = document.querySelector("#tabMedia");
const fields = [...document.querySelectorAll("#presenceForm input, #tabMedia input[name]")];
const statusPill = document.querySelector("#statusPill");
const statusText = document.querySelector("#statusText");
const connectButton = document.querySelector("#connectButton");
const disconnectButton = document.querySelector("#disconnectButton");
const profileName = document.querySelector("#profileName");
const profileTabs = [...document.querySelectorAll("#profileTabs button")];
const importProfilesButton = document.querySelector("#importProfilesButton");
const exportProfilesButton = document.querySelector("#exportProfilesButton");
const startWithWindows = document.querySelector("#startWithWindows");
const autoStartPresence = document.querySelector("#autoStartPresence");
const autoReconnect = document.querySelector("#autoReconnect");
const musicCoverLookup = document.querySelector("#musicCoverLookup");
const startupStatus = document.querySelector("#startupStatus");
const updateModal = document.querySelector("#updateModal");
const updateTitle = document.querySelector("#updateTitle");
const updateVersion = document.querySelector("#updateVersion");
const updateNotes = document.querySelector("#updateNotes");
const toast = document.querySelector("#toast");
let saveTimeout;
let timerStartedAt = Date.now();
let connected = false;
let profileStore;
let activeProfile = 0;
let loadingProfile = false;
let applicationPreview;
let applicationLookupTimeout;
let applicationLookupRequest = 0;
let updateUrl = "";
let musicState;
let musicStateAt = 0;

function getConfig() {
  return Object.fromEntries(fields.map((field) => [
    field.name,
    field.type === "checkbox" ? field.checked : field.value
  ]));
}

function setConfig(config) {
  fields.forEach((field) => {
    if (!(field.name in config)) return;
    if (field.type === "checkbox") field.checked = Boolean(config[field.name]);
    else field.value = config[field.name] ?? "";
  });
}

function currentProfile() {
  return profileStore.profiles[activeProfile];
}

function updateCurrentProfile() {
  if (!profileStore || loadingProfile) return;
  currentProfile().config = getConfig();
  currentProfile().name = profileName.value.trim() || `Perfil ${activeProfile + 1}`;
}

function renderProfiles() {
  if (!profileStore) return;
  profileTabs.forEach((button, index) => {
    button.textContent = profileStore.profiles[index].name;
    button.classList.toggle("active", index === activeProfile);
    button.title = profileStore.profiles[index].name;
  });
}

function saveProfiles() {
  if (!profileStore) return Promise.resolve();
  updateCurrentProfile();
  profileStore.activeProfile = activeProfile;
  renderProfiles();
  return window.presenceAPI.saveConfig(profileStore);
}

// Writes any edit still waiting for the debounce, so the file on disk matches
// what is on screen.
function flushProfiles() {
  clearTimeout(saveTimeout);
  saveTimeout = undefined;
  return saveProfiles();
}

function scheduleSave() {
  clearTimeout(saveTimeout);
  saveTimeout = setTimeout(() => {
    saveTimeout = undefined;
    saveProfiles();
  }, 350);
}

function renderGlobalSettings(settings = {}) {
  startWithWindows.checked = Boolean(settings.startWithWindows);
  autoStartPresence.checked = Boolean(settings.autoStartPresence);
  autoReconnect.checked = settings.autoReconnect !== false;
  musicCoverLookup.checked = settings.musicCoverLookup !== false;
}

async function saveGlobalSettings() {
  if (!profileStore) return undefined;
  profileStore.settings = {
    startWithWindows: startWithWindows.checked,
    autoStartPresence: autoStartPresence.checked,
    autoReconnect: autoReconnect.checked,
    musicCoverLookup: musicCoverLookup.checked,
    musicIgnoredApps: profileStore.settings?.musicIgnoredApps || []
  };
  clearTimeout(saveTimeout);
  saveTimeout = undefined;
  const result = await saveProfiles();
  if (result?.settings) profileStore.settings = { ...result.settings };
  renderStartupStatus(result?.startupStatus);
  renderMusicSources();
  return result?.startupStatus;
}

function renderStartupStatus(status) {
  startupStatus.className = "startup-status";
  startupStatus.textContent = "";
  if (!status) return;

  if (!status.ok) {
    startupStatus.textContent = status.error;
    startupStatus.classList.add("visible", "error");
    return;
  }

  if (status.development && startWithWindows.checked) {
    startupStatus.textContent = "A configuração será aplicada ao executar a versão compilada.";
  } else if (status.active && status.managed) {
    startupStatus.textContent = status.updated
      ? "Cópia de inicialização criada ou atualizada com sucesso."
      : "Inicialização protegida pela cópia gerenciada no LocalAppData.";
  } else if (status.retained) {
    startupStatus.textContent = "Inicialização desativada. A cópia em uso foi mantida e não será aberta pelo Windows.";
  }

  if (startupStatus.textContent) startupStatus.classList.add("visible");
}

function showActiveProfile() {
  loadingProfile = true;
  profileName.value = currentProfile().name;
  setConfig(currentProfile().config);
  loadingProfile = false;
  renderProfiles();
  renderPreview();
  scheduleApplicationLookup(currentProfile().config.clientId, true);
  window.presenceAPI.watchMusic(Boolean(currentProfile().config.musicMode));
}

function loadProfile(index) {
  if (!profileStore) return;
  updateCurrentProfile();
  activeProfile = index;
  profileStore.activeProfile = index;
  showActiveProfile();
  flushProfiles();
}

// Replaces everything on screen with a store that came from the main process
// (startup or an import).
function applyStore(store) {
  clearTimeout(saveTimeout);
  saveTimeout = undefined;
  profileStore = store;
  activeProfile = store.activeProfile;
  renderGlobalSettings(store.settings);
  renderStartupStatus(store.startupStatus);
  showActiveProfile();
  renderMusicSources();
}

function display(value, fallback) {
  return value.trim() || fallback;
}

function setPreviewImage(containerId, imageId, url, alt) {
  const container = document.querySelector(containerId);
  const image = document.querySelector(imageId);
  container.classList.toggle("has-image", Boolean(url));
  const next = url || "";
  // Reassigning the same src restarts animated GIFs on every re-render.
  if ((image.getAttribute("src") ?? "") !== next) image.src = next;
  image.alt = url ? alt : "";
}

async function lookupApplication(clientId) {
  const request = ++applicationLookupRequest;
  applicationPreview = undefined;
  renderPreview();

  try {
    const result = await window.presenceAPI.lookupApplication(clientId);
    if (request !== applicationLookupRequest) return;
    applicationPreview = result;
  } catch {
    if (request !== applicationLookupRequest) return;
    applicationPreview = { id: clientId, unavailable: true };
  }

  renderPreview();
}

function scheduleApplicationLookup(clientId, immediate = false) {
  clearTimeout(applicationLookupTimeout);
  const normalizedId = clientId.trim();

  if (!/^\d{17,20}$/.test(normalizedId)) {
    applicationLookupRequest += 1;
    applicationPreview = undefined;
    renderPreview();
    return;
  }

  if (applicationPreview?.id === normalizedId) return;
  applicationLookupTimeout = setTimeout(
    () => lookupApplication(normalizedId),
    immediate ? 0 : 500
  );
}

function normalizeUrl(value) {
  const trimmed = value.trim();
  if (!trimmed) return "";
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

function getButtonError(config) {
  const pairs = [
    [config.button1Label.trim(), config.button1Url.trim(), "Botão 1"],
    [config.button2Label.trim(), config.button2Url.trim(), "Botão 2"]
  ];

  for (const [label, url, name] of pairs) {
    if ((label && !url) || (!label && url)) return `${name}: preencha o texto e a URL.`;
    if (url) {
      try {
        new URL(normalizeUrl(url));
      } catch {
        return `${name}: informe uma URL válida.`;
      }
    }
  }

  return "";
}

function currentMusic(config) {
  if (!config.musicMode || musicState?.presentation?.mode !== "music" || !musicState.media) return undefined;
  return musicState.media;
}

function sourceLabel(app) {
  const base = app.replace(/\.exe$/i, "");
  return base.charAt(0).toUpperCase() + base.slice(1);
}

function renderMusicSources() {
  const container = document.querySelector("#musicSources");
  const ignoredApps = profileStore?.settings?.musicIgnoredApps || [];
  const detected = musicState?.sources || [];

  const rows = detected.map((source) => ({ ...source, detected: true }));
  for (const app of ignoredApps) {
    if (!detected.some((source) => source.app.toLowerCase() === app)) {
      rows.push({ app, title: "", playing: false, ignored: true, detected: false });
    }
  }

  // Skip identical re-renders so a button never disappears mid-click.
  const signature = JSON.stringify([rows, Boolean(musicState?.watching)]);
  if (renderMusicSources.signature === signature) return;
  renderMusicSources.signature = signature;

  if (!rows.length) {
    const empty = document.createElement("p");
    empty.className = "music-sources-empty";
    empty.textContent = musicState?.watching
      ? "Nenhuma mídia detectada agora. Dê play em algo para a fonte aparecer aqui."
      : "Ative o modo de mídia para detectar as fontes.";
    container.replaceChildren(empty);
    return;
  }

  container.replaceChildren(...rows.map((row) => {
    const item = document.createElement("div");
    item.className = `music-source${row.ignored ? " ignored" : ""}`;

    const info = document.createElement("div");
    const name = document.createElement("strong");
    name.textContent = sourceLabel(row.app);
    const detail = document.createElement("span");
    detail.textContent = !row.detected
      ? "Bloqueada (sem mídia agora)"
      : row.ignored
        ? "Bloqueada"
        : `${row.playing ? "Tocando" : "Em pausa"}${row.title ? ` - ${row.title}` : ""}`;
    info.append(name, detail);

    const action = document.createElement("button");
    action.type = "button";
    action.className = "ghost-button";
    action.textContent = row.ignored ? "Desbloquear" : "Bloquear";
    action.dataset.app = row.app;
    action.dataset.ignore = row.ignored ? "0" : "1";

    item.append(info, action);
    return item;
  }));
}

async function toggleIgnoredSource(app, ignore) {
  if (!profileStore) return;
  const list = new Set(profileStore.settings?.musicIgnoredApps || []);
  if (ignore) list.add(app.toLowerCase());
  else list.delete(app.toLowerCase());
  profileStore.settings.musicIgnoredApps = [...list];
  renderMusicSources.signature = undefined;
  await saveGlobalSettings();
  showToast(ignore
    ? `${sourceLabel(app)} bloqueado no modo de mídia.`
    : `${sourceLabel(app)} desbloqueado.`);
}

function formatTime(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function renderMusicProgress() {
  const config = getConfig();
  const music = currentMusic(config);
  const progress = document.querySelector("#musicProgress");

  if (!music || musicState.presentation.paused || !music.playing || !music.durationMs) {
    progress.classList.remove("visible");
    return;
  }

  const position = Math.min(music.positionMs + (Date.now() - musicStateAt), music.durationMs);
  document.querySelector("#musicProgressFill").style.width =
    `${Math.min(100, (position / music.durationMs) * 100).toFixed(2)}%`;
  document.querySelector("#musicElapsed").textContent = formatTime(position);
  document.querySelector("#musicDuration").textContent = formatTime(music.durationMs);
  progress.classList.add("visible");
}

function renderPreview() {
  const config = getConfig();
  const matchingApplication = applicationPreview?.id === config.clientId.trim()
    ? applicationPreview
    : undefined;
  const music = currentMusic(config);
  const musicPaused = Boolean(music && musicState.presentation.paused);
  const largeImageUrl = music?.artUrl
    || matchingApplication?.assets?.[config.largeImageKey.trim()]
    || (!config.largeImageKey.trim() ? matchingApplication?.iconUrl : "");
  const smallImageUrl = matchingApplication?.assets?.[config.smallImageKey.trim()] || "";

  document.querySelector("#previewMode").textContent = music ? "OUVINDO" : "JOGANDO";
  document.querySelector("#previewApp").textContent = matchingApplication?.name
    || (config.clientId ? `App ${config.clientId.slice(0, 8)}` : "Seu aplicativo");
  document.querySelector("#previewDetails").textContent = music
    ? music.title
    : display(config.details, "Sem detalhes");
  document.querySelector("#previewState").textContent = music
    ? (musicPaused ? (music.artist ? `Em pausa - ${music.artist}` : "Em pausa") : music.artist)
    : display(config.state, "Sem estado");
  document.querySelector("#largeAssetFallback").textContent = music
    ? music.title.slice(0, 1).toUpperCase()
    : config.largeImageKey
      ? config.largeImageKey.slice(0, 2).toUpperCase()
      : matchingApplication?.name?.slice(0, 1).toUpperCase() || "R";
  setPreviewImage("#largeAsset", "#largeAssetImage", largeImageUrl, "Imagem grande da presence");
  document.querySelector("#smallAsset").style.display = config.smallImageKey ? "grid" : "none";
  setPreviewImage("#smallAsset", "#smallAssetImage", smallImageUrl, "Imagem pequena da presence");
  document.querySelector("#previewTimer").style.display = !music && config.showTimer ? "block" : "none";

  const hint = document.querySelector("#musicHint");
  if (config.musicMode && musicState?.error) {
    hint.textContent = musicState.error;
  } else if (config.musicMode && !music) {
    hint.textContent = "Sem mídia em reprodução - mostrando a presence configurada.";
  } else {
    hint.textContent = "";
  }
  hint.style.display = hint.textContent ? "block" : "none";

  renderMusicProgress();
  renderPreviewButtons(config);
}

function renderPreviewButtons(config) {
  const buttons = [
    { label: config.button1Label, url: config.button1Url },
    { label: config.button2Label, url: config.button2Url }
  ].filter((button) => button.label.trim());

  // Skip identical re-renders: replacing the nodes mid-press would swallow
  // the click, and music state refreshes re-render the preview repeatedly.
  const signature = JSON.stringify(buttons);
  if (renderPreviewButtons.signature === signature) return;
  renderPreviewButtons.signature = signature;

  document.querySelector("#previewButtons").replaceChildren(...buttons.map((button) => {
    const element = document.createElement("button");
    element.type = "button";
    element.textContent = button.label;
    element.dataset.url = normalizeUrl(button.url);
    element.disabled = !button.url.trim();
    return element;
  }));
}

// "connected" comes from the main process: an error while the presence is
// still live (a failed refresh, a media watcher issue) keeps it true.
function setStatus({ status, message, startedAt, connected: isConnected }) {
  connected = typeof isConnected === "boolean" ? isConnected : status === "online";
  if (connected && Number.isFinite(startedAt)) timerStartedAt = startedAt;
  statusPill.className = `connection-pill ${status}`;
  statusText.textContent = message;
  connectButton.querySelector("span").textContent = connected ? "Atualizar presence" : "Ativar presence";
}

function showToast(message, duration = 2800) {
  toast.textContent = message;
  toast.classList.add("visible");
  clearTimeout(showToast.timeout);
  showToast.timeout = setTimeout(() => toast.classList.remove("visible"), duration);
}

function cleanReleaseText(value) {
  return value
    .replace(/\*\*/g, "")
    .replace(/`/g, "")
    .replace(/\[([^\]]+)]\([^)]+\)/g, "$1");
}

function renderReleaseNotes(notes) {
  updateNotes.replaceChildren();
  const fragment = document.createDocumentFragment();
  let list;

  for (const rawLine of notes.replace(/\r/g, "").split("\n")) {
    const line = rawLine.trim();
    if (!line) {
      list = undefined;
      continue;
    }

    let element;
    if (line.startsWith("### ")) {
      element = document.createElement("h4");
      element.textContent = cleanReleaseText(line.slice(4));
      list = undefined;
    } else if (line.startsWith("## ")) {
      element = document.createElement("h3");
      element.textContent = cleanReleaseText(line.slice(3));
      list = undefined;
    } else if (line.startsWith("# ")) {
      element = document.createElement("h3");
      element.textContent = cleanReleaseText(line.slice(2));
      list = undefined;
    } else if (line.startsWith("- ")) {
      if (!list) {
        list = document.createElement("ul");
        fragment.append(list);
      }
      element = document.createElement("li");
      element.textContent = cleanReleaseText(line.slice(2));
    } else {
      element = document.createElement("p");
      element.textContent = cleanReleaseText(line);
      list = undefined;
    }

    if (element.tagName !== "LI") fragment.append(element);
    else list.append(element);
  }

  updateNotes.append(fragment);
}

function showUpdate(update) {
  updateUrl = update.url;
  updateTitle.textContent = update.name;
  updateVersion.textContent = `${update.currentVersion}  >  ${update.version}`;
  renderReleaseNotes(update.notes);
  updateModal.classList.add("visible");
  updateModal.setAttribute("aria-hidden", "false");
  document.body.classList.add("update-open");
  document.querySelector("#updateOpenButton").focus();
}

function closeUpdate() {
  updateModal.classList.remove("visible");
  updateModal.setAttribute("aria-hidden", "true");
  document.body.classList.remove("update-open");
}

async function submitPresence() {
  const config = getConfig();
  if (!config.clientId.trim()) {
    document.querySelector("#clientId").focus();
    showToast("Informe o Application ID para conectar.");
    return;
  }

  const buttonError = getButtonError(config);
  if (buttonError) {
    showToast(buttonError);
    return;
  }

  const wasConnected = connected;
  connectButton.disabled = true;
  try {
    await flushProfiles();
    const result = await window.presenceAPI.connect(config);
    if (!result?.ok) showToast(result?.error || "Não foi possível ativar a presence.", 4500);
    else showToast(wasConnected ? "Presence atualizada." : "Presence ativada.");
  } catch (error) {
    showToast(error?.message || "Não foi possível ativar a presence.", 4500);
  } finally {
    connectButton.disabled = false;
  }
}

async function exportProfiles() {
  if (!profileStore) return;
  exportProfilesButton.disabled = true;
  try {
    await flushProfiles();
    const result = await window.presenceAPI.exportProfiles();
    if (result?.ok) showToast("Perfis exportados.");
    else if (!result?.canceled) showToast(result?.error || "Não foi possível exportar os perfis.", 4500);
  } catch (error) {
    showToast(error?.message || "Não foi possível exportar os perfis.", 4500);
  } finally {
    exportProfilesButton.disabled = false;
  }
}

async function importProfiles() {
  if (!profileStore) return;
  importProfilesButton.disabled = true;
  try {
    await flushProfiles();
    const result = await window.presenceAPI.importProfiles();
    if (result?.ok) {
      applyStore(result.store);
      showToast(result.count === 1 ? "1 perfil importado." : `${result.count} perfis importados.`);
    } else if (!result?.canceled) {
      showToast(result?.error || "Não foi possível importar os perfis.", 4500);
    }
  } catch (error) {
    showToast(error?.message || "Não foi possível importar os perfis.", 4500);
  } finally {
    importProfilesButton.disabled = false;
  }
}

function handleConfigInput(event) {
  // Only named inputs belong to the profile; global toggles save themselves.
  if (!(event.target instanceof HTMLInputElement) || !event.target.name) return;
  renderPreview();
  if (event.target.name === "clientId") scheduleApplicationLookup(event.target.value);
  if (event.target.name === "musicMode") {
    window.presenceAPI.watchMusic(event.target.checked);
    if (connected) showToast("Clique em Atualizar presence para aplicar a mudança.");
  }
  updateCurrentProfile();
  scheduleSave();
}

form.addEventListener("input", handleConfigInput);
mediaTab.addEventListener("input", handleConfigInput);

const editorTabs = [...document.querySelectorAll("#editorTabs button")];
editorTabs.forEach((button) => {
  button.addEventListener("click", () => {
    editorTabs.forEach((tab) => tab.classList.toggle("active", tab === button));
    document.querySelector("#tabPresence").hidden = button.dataset.tab !== "presence";
    mediaTab.hidden = button.dataset.tab !== "media";
  });
});

profileName.addEventListener("input", () => {
  updateCurrentProfile();
  renderProfiles();
  scheduleSave();
});

startWithWindows.addEventListener("change", async () => {
  const status = await saveGlobalSettings();
  if (!status?.ok) {
    showToast(status?.error || "Não foi possível configurar a inicialização.", 4500);
    return;
  }
  showToast(status.development
    ? "Preferência salva para a versão compilada."
    : startWithWindows.checked
      ? "Inicialização protegida configurada."
      : "Inicialização com o Windows desativada.");
});

autoStartPresence.addEventListener("change", async () => {
  await saveGlobalSettings();
  showToast(autoStartPresence.checked
    ? "Autoativação preparada para a próxima abertura."
    : "Autoativação desativada.");
});

autoReconnect.addEventListener("change", async () => {
  await saveGlobalSettings();
  showToast(autoReconnect.checked
    ? "Reconexão automática ativada."
    : "Reconexão automática desativada.");
});

musicCoverLookup.addEventListener("change", async () => {
  await saveGlobalSettings();
  showToast(musicCoverLookup.checked
    ? "A capa do álbum será buscada no iTunes."
    : "Busca de capa desativada. Nada é enviado ao iTunes.");
});

profileTabs.forEach((button) => {
  button.addEventListener("click", () => {
    const nextProfile = Number(button.dataset.profile);
    if (nextProfile === activeProfile) return;
    loadProfile(nextProfile);
    showToast(`${currentProfile().name} carregado.`);
  });
});

importProfilesButton.addEventListener("click", importProfiles);
exportProfilesButton.addEventListener("click", exportProfiles);
connectButton.addEventListener("click", submitPresence);

document.querySelector("#previewButtons").addEventListener("click", (event) => {
  const button = event.target.closest("button[data-url]");
  if (!button?.dataset.url) return;
  window.presenceAPI.openLink(button.dataset.url).catch(() => showToast("Link não permitido."));
});

disconnectButton.addEventListener("click", async () => {
  await window.presenceAPI.disconnect();
  showToast("Presence desconectada.");
});

document.querySelector("#resetButton").addEventListener("click", () => {
  fields.forEach((field) => {
    if (field.type === "checkbox") field.checked = field.name === "showTimer";
    else if (field.name !== "clientId") field.value = "";
  });
  window.presenceAPI.watchMusic(false);
  renderPreview();
  flushProfiles();
  showToast("Campos limpos.");
});

document.querySelector("#portalLink").addEventListener("click", (event) => {
  event.preventDefault();
  window.presenceAPI.openLink("https://discord.com/developers/applications");
});

document.querySelector("#updateCloseButton").addEventListener("click", closeUpdate);
document.querySelector("#updateLaterButton").addEventListener("click", closeUpdate);
document.querySelector("#updateOpenButton").addEventListener("click", () => {
  if (updateUrl) window.presenceAPI.openLink(updateUrl);
  closeUpdate();
});

updateModal.addEventListener("click", (event) => {
  if (event.target === updateModal) closeUpdate();
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && updateModal.classList.contains("visible")) closeUpdate();
});

window.presenceAPI.onStatus(setStatus);
window.presenceAPI.onMusicState((data) => {
  musicState = data;
  musicStateAt = Date.now();
  renderPreview();
  renderMusicSources();
});

document.querySelector("#musicSources").addEventListener("click", (event) => {
  const button = event.target.closest("button[data-app]");
  if (!button) return;
  toggleIgnoredSource(button.dataset.app, button.dataset.ignore === "1");
});
window.presenceAPI.onUpdateAvailable(showUpdate);

setInterval(() => {
  const elapsed = Math.floor((Date.now() - timerStartedAt) / 1000);
  const hours = Math.floor(elapsed / 3600);
  const minutes = Math.floor((elapsed % 3600) / 60);
  const seconds = elapsed % 60;
  document.querySelector("#previewTimer").textContent =
    `${hours ? `${String(hours).padStart(2, "0")}:` : ""}${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")} decorrido`;
  renderMusicProgress();
}, 1000);

window.presenceAPI.loadConfig().then((store) => {
  applyStore(store);
  if (store.presenceStatus) setStatus(store.presenceStatus);
  if (store.corruptedBackup) {
    showToast("O arquivo de configuração estava corrompido e foi guardado como cópia. Os perfis voltaram ao padrão.", 8000);
  }
});
