export function sanitizeAssistantText(text) {
  if (text == null || text === '') return text;
  let out = String(text);

  out = out.replace(/[\u2217\u204E\u2731\uFF0A\u066D]/g, '*');
  out = out.replace(/[\uFF3F\u02CD]/g, '_');

  out = out.replace(/\$\$[\s\S]*?\$\$/g, (block) => {
    const inner = block.slice(2, -2).trim();
    return inner.replace(/\\[a-zA-Z]+\{?([^}]*)\}?/g, '$1').replace(/[{}]/g, '');
  });
  out = out.replace(/\$([^$\n]+?)\$/g, '$1');

  out = out.replace(/^#{1,6}\s+/gm, '');
  out = out.replace(/^\s*([-*_]){3,}\s*$/gm, '');
  out = out.replace(/```[\w]*\n?([\s\S]*?)```/g, (_, inner) => inner.trim());
  out = out.replace(/\*{1,3}\s*([\d][\d,.\s]*[%×xX]?)\s*\*{1,3}/g, '$1');

  let prev;
  do {
    prev = out;
    out = out.replace(/\*\*\*([\s\S]+?)\*\*\*/g, '$1');
    out = out.replace(/\*\*([\s\S]+?)\*\*/g, '$1');
    out = out.replace(/___([\s\S]+?)___/g, '$1');
    out = out.replace(/__([\s\S]+?)__/g, '$1');
  } while (out !== prev);

  out = out.replace(/\*{2,}/g, '');
  out = out.replace(/_{2,}/g, '');

  do {
    prev = out;
    out = out.replace(/(^|[\s(])\*([^*\n]+?)\*([\s).,!?:;]|$)/g, '$1$2$3');
  } while (out !== prev);

  do {
    prev = out;
    out = out.replace(/(^|[\s(])_([^_\n]+?)_([\s).,!?:;]|$)/g, '$1$2$3');
  } while (out !== prev);

  out = out.replace(/\*+(?=[\w\d])/g, '');
  out = out.replace(/(?<=[\w\d])\*+/g, '');
  out = out.replace(/`([^`\n]+)`/g, '$1');
  out = out.replace(/`+/g, '');

  do {
    prev = out;
    out = out.replace(/\[\s*\](?:\([^)]*\))?/g, '');
    out = out.replace(/［\s*］(?:\([^)]*\))?/g, '');
    out = out.replace(/\[([^\]]+)\]\(\s*\)/g, '$1');
  } while (out !== prev);

  out = out.replace(
    /(?:^|\n)\s*(?:want me to |shall i |should i |can i |i can )?(?:pull|show|open|draw|make|generate|graph)\s+(?:this|that|it|them)?\s*(?:up\s+)?(?:as\s+)?(?:a\s+)?(?:chart|graph|visual)\??\.?\s*/gi,
    '\n',
  );
  out = out.replace(/\s*want me to pull this up as a chart\??\.?/gi, '');

  out = out.replace(/\s*[\u2014\u2013]\s*/g, '. ');
  out = out.replace(/\.\s*\./g, '.');
  out = out.replace(/[ \t]+\n/g, '\n');
  out = out.replace(/\n{3,}/g, '\n\n');
  out = out.replace(/(?:\s*\[\s*\])+\s*$/g, '');
  return out.trim();
}
