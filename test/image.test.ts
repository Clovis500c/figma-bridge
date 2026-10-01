import { describe, expect, test } from "bun:test";
import { imageInfo } from "../src/image";

const bytes = (...parts: (number[] | string)[]) =>
  new Uint8Array(parts.flatMap((p) => (typeof p === "string" ? [...p].map((c) => c.charCodeAt(0)) : p)));
const u32be = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const u16be = (n: number) => [(n >> 8) & 255, n & 255];
const u16le = (n: number) => [n & 255, (n >> 8) & 255];
const u24le = (n: number) => [n & 255, (n >> 8) & 255, (n >> 16) & 255];

describe("imageInfo", () => {
  test("PNG", () => {
    const png = bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], u32be(13), "IHDR", u32be(1920), u32be(1080), [8, 6, 0, 0, 0]);
    expect(imageInfo(png)).toEqual({ format: "png", mime: "image/png", width: 1920, height: 1080 });
  });

  test("GIF", () => {
    expect(imageInfo(bytes("GIF89a", u16le(320), u16le(240), [0, 0, 0]))).toEqual({ format: "gif", mime: "image/gif", width: 320, height: 240 });
  });

  test("JPEG skips segments before the frame header", () => {
    const app0 = [0xff, 0xe0, ...u16be(16), ...new Array(14).fill(0)];
    const dqt = [0xff, 0xdb, ...u16be(4), 0, 0];
    const sof2 = [0xff, 0xc2, ...u16be(17), 8, ...u16be(600), ...u16be(800), 3, ...new Array(9).fill(0)];
    expect(imageInfo(bytes([0xff, 0xd8], app0, dqt, sof2))).toEqual({ format: "jpeg", mime: "image/jpeg", width: 800, height: 600 });
  });

  test("JPEG ignores DHT (C4), which is not a frame header", () => {
    const dht = [0xff, 0xc4, ...u16be(5), 0, 0, 0];
    const sof0 = [0xff, 0xc0, ...u16be(17), 8, ...u16be(10), ...u16be(20), 3, ...new Array(9).fill(0)];
    expect(imageInfo(bytes([0xff, 0xd8], dht, sof0))?.width).toBe(20);
  });

  test("WEBP lossy (VP8)", () => {
    const webp = bytes("RIFF", [0, 0, 0, 0], "WEBP", "VP8 ", [0, 0, 0, 0], [0, 0, 0], [0x9d, 0x01, 0x2a], u16le(640), u16le(480));
    expect(imageInfo(webp)).toEqual({ format: "webp", mime: "image/webp", width: 640, height: 480 });
  });

  test("WEBP lossless (VP8L)", () => {
    // 14-bit width-1 and height-1, little-endian bit packed after the 0x2f signature.
    const w = 400 - 1;
    const h = 300 - 1;
    const bits = w | (h << 14);
    const webp = bytes("RIFF", [0, 0, 0, 0], "WEBP", "VP8L", [0, 0, 0, 0], [0x2f], [bits & 255, (bits >> 8) & 255, (bits >> 16) & 255, (bits >>> 24) & 255], new Array(8).fill(0));
    expect(imageInfo(webp)).toMatchObject({ format: "webp", width: 400, height: 300 });
  });

  test("WEBP extended (VP8X)", () => {
    const webp = bytes("RIFF", [0, 0, 0, 0], "WEBP", "VP8X", [10, 0, 0, 0], [0, 0, 0, 0], u24le(5000 - 1), u24le(3000 - 1));
    expect(imageInfo(webp)).toMatchObject({ format: "webp", width: 5000, height: 3000 });
  });

  test("unknown or truncated data", () => {
    expect(imageInfo(bytes("<svg></svg>"))).toBeNull();
    expect(imageInfo(bytes([0x89, 0x50, 0x4e, 0x47]))).toBeNull();
    expect(imageInfo(new Uint8Array(0))).toBeNull();
    expect(imageInfo(bytes("RIFF", [0, 0, 0, 0], "WEBP", "ABCD", new Array(20).fill(0)))).toBeNull();
  });

  test("works on a subarray view", () => {
    const png = bytes([1, 2, 3], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], u32be(13), "IHDR", u32be(7), u32be(9));
    expect(imageInfo(png.subarray(3))).toMatchObject({ width: 7, height: 9 });
  });
});
