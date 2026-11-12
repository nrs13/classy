const IDLE_MS = 20_000;
export const CUT_LABEL = 'Connection lost. This answer may be incomplete.';
export const OFFLINE_LABEL = "You're offline. Chat will work again when you reconnect.";

export function readWithIdle(read, idleMs = IDLE_MS) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const err = new Error('idle');
      err.code = 'IDLE';
      reject(err);
    }, idleMs);
    Promise.resolve()
      .then(read)
      .then((value) => {
        clearTimeout(timer);
        resolve(value);
      })
      .catch((err) => {
        clearTimeout(timer);
        reject(err);
      });
  });
}

/** Yield text events. Throw CUT when the stream ends without a done event. */
export async function* readSseEvents(pull, { idleMs = IDLE_MS } = {}) {
  let buffer = '';
  let sawDone = false;
  while (true) {
    const { done, value } = await readWithIdle(() => pull(), idleMs);
    if (done) break;
    buffer += value;
    const lines = buffer.split('\n\n');
    buffer = lines.pop();
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      let event;
      try {
        event = JSON.parse(line.slice(6));
      } catch {
        continue;
      }
      if (event.type === 'done') {
        sawDone = true;
        return;
      }
      yield event;
    }
  }
  if (!sawDone) {
    const err = new Error('cut');
    err.code = 'CUT';
    throw err;
  }
}
