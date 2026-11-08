const { presenceText } = require("./media");

const MAX_UNIX_TIMESTAMP_MS = 2147483647000;
const ACTIVITY_TYPES = Object.freeze({ playing: 0, listening: 2, watching: 3, competing: 5 });
const ROTATION_INTERVALS = Object.freeze([15, 30, 60, 120, 300]);
const DEFAULT_ROTATION_SECONDS = 30;
const ROTATION_SLOTS = [2, 3, 4];

function normalizeUrl(value) {
  const trimmed = String(value || "").trim();
  if (!trimmed) return "";
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

function buildButtons(config) {
  return [
    { label: config.button1Label.trim(), url: normalizeUrl(config.button1Url) },
    { label: config.button2Label.trim(), url: normalizeUrl(config.button2Url) }
  ].filter((button) => button.label && button.url);
}

function validateButtons(config) {
  const pairs = [
    [config.button1Label.trim(), config.button1Url.trim(), "Botão 1"],
    [config.button2Label.trim(), config.button2Url.trim(), "Botão 2"]
  ];

  for (const [label, url, name] of pairs) {
    if ((label && !url) || (!label && url)) {
      throw new Error(`${name}: preencha o texto e a URL.`);
    }

    if (label && label.length > 32) {
      throw new Error(`${name}: o texto deve ter no máximo 32 caracteres.`);
    }

    if (url) {
      try {
        new URL(normalizeUrl(url));
      } catch {
        throw new Error(`${name}: informe uma URL válida.`);
      }
    }
  }
}

function isImageUrl(value) {
  return /^https?:\/\//i.test(String(value || "").trim());
}

function validateImage(value, name) {
  const image = String(value || "").trim();
  if (!isImageUrl(image)) return;

  let parsed;
  try {
    parsed = new URL(image);
  } catch {
    throw new Error(`${name}: informe um link de imagem válido.`);
  }
  if (parsed.protocol !== "https:") {
    throw new Error(`${name}: o link da imagem precisa começar com https://.`);
  }
}

function textVariants(config) {
  const variants = [{ details: String(config.details || ""), state: String(config.state || ""), slot: 1 }];
  if (!config.rotateTexts) return variants;

  for (const slot of ROTATION_SLOTS) {
    const details = String(config[`details${slot}`] || "");
    const state = String(config[`state${slot}`] || "");
    if (details.trim() || state.trim()) variants.push({ details, state, slot });
  }
  return variants;
}

function rotationIntervalMs(config) {
  const seconds = Number(config.rotationInterval);
  return (ROTATION_INTERVALS.includes(seconds) ? seconds : DEFAULT_ROTATION_SECONDS) * 1000;
}

function timestampMs(value) {
  if (value instanceof Date) return value.getTime();
  return Number(value) || 0;
}

function buildActivity(config, options = {}) {
  const { startTimestamp, variant = 0, includeType = true } = options;
  validateButtons(config);
  validateImage(config.largeImageKey, "Imagem grande");
  validateImage(config.smallImageKey, "Imagem pequena");

  const activity = { instance: false };
  const type = ACTIVITY_TYPES[config.activityType] || 0;
  if (includeType && type) activity.type = type;

  const variants = textVariants(config);
  const text = variants[Math.abs(Math.trunc(variant)) % variants.length];
  const details = presenceText(text.details);
  if (details) activity.details = details;
  const state = presenceText(text.state);
  if (state) activity.state = state;

  const assets = {};
  const largeImage = String(config.largeImageKey || "").trim();
  if (largeImage) assets.large_image = largeImage;
  const largeText = presenceText(config.largeImageText);
  if (largeText) assets.large_text = largeText;
  const smallImage = String(config.smallImageKey || "").trim();
  if (smallImage) assets.small_image = smallImage;
  const smallText = presenceText(config.smallImageText);
  if (smallText) assets.small_text = smallText;
  if (Object.keys(assets).length) activity.assets = assets;

  const start = timestampMs(startTimestamp);
  if (config.showTimer && start > 0 && start <= MAX_UNIX_TIMESTAMP_MS) activity.timestamps = { start };

  const buttons = buildButtons(config);
  if (buttons.length) activity.buttons = buttons;
  return activity;
}

module.exports = {
  ACTIVITY_TYPES,
  buildActivity,
  buildButtons,
  isImageUrl,
  rotationIntervalMs,
  textVariants
};
