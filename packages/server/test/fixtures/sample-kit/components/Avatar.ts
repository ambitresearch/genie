export function Avatar({ src, alt, size }: { src: string; alt: string; size?: number }) {
  const s = size ?? 40;
  return `<img class="avatar" src="${src}" alt="${alt}" width="${s}" height="${s}" />`;
}
