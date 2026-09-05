function normalizeProcessList(parsed) {
  return (Array.isArray(parsed) ? parsed : [parsed]).filter(Boolean).map(item => ({
    name: item.name,
    path: item.path || '',
    title: item.title || item.name,
    windowClass: item.windowClass || '',
    isFullscreen: item.isFullscreen === true,
    isForeground: item.isForeground === true,
    bounds: item.bounds ? {
      x: Number(item.bounds.x),
      y: Number(item.bounds.y),
      width: Number(item.bounds.width),
      height: Number(item.bounds.height)
    } : null
  }));
}

function parseProcessList(stdout) {
  const cleaned = String(stdout || '[]').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');
  return normalizeProcessList(JSON.parse(cleaned));
}

module.exports = { parseProcessList };
