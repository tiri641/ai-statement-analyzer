import { deflateSync } from "node:zlib";

/**
 * 実在の明細を含まない、Bedrock接続確認用のSynthetic PNGです。
 * 実データやカード番号はFixtureへ追加しません。
 *
 * 外部バイナリをリポジトリへ置かず、テスト実行時に小さな文字画像を生成します。
 */
const WIDTH = 1_000;
const HEIGHT = 300;
const TEXT_SCALE = 4;

const FONT: Record<string, readonly string[]> = {
  " ": ["00000", "00000", "00000", "00000", "00000", "00000", "00000"],
  ".": ["00000", "00000", "00000", "00000", "00000", "00100", "00100"],
  "-": ["00000", "00000", "00000", "01110", "00000", "00000", "00000"],
  "0": ["01110", "10001", "10011", "10101", "11001", "10001", "01110"],
  "1": ["00100", "01100", "00100", "00100", "00100", "00100", "01110"],
  "2": ["01110", "10001", "00001", "00010", "00100", "01000", "11111"],
  "3": ["11110", "00001", "00001", "01110", "00001", "00001", "11110"],
  "4": ["00010", "00110", "01010", "10010", "11111", "00010", "00010"],
  "5": ["11111", "10000", "10000", "11110", "00001", "00001", "11110"],
  "6": ["01110", "10000", "10000", "11110", "10001", "10001", "01110"],
  "7": ["11111", "00001", "00010", "00100", "01000", "01000", "01000"],
  "8": ["01110", "10001", "10001", "01110", "10001", "10001", "01110"],
  "9": ["01110", "10001", "10001", "01111", "00001", "00001", "01110"],
  A: ["01110", "10001", "10001", "11111", "10001", "10001", "10001"],
  B: ["11110", "10001", "10001", "11110", "10001", "10001", "11110"],
  C: ["01111", "10000", "10000", "10000", "10000", "10000", "01111"],
  D: ["11110", "10001", "10001", "10001", "10001", "10001", "11110"],
  E: ["11111", "10000", "10000", "11110", "10000", "10000", "11111"],
  L: ["10000", "10000", "10000", "10000", "10000", "10000", "11111"],
  M: ["10001", "11011", "10101", "10101", "10001", "10001", "10001"],
  N: ["10001", "11001", "11001", "10101", "10011", "10011", "10001"],
  O: ["01110", "10001", "10001", "10001", "10001", "10001", "01110"],
  R: ["11110", "10001", "10001", "11110", "10100", "10010", "10001"],
  S: ["01111", "10000", "10000", "01110", "00001", "00001", "11110"],
  T: ["11111", "00100", "00100", "00100", "00100", "00100", "00100"],
  V: ["10001", "10001", "10001", "10001", "10001", "01010", "00100"],
  Y: ["10001", "10001", "01010", "00100", "00100", "00100", "00100"],
};

const concat = (...parts: Uint8Array[]): Uint8Array => {
  const result = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
};

const crc32 = (bytes: Uint8Array): number => {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
};

const pngChunk = (type: string, data: Uint8Array): Uint8Array => {
  const typeBytes = new TextEncoder().encode(type);
  const chunk = new Uint8Array(12 + data.length);
  const view = new DataView(chunk.buffer);
  view.setUint32(0, data.length);
  chunk.set(typeBytes, 4);
  chunk.set(data, 8);
  view.setUint32(8 + data.length, crc32(concat(typeBytes, data)));
  return chunk;
};

const drawText = (pixels: Uint8Array, text: string, x: number, y: number): void => {
  let cursorX = x;
  for (const character of text) {
    const glyph = FONT[character] ?? FONT[" "];
    if (!glyph) continue;
    for (let glyphY = 0; glyphY < glyph.length; glyphY += 1) {
      const row = glyph[glyphY];
      if (!row) continue;
      for (let glyphX = 0; glyphX < row.length; glyphX += 1) {
        if (row[glyphX] !== "1") continue;
        for (let pixelY = 0; pixelY < TEXT_SCALE; pixelY += 1) {
          for (let pixelX = 0; pixelX < TEXT_SCALE; pixelX += 1) {
            const targetX = cursorX + glyphX * TEXT_SCALE + pixelX;
            const targetY = y + glyphY * TEXT_SCALE + pixelY;
            const pixelOffset = (targetY * WIDTH + targetX) * 3;
            pixels[pixelOffset] = 20;
            pixels[pixelOffset + 1] = 20;
            pixels[pixelOffset + 2] = 20;
          }
        }
      }
    }
    cursorX += 6 * TEXT_SCALE;
  }
};

const createSyntheticStatementPng = (): Uint8Array => {
  const pixels = new Uint8Array(WIDTH * HEIGHT * 3);
  pixels.fill(248);

  // 明細らしい罫線を描画し、OCR対象の文字列を3行だけ配置します。
  for (let y = 18; y < HEIGHT; y += 44) {
    for (let x = 30; x < WIDTH - 30; x += 1) {
      const offset = (y * WIDTH + x) * 3;
      pixels[offset] = 190;
      pixels[offset + 1] = 190;
      pixels[offset + 2] = 190;
    }
  }
  drawText(pixels, "STATEMENT ANALYZER", 42, 42);
  drawText(pixels, "2026-08-20 AMAZON.CO.JP 3980", 42, 110);
  drawText(pixels, "2026-08-21 SEVEN ELEVEN 1200", 42, 178);

  const scanlines = new Uint8Array(HEIGHT * (1 + WIDTH * 3));
  for (let y = 0; y < HEIGHT; y += 1) {
    const scanlineOffset = y * (1 + WIDTH * 3);
    scanlines[scanlineOffset] = 0;
    scanlines.set(pixels.subarray(y * WIDTH * 3, (y + 1) * WIDTH * 3), scanlineOffset + 1);
  }

  const header = new Uint8Array(13);
  const headerView = new DataView(header.buffer);
  headerView.setUint32(0, WIDTH);
  headerView.setUint32(4, HEIGHT);
  header[8] = 8;
  header[9] = 2;

  return concat(
    Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(scanlines)),
    pngChunk("IEND", new Uint8Array()),
  );
};

export const SYNTHETIC_STATEMENT_PNG = createSyntheticStatementPng();
