import { Capacitor } from '@capacitor/core';

const LIMIT = 20 * 1024 * 1024;

export async function contentImageBlob(source, { fetcher = fetch } = {}) {
  let url;
  try { url = new URL(source); } catch { throw new Error('This image is not ready. Refresh the post and try again.'); }
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error('This image link cannot be shared. Refresh the post and try again.');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetcher(url.href, { signal: controller.signal, credentials: 'omit', referrerPolicy: 'no-referrer' });
    if (!response.ok) throw new Error('Could not download the image. Try again.');
    if (Number(response.headers.get('content-length')) > LIMIT) throw new Error('This image is too large to share. Choose a smaller photo.');
    const type = (response.headers.get('content-type') || '').split(';')[0];
    if (!/^image\/(jpeg|png|webp)$/.test(type)) throw new Error('This image format cannot be shared. Choose a JPEG or PNG photo.');
    const reader = response.body?.getReader();
    if (!reader) throw new Error('Could not download the image. Try again.');
    const chunks = []; let size = 0;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > LIMIT) { await reader.cancel(); throw new Error('This image is too large to share. Choose a smaller photo.'); }
      chunks.push(value);
    }
    if (!size) throw new Error('The image is empty. Refresh the post and try again.');
    return new Blob(chunks, { type });
  } catch (error) {
    if (error.name === 'AbortError') throw new Error('The image took too long to download. Check your connection and try again.');
    throw error;
  } finally { clearTimeout(timer); }
}

export async function shareContentImage(source) {
  const blob = await contentImageBlob(source);
  const extension = blob.type === 'image/jpeg' ? 'jpg' : blob.type.split('/')[1];
  const filename = `florrie-post-${crypto.randomUUID()}.${extension}`;
  if (Capacitor.isNativePlatform()) {
    const [{ Filesystem, Directory }, { Share }] = await Promise.all([import('@capacitor/filesystem'), import('@capacitor/share')]);
    const data = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(',')[1]);
      reader.onerror = () => reject(new Error('Could not prepare the image for sharing. Try again.'));
      reader.readAsDataURL(blob);
    });
    const saved = await Filesystem.writeFile({ path: filename, directory: Directory.Cache, data });
    try {
      await Share.share({ files: [saved.uri], title: 'Your post image', dialogTitle: 'Save or share your post image' });
      return { shared: true };
    } catch (error) {
      if (/cancel|dismiss/i.test(error.message || '')) return { cancelled: true };
      throw new Error('Could not open the share sheet. Try again.');
    } finally {
      // Share resolves after the receiving app has accepted the file.
      await Filesystem.deleteFile({ path: filename, directory: Directory.Cache }).catch(() => {});
    }
  }
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url; link.download = filename; link.rel = 'noopener';
  document.body.appendChild(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
  return { downloaded: true };
}
