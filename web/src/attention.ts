// 裏にあるタブへの知らせ(14.2): タイトルの先頭の ● と、ブラウザの通知(設定で許可したときだけ)

export const UNSEEN_MARK = '● ';

/** ブラウザの通知を使えるか。自己署名証明書の接続などでは、ブラウザが通知を拒むので使えない */
export function notificationAvailable(): boolean {
  return typeof Notification !== 'undefined' && window.isSecureContext && Notification.permission !== 'denied';
}

/** 通知の許可を求める。許可されたら true */
export async function requestNotification(): Promise<boolean> {
  if (!notificationAvailable()) return false;
  if (Notification.permission === 'granted') return true;
  return (await Notification.requestPermission()) === 'granted';
}

/** 通知を出す。クリックするとタブを表に出す */
export function showNotification(title: string, body: string) {
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
  try {
    const n = new Notification(title, { body });
    n.onclick = () => {
      window.focus();
      n.close();
    };
  } catch {
    // 通知を出せない環境でも、タイトルの ● は付く
  }
}
