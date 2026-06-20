const form = document.querySelector("#presenceForm");
const fields = [...form.querySelectorAll("input")];
const statusPill = document.querySelector("#statusPill");
const statusText = document.querySelector("#statusText");
const connectButton = document.querySelector("#connectButton");
const disconnectButton = document.querySelector("#disconnectButton");
const profileName = document.querySelector("#profileName");
const profileTabs = [...document.querySelectorAll("#profileTabs button")];
const startWithWindows = document.querySelector("#startWithWindows");
const autoStartPresence = document.querySelector("#autoStartPresence");
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

async function saveGlobalSettings() {
  if (!profileStore) return;
  profileStore.settings = {
    startWithWindows: startWithWindows.checked,
    autoStartPresence: autoStartPresence.checked
  };
  await saveProfiles();
}

function loadProfile(index) {
  if (!profileStore) return;
  updateCurrentProfile();
  activeProfile = index;
  profileStore.activeProfile = index;
  loadingProfile = true;
  profileName.value = currentProfile().name;
  setConfig(currentProfile().config);
  loadingProfile = false;
  renderProfiles();
  renderPreview();
  scheduleApplicationLookup(currentProfile().config.clientId, true);
  window.presenceAPI.saveConfig(profileStore);
}

function display(value, fallback) {
  return value.trim() || fallback;
}

function setPreviewImage(containerId, imageId, url, alt) {
  const container = document.querySelector(containerId);
  const image = document.querySelector(imageId);
  container.classList.toggle("has-image", Boolean(url));
  image.src = url || "";
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
    [config.button1Label.trim(), config.button1Url.trim(), "Botao 1"],
    [config.button2Label.trim(), config.button2Url.trim(), "Botao 2"]
  ];

  for (const [label, url, name] of pairs) {
    if ((label && !url) || (!label && url)) return `${name}: preencha o texto e a URL.`;
    if (url) {
      try {
        new URL(normalizeUrl(url));
      } catch {
        return `${name}: informe uma URL valida.`;
      }
    }
  }

  return "";
}

function renderPreview() {
  const config = getConfig();
  const matchingApplication = applicationPreview?.id === config.clientId.trim()
    ? applicationPreview
    : undefined;
  const largeImageUrl = matchingApplication?.assets?.[config.largeImageKey.trim()]
    || (!config.largeImageKey.trim() ? matchingApplication?.iconUrl : "");
  const smallImageUrl = matchingApplication?.assets?.[config.smallImageKey.trim()] || "";

  document.querySelector("#previewApp").textContent = matchingApplication?.name
    || (config.clientId ? `App ${config.clientId.slice(0, 8)}` : "Seu aplicativo");
  document.querySelector("#previewDetails").textContent = display(config.details, "Sem detalhes");
  document.querySelector("#previewState").textContent = display(config.state, "Sem estado");
  document.querySelector("#largeAssetFallback").textContent = config.largeImageKey
    ? config.largeImageKey.slice(0, 2).toUpperCase()
    : matchingApplication?.name?.slice(0, 1).toUpperCase() || "R";
  setPreviewImage("#largeAsset", "#largeAssetImage", largeImageUrl, "Imagem grande da presence");
  document.querySelector("#smallAsset").style.display = config.smallImageKey ? "grid" : "none";
  setPreviewImage("#smallAsset", "#smallAssetImage", smallImageUrl, "Imagem pequena da presence");
  document.querySelector("#previewTimer").style.display = config.showTimer ? "block" : "none";

  const buttons = [
    { label: config.button1Label, url: config.button1Url },
    { label: config.button2Label, url: config.button2Url }
  ].filter((button) => button.label.trim());

  document.querySelector("#previewButtons").innerHTML = buttons
    .map((button) => `<button type="button" data-url="${escapeHtml(normalizeUrl(button.url))}" ${button.url.trim() ? "" : "disabled"}>${escapeHtml(button.label)}</button>`)
    .join("");
}

function escapeHtml(value) {
  const element = document.createElement("span");
  element.textContent = value;
  return element.innerHTML;
}

function setStatus(status, message, startedAt) {
  connected = status === "online";
  if (connected && Number.isFinite(startedAt)) timerStartedAt = startedAt;
  statusPill.className = `connection-pill ${status}`;
  statusText.textContent = message;
  connectButton.querySelector("span").textContent = connected ? "Atualizar presence" : "Ativar presence";
}

function showToast(message) {
  toast.textContent = message;
  toast.classList.add("visible");
  clearTimeout(showToast.timeout);
  showToast.timeout = setTimeout(() => toast.classList.remove("visible"), 2800);
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
  await saveProfiles();
  const result = await window.presenceAPI.connect(config);
  connectButton.disabled = false;
  if (!result.ok) showToast(result.error || "Nao foi possivel ativar a presence.");
  else {
    showToast(wasConnected ? "Presence atualizada." : "Presence ativada.");
  }
}

form.addEventListener("input", (event) => {
  renderPreview();
  if (event.target.name === "clientId") scheduleApplicationLookup(event.target.value);
  updateCurrentProfile();
  clearTimeout(saveTimeout);
  saveTimeout = setTimeout(saveProfiles, 350);
});

profileName.addEventListener("input", () => {
  updateCurrentProfile();
  renderProfiles();
  clearTimeout(saveTimeout);
  saveTimeout = setTimeout(saveProfiles, 350);
});

startWithWindows.addEventListener("change", async () => {
  await saveGlobalSettings();
  showToast(startWithWindows.checked
    ? "O Studio iniciara minimizado com o Windows."
    : "Inicializacao com o Windows desativada.");
});

autoStartPresence.addEventListener("change", async () => {
  await saveGlobalSettings();
  showToast(autoStartPresence.checked
    ? "Autoativacao preparada para a proxima abertura."
    : "Autoativacao desativada.");
});

profileTabs.forEach((button) => {
  button.addEventListener("click", () => {
    const nextProfile = Number(button.dataset.profile);
    if (nextProfile === activeProfile) return;
    loadProfile(nextProfile);
    showToast(`${currentProfile().name} carregado.`);
  });
});

connectButton.addEventListener("click", submitPresence);

document.querySelector("#previewButtons").addEventListener("click", (event) => {
  const button = event.target.closest("button[data-url]");
  if (!button?.dataset.url) return;
  window.presenceAPI.openLink(button.dataset.url);
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
  renderPreview();
  saveProfiles();
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

window.presenceAPI.onStatus(({ status, message, startedAt }) => setStatus(status, message, startedAt));
window.presenceAPI.onUpdateAvailable(showUpdate);

setInterval(() => {
  const elapsed = Math.floor((Date.now() - timerStartedAt) / 1000);
  const hours = Math.floor(elapsed / 3600);
  const minutes = Math.floor((elapsed % 3600) / 60);
  const seconds = elapsed % 60;
  document.querySelector("#previewTimer").textContent =
    `${hours ? `${String(hours).padStart(2, "0")}:` : ""}${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")} decorrido`;
}, 1000);

window.presenceAPI.loadConfig().then((store) => {
  profileStore = store;
  activeProfile = store.activeProfile;
  startWithWindows.checked = Boolean(store.settings?.startWithWindows);
  autoStartPresence.checked = Boolean(store.settings?.autoStartPresence);
  loadingProfile = true;
  profileName.value = currentProfile().name;
  setConfig(currentProfile().config);
  loadingProfile = false;
  renderProfiles();
  renderPreview();
  scheduleApplicationLookup(currentProfile().config.clientId, true);
});
