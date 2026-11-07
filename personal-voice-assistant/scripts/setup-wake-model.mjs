#!/usr/bin/env node
/**
 * 音声呼びかけ（ウェイクワード）用の日本語音声認識モデルを準備する。
 *   npm run setup:wake
 * - 公式配布元（alphacephei.com）から Vosk 日本語小型モデル（約 48MB、Apache-2.0）をダウンロード
 * - 公開されている SHA-256 と一致することを確認（改ざん・破損対策）
 * - ブラウザ（vosk-browser）が読み込める .tar.gz 形式に変換して public/models/ に保存
 * モデルはこの PC 内でだけ使われ、音声が外部に送信されることはない。
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { unzipSync } from 'fflate';

const MODEL = 'vosk-model-small-ja-0.22';
const URL_ = `https://alphacephei.com/vosk/models/${MODEL}.zip`;
const SHA256 = 'efa092d280153a77615e9e0c7d7283e93e600de3d19d3bec686c57ef19d52eac';
const SIZE = 49_704_573;

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'public', 'models');
const outFile = path.join(outDir, `${MODEL}.tar.gz`);
const cacheZip = path.join(outDir, `${MODEL}.zip`);

function log(msg) {
  console.log(`[setup:wake] ${msg}`);
}

async function download() {
  if (existsSync(cacheZip) && sha256(readFileSync(cacheZip)) === SHA256) {
    log('ダウンロード済みのファイルを使います。');
    return readFileSync(cacheZip);
  }
  log(`ダウンロード中: ${URL_}（約 ${Math.round(SIZE / 1e6)}MB）`);
  const res = await fetch(URL_);
  if (!res.ok || !res.body) throw new Error(`ダウンロードに失敗しました（HTTP ${res.status}）`);
  const chunks = [];
  let got = 0;
  let lastPct = -1;
  for await (const chunk of res.body) {
    chunks.push(chunk);
    got += chunk.length;
    const pct = Math.floor((got / SIZE) * 100);
    if (pct % 10 === 0 && pct !== lastPct) {
      lastPct = pct;
      log(`  ${pct}%`);
    }
  }
  const buf = Buffer.concat(chunks);
  writeFileSync(cacheZip, buf);
  return buf;
}

function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

/** 最小限の tar（ustar）作成 */
function tarEntry(name, data, isDir) {
  const header = Buffer.alloc(512, 0);
  const nameBuf = Buffer.from(name, 'utf8');
  if (nameBuf.length > 100) {
    // 長いパスは prefix に分ける
    const idx = name.lastIndexOf('/', 154);
    header.write(name.slice(idx + 1), 0, 100, 'utf8');
    header.write(name.slice(0, idx), 345, 155, 'utf8');
  } else header.write(name, 0, 100, 'utf8');
  const oct = (n, len) => n.toString(8).padStart(len - 1, '0') + '\0';
  header.write(oct(isDir ? 0o755 : 0o644, 8), 100);
  header.write(oct(0, 8), 108);
  header.write(oct(0, 8), 116);
  header.write(oct(isDir ? 0 : data.length, 12), 124);
  header.write(oct(Math.floor(Date.now() / 1000), 12), 136);
  header.write('        ', 148);
  header.write(isDir ? '5' : '0', 156);
  header.write('ustar\0', 257);
  header.write('00', 263);
  let sum = 0;
  for (const b of header) sum += b;
  header.write(oct(sum, 7) + ' ', 148);
  const pad = isDir ? 0 : (512 - (data.length % 512)) % 512;
  return Buffer.concat([header, isDir ? Buffer.alloc(0) : Buffer.from(data), Buffer.alloc(pad)]);
}

async function main() {
  mkdirSync(outDir, { recursive: true });
  if (existsSync(outFile) && !process.argv.includes('--force')) {
    log(`準備済みです: ${path.relative(root, outFile)}（作り直す場合は --force）`);
    return;
  }
  const zip = await download();
  const digest = sha256(zip);
  if (digest !== SHA256) {
    rmSync(cacheZip, { force: true });
    throw new Error(`SHA-256 が一致しません（${digest}）。ダウンロードが壊れているか、配布元のファイルが変わっています。`);
  }
  log('SHA-256 一致を確認しました。');
  const files = unzipSync(new Uint8Array(zip));
  const parts = [];
  for (const [name, data] of Object.entries(files)) {
    // 安全確認：想定フォルダの外を指すパスは拒否
    const norm = path.posix.normalize(name);
    if (norm.startsWith('../') || path.posix.isAbsolute(norm) || !norm.startsWith(`${MODEL}/`)) {
      throw new Error(`不正なパスを含むため中止しました: ${name}`);
    }
    parts.push(tarEntry(norm, data, name.endsWith('/')));
  }
  parts.push(Buffer.alloc(1024, 0));
  writeFileSync(outFile, gzipSync(Buffer.concat(parts)));
  rmSync(cacheZip, { force: true });
  log(`完了: ${path.relative(root, outFile)}（${Object.keys(files).length} ファイル）`);
}

main().catch((e) => {
  console.error(`[setup:wake] エラー: ${e.message}${e.cause ? `（${e.cause.code ?? e.cause.message ?? e.cause}）` : ""}`);
  console.error("[setup:wake] ネットワーク接続を確認し、もう一度 npm run setup:wake を実行してください。");
  process.exit(1);
});
