'use strict';

function createBusinessHours(timeZone, openHour = 9, closeHour = 17, thresholdHours = 36) {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  });
  const thresholdSeconds = thresholdHours * 3600;

  function partsAt(timestamp) {
    return Object.fromEntries(formatter.formatToParts(new Date(timestamp)).map(part => [part.type, part.value]));
  }

  function localHourToUtc(year, month, day, hour) {
    const wanted = Date.UTC(year, month - 1, day, hour);
    let guess = wanted;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const parts = partsAt(guess);
      const represented = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute));
      const next = wanted - (represented - guess);
      if (next === guess) return next;
      guess = next;
    }
    return guess;
  }

  function secondsBetween(startMs, endMs) {
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return 0;
    if (endMs - startMs >= 14 * 24 * 60 * 60 * 1000) return thresholdSeconds;

    const first = partsAt(startMs);
    const last = partsAt(endMs);
    let day = Date.UTC(Number(first.year), Number(first.month) - 1, Number(first.day));
    const lastDay = Date.UTC(Number(last.year), Number(last.month) - 1, Number(last.day));
    let totalSeconds = 0;

    for (; day <= lastDay; day += 24 * 60 * 60 * 1000) {
      const date = new Date(day);
      const weekday = date.getUTCDay();
      if (weekday === 0 || weekday === 6) continue;
      const open = localHourToUtc(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate(), openHour);
      const close = localHourToUtc(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate(), closeHour);
      totalSeconds += Math.max(0, Math.min(endMs, close) - Math.max(startMs, open)) / 1000;
      if (totalSeconds >= thresholdSeconds) return thresholdSeconds;
    }
    return totalSeconds;
  }

  return { secondsBetween, thresholdSeconds };
}

module.exports = { createBusinessHours };