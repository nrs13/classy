import { errorBody } from '../server/obs/errors.js';
import { requestIdFrom } from '../server/obs/log.js';

export default function handler(req, res) {
  const requestId = requestIdFrom(req);
  const body = errorBody(requestId, 'unknown_route');
  res.status(404).json(body);
}
