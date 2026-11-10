export function datasetSize(source) {
  if (Array.isArray(source)) return source.length;
  if (Array.isArray(source?.videos)) return source.videos.length;
  return 0;
}
