export async function downloadRenderZip(): Promise<{ sizeBytes: number }> {
  const response = await fetch('/api/export-render', {
    method: 'GET',
    cache: 'no-store',
  });

  if (!response.ok) {
    let message = `El servidor devolvió un error (${response.status}).`;
    try {
      const data = (await response.json()) as { error?: string };
      if (data?.error) message = data.error;
    } catch {
      // Ignorar si no es JSON
    }
    throw new Error(message);
  }

  const buffer = await response.arrayBuffer();
  const bytes = new Uint8Array(buffer);

  // Verificar firma PK\x03\x04 para impedir guardar una página HTML como ZIP
  if (bytes.length < 22 || bytes[0] !== 0x50 || bytes[1] !== 0x4b) {
    throw new Error('La respuesta descargada no tiene formato ZIP válido.');
  }

  const blob = new Blob([bytes], { type: 'application/zip' });
  const url = URL.createObjectURL(blob);

  const link = document.createElement('a');
  link.href = url;
  link.download = 'StickerBot-Render.zip';
  link.rel = 'noopener';
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);

  setTimeout(() => {
    URL.revokeObjectURL(url);
  }, 10000);

  return { sizeBytes: bytes.byteLength };
}
