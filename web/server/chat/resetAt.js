/** Next midnight in America/Los_Angeles, as an ISO UTC timestamp. */
function pacificParts(instant) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
  const bag = {};
  for (const part of fmt.formatToParts(new Date(instant))) {
    if (part.type !== 'literal') bag[part.type] = part.value;
  }
  let hour = Number(bag.hour);
  let day = Number(bag.day);
  let month = Number(bag.month);
  let year = Number(bag.year);
  if (hour === 24) {
    hour = 0;
    const rolled = new Date(Date.UTC(year, month - 1, day));
    rolled.setUTCDate(rolled.getUTCDate() + 1);
    year = rolled.getUTCFullYear();
    month = rolled.getUTCMonth() + 1;
    day = rolled.getUTCDate();
  }
  return { year, month, day, hour, minute: Number(bag.minute), second: Number(bag.second) };
}

function utcFromPacific(year, month, day, hour, minute, second) {
  let utc = Date.UTC(year, month - 1, day, hour, minute, second);
  for (let i = 0; i < 3; i += 1) {
    const got = pacificParts(utc);
    const gotUtc = Date.UTC(got.year, got.month - 1, got.day, got.hour, got.minute, got.second);
    const want = Date.UTC(year, month - 1, day, hour, minute, second);
    utc += want - gotUtc;
  }
  return utc;
}

export function nextPacificMidnight(now) {
  const parts = pacificParts(now);
  const cursor = new Date(Date.UTC(parts.year, parts.month - 1, parts.day));
  cursor.setUTCDate(cursor.getUTCDate() + 1);
  const utc = utcFromPacific(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, cursor.getUTCDate(), 0, 0, 0);
  return new Date(utc).toISOString();
}
