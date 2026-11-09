/**
 * 記憶データの保存先（ユーザー専用のローカルデータ領域）。アプリのフォルダの外に置くため、
 * 新しい ZIP を展開し直しても記憶は消えない。GitHub にも含まれない。
 *
 *   Windows : %LOCALAPPDATA%\KAITO          （例: C:\Users\名前\AppData\Local\KAITO）
 *   macOS   : ~/Library/Application Support/KAITO
 *   Linux 等: $XDG_DATA_HOME/kaito または ~/.local/share/kaito
 *   上書き   : 環境変数 KAITO_DATA_DIR（.env で指定可）
 */
import os from 'node:os';
import path from 'node:path';

export interface DataDirInput {
  env: Record<string, string | undefined>;
  platform: NodeJS.Platform;
  homedir: string;
}

export function resolveDataDir(i: DataDirInput = { env: process.env, platform: process.platform, homedir: os.homedir() }): string {
  const custom = i.env.KAITO_DATA_DIR?.trim();
  if (custom) return path.resolve(custom);
  if (i.platform === 'win32') {
    const base = i.env.LOCALAPPDATA?.trim() || path.win32.join(i.homedir, 'AppData', 'Local');
    return path.win32.join(base, 'KAITO');
  }
  if (i.platform === 'darwin') return path.posix.join(i.homedir, 'Library', 'Application Support', 'KAITO');
  const xdg = i.env.XDG_DATA_HOME?.trim();
  return path.posix.join(xdg || path.posix.join(i.homedir, '.local', 'share'), 'kaito');
}

/** 保存先がアプリのフォルダの中にある（ZIP 更新で消える可能性がある）か */
export function isInsideApp(dataDir: string, appDir: string): boolean {
  const rel = path.relative(path.resolve(appDir), path.resolve(dataDir));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}
