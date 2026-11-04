/** Web Share cannot share a local URI. Share a File, or use a browser download. */
export async function shareExport(
  bytes: ArrayBuffer,
  name: string,
  mimeType: string,
) {
  const file = new File([bytes], name, { type: mimeType });
  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: name });
      return;
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') return;
      // Some browsers lose user activation while downloading. The download remains available.
    }
  }
  const url = URL.createObjectURL(file);
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
