const SAFE_ID = /^[A-Za-z0-9_-]{8,64}$/;

let remembered = '';

export function rememberRequestId(value) {
  const id = String(value || '');
  if (SAFE_ID.test(id)) remembered = id;
}

export function lastRequestId() {
  return remembered;
}

export function requestIdFromResponse(response) {
  const get = response?.headers?.get;
  if (typeof get !== 'function') return;
  rememberRequestId(get.call(response.headers, 'x-request-id'));
}
