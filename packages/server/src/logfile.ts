/**
 * Line logs in data/logs/ (every model call, build costs) that stay a bounded size: past 100 MB a file becomes
 * `<name>.1.jsonl` (the older ones `.2`, `.3`), and the oldest is deleted.
 */
import fs from 'node:fs';

const MAX_BYTES = 100 * 1024 * 1024;
const KEEP_OLD = 3;
const sizes = new Map<string, number>();

const older = (file: string, n: number) => file.replace(/(\.\w+)?$/, (ext) => `.${n}${ext}`);

export function appendLine(file: string, line: string) {
  let size = sizes.get(file);
  if (size === undefined) {
    try {
      size = fs.statSync(file).size;
    } catch {
      size = 0;
    }
  }
  if (size > MAX_BYTES) {
    try {
      fs.rmSync(older(file, KEEP_OLD), { force: true });
      for (let n = KEEP_OLD - 1; n >= 1; n--) if (fs.existsSync(older(file, n))) fs.renameSync(older(file, n), older(file, n + 1));
      fs.renameSync(file, older(file, 1));
    } catch {
      /* another process rotated it first */
    }
    size = 0;
  }
  sizes.set(file, size + Buffer.byteLength(line) + 1);
  fs.appendFile(file, `${line}\n`, () => {});
}
