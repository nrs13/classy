import { route } from '../server/http.js';

export default route('health', { methods: ['GET'], fallback: 'library_unavailable' }, async (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.status(200).json({ ok: true });
});
