export function createNoRerank() {
  return {
    name: 'none',
    async rerank(_query, candidates) {
      return candidates;
    },
  };
}
