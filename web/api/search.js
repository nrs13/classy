import { rateLimit, route, searchParams } from '../server/http.js';
import { searchLibrary } from '../server/search/service.js';

export default route('search', { fallback: 'search_unavailable' }, async (req, res, { requestId }) => {
  rateLimit(req, { name: 'search', max: 60, windowMs: 10_000 });
  const params = searchParams(req);
  const body = await searchLibrary(
    {
      q: params.get('q') || '',
      lang: params.get('lang') || '',
      field: params.get('field') || '',
      account: params.get('account') || '',
      limit: params.get('limit') || 20,
      mode: params.get('mode') === 'exact' ? 'exact' : 'auto',
      examples: params.get('examples') === '1',
      understand: params.get('understand') !== '0',
    },
    { requestId },
  );
  const { timing, ...publicBody } = body;
  if (timing) {
    res.setHeader(
      'Server-Timing',
      Object.entries(timing)
        .map(([name, ms]) => `${name};dur=${ms}`)
        .join(', '),
    );
  }
  res.setHeader('Cache-Control', 'no-store');
  res.status(200).json(publicBody);
});
