function parseVersion(value) {
  const match = String(value || "")
    .trim()
    .replace(/^v/i, "")
    .toLowerCase()
    .match(/^(\d+)\.(\d+)\.(\d+)(?:[-.]?(alpha|a|beta|b|rc)(?:[-.]?(\d+))?)?$/);

  if (!match) return undefined;
  const channelRanks = { a: 1, alpha: 1, b: 2, beta: 2, rc: 3 };
  return {
    numbers: match.slice(1, 4).map(Number),
    channel: match[4] ? channelRanks[match[4]] : 4,
    iteration: match[4] ? Number(match[5] || 1) : 0
  };
}

function compareVersions(currentValue, latestValue) {
  const current = parseVersion(currentValue);
  const latest = parseVersion(latestValue);
  if (!current || !latest) return 0;

  for (let index = 0; index < 3; index += 1) {
    if (latest.numbers[index] !== current.numbers[index]) {
      return latest.numbers[index] > current.numbers[index] ? 1 : -1;
    }
  }

  if (latest.channel !== current.channel) return latest.channel > current.channel ? 1 : -1;
  if (latest.iteration !== current.iteration) return latest.iteration > current.iteration ? 1 : -1;
  return 0;
}

module.exports = { compareVersions, parseVersion };
