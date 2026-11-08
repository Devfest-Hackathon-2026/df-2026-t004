// localStorage は、プライベートモードなどで使えないことがあるので必ず try で包む。
// 端末の表示の好み（案内を閉じた、など）だけに使い、世帯情報は保存しない。

export function readFlag(key: string): boolean {
  try {
    return window.localStorage.getItem(key) === "1";
  } catch {
    return false;
  }
}

export function writeFlag(key: string, value: boolean): void {
  try {
    if (value) window.localStorage.setItem(key, "1");
    else window.localStorage.removeItem(key);
  } catch {
    // 保存できなくても動作は続ける
  }
}
