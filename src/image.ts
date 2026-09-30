export type ImageFormat = "png" | "jpeg" | "gif" | "webp";

export interface ImageInfo {
  format: ImageFormat;
  mime: string;
  width: number;
  height: number;
}

const MIME: Record<ImageFormat, string> = {
  png: "image/png",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
};

/** Reads format and pixel size from the file header, without decoding. */
export function imageInfo(b: Uint8Array): ImageInfo | null {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const ascii = (at: number, len: number) => String.fromCharCode(...b.subarray(at, at + len));
  const make = (format: ImageFormat, width: number, height: number) => ({ format, mime: MIME[format], width, height });

  if (b.length >= 24 && dv.getUint32(0) === 0x89504e47) {
    return make("png", dv.getUint32(16), dv.getUint32(20));
  }
  if (b.length >= 10 && ascii(0, 4) === "GIF8") {
    return make("gif", dv.getUint16(6, true), dv.getUint16(8, true));
  }
  if (b.length >= 30 && ascii(0, 4) === "RIFF" && ascii(8, 4) === "WEBP") {
    const kind = ascii(12, 4);
    if (kind === "VP8 ") return make("webp", dv.getUint16(26, true) & 0x3fff, dv.getUint16(28, true) & 0x3fff);
    if (kind === "VP8L") {
      const [b0, b1, b2, b3] = [b[21]!, b[22]!, b[23]!, b[24]!];
      return make("webp", 1 + (((b1 & 0x3f) << 8) | b0), 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6)));
    }
    if (kind === "VP8X") {
      const u24 = (at: number) => b[at]! | (b[at + 1]! << 8) | (b[at + 2]! << 16);
      return make("webp", 1 + u24(24), 1 + u24(27));
    }
    return null;
  }
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) {
        i++;
        continue;
      }
      const marker = b[i + 1]!;
      if (marker === 0xff) {
        i++;
        continue;
      }
      // SOF0..SOF15 carry the frame size (C4 DHT, C8 JPG, CC DAC are not frames).
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return make("jpeg", dv.getUint16(i + 7), dv.getUint16(i + 5));
      }
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
        i += 2;
        continue;
      }
      i += 2 + dv.getUint16(i + 2);
    }
  }
  return null;
}
