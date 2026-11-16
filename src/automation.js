const { execFile } = require("child_process");

const MAX_RULES = 10;
const RULE_TYPES = ["process", "schedule"];
const DEFAULT_DAYS = [1, 2, 3, 4, 5];
const PROCESS_LIST_TIMEOUT_MS = 8000;

function clockMinutes(value) {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(value || "").trim());
  return match ? Number(match[1]) * 60 + Number(match[2]) : undefined;
}

function processKey(value) {
  const name = String(value || "").trim().replace(/^.*[\\/]/, "").toLowerCase();
  if (!name) return "";
  return name.endsWith(".exe") ? name : `${name}.exe`;
}

function normalizeRule(raw, profileCount) {
  const source = raw && typeof raw === "object" ? raw : {};
  const days = Array.isArray(source.days)
    ? [...new Set(source.days.map(Number).filter((day) => Number.isInteger(day) && day >= 0 && day <= 6))]
      .sort((left, right) => left - right)
    : DEFAULT_DAYS;

  return {
    enabled: source.enabled !== false,
    type: RULE_TYPES.includes(source.type) ? source.type : "process",
    process: typeof source.process === "string" ? source.process.trim().slice(0, 64) : "",
    days,
    start: clockMinutes(source.start) === undefined ? "09:00" : source.start.trim(),
    end: clockMinutes(source.end) === undefined ? "18:00" : source.end.trim(),
    profile: Math.min(Math.max(Math.trunc(Number(source.profile)) || 0, 0), profileCount - 1)
  };
}

function normalizeAutomationRules(raw, profileCount = 5) {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, MAX_RULES).map((rule) => normalizeRule(rule, profileCount));
}

// A window that ends before it starts runs overnight: 22:00 to 02:00 on a
// Friday still holds at 01:00 on Saturday.
function scheduleMatches(rule, now) {
  const start = clockMinutes(rule.start);
  const end = clockMinutes(rule.end);
  if (start === undefined || end === undefined) return false;

  const days = new Set(rule.days);
  const today = now.getDay();
  const minutes = now.getHours() * 60 + now.getMinutes();
  if (start === end) return days.has(today);
  if (start < end) return days.has(today) && minutes >= start && minutes < end;
  return (days.has(today) && minutes >= start) || (days.has((today + 6) % 7) && minutes < end);
}

function ruleMatches(rule, { now = new Date(), processes = new Set() } = {}) {
  if (!rule?.enabled) return false;
  if (rule.type === "schedule") return scheduleMatches(rule, now);
  const name = processKey(rule.process);
  return Boolean(name) && processes.has(name);
}

function matchingRule(rules, context) {
  const index = (rules || []).findIndex((rule) => ruleMatches(rule, context));
  return index < 0 ? undefined : { index, rule: rules[index] };
}

function needsProcessList(rules) {
  return (rules || []).some((rule) => rule.enabled && rule.type === "process" && processKey(rule.process));
}

function initialAutomationState() {
  return { lastKey: undefined, applied: undefined, base: undefined, seed: false };
}

// Acts only when the winning rule changes, so a profile picked by hand while
// a rule still holds is left alone; the previous profile comes back only if
// the one the rule chose is still live.
function automationStep(state, match, liveIndex) {
  const key = match ? String(match.rule.profile) : "";
  if (state.seed) return { state: { ...state, seed: false, lastKey: key }, action: undefined };
  if (key === state.lastKey) return { state, action: undefined };

  const next = { ...state, lastKey: key };
  if (match) {
    const target = match.rule.profile;
    if (next.applied === undefined) next.base = liveIndex;
    next.applied = target;
    return { state: next, action: liveIndex === target ? undefined : { profile: target, rule: match.rule } };
  }

  const restore = next.applied !== undefined
    && liveIndex === next.applied
    && next.base !== undefined
    && next.base !== next.applied;
  const action = restore ? { profile: next.base, restore: true } : undefined;
  next.applied = undefined;
  next.base = undefined;
  return { state: next, action };
}

function parseTasklist(output) {
  const names = new Set();
  for (const line of String(output || "").split(/\r?\n/)) {
    const match = /^"([^"]+)"/.exec(line.trim());
    if (match) names.add(match[1].toLowerCase());
  }
  return names;
}

function listProcesses({ run = execFile, platform = process.platform } = {}) {
  if (platform !== "win32") return Promise.resolve(new Set());
  return new Promise((resolve) => {
    run("tasklist.exe", ["/FO", "CSV", "/NH"], { windowsHide: true, timeout: PROCESS_LIST_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout) => resolve(error ? undefined : parseTasklist(stdout)));
  });
}

module.exports = {
  MAX_RULES,
  automationStep,
  initialAutomationState,
  listProcesses,
  matchingRule,
  needsProcessList,
  normalizeAutomationRules,
  parseTasklist,
  processKey,
  ruleMatches
};
