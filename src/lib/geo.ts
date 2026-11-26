// 現在地を 1 回だけ取る（常時追跡はしない）。GPS は通信がなくても使える。

export interface Position {
  lat: number;
  lng: number;
  accuracy: number;
}

export function getCurrentPosition(timeoutMs = 20000): Promise<Position> {
  return new Promise((resolve, reject) => {
    if (!('geolocation' in navigator)) return reject(new Error('この端末では位置情報が使えません'));
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy }),
      (e) =>
        reject(
          new Error(
            e.code === e.PERMISSION_DENIED
              ? '位置情報が許可されていません。アドレスバーの鍵アイコン（サイトの設定）から「位置情報」を許可してください'
              : e.code === e.TIMEOUT
                ? '現在地を取れませんでした（時間切れ）。屋外や窓の近くでもう一度どうぞ'
                : '現在地を取れませんでした',
          ),
        ),
      { enableHighAccuracy: true, timeout: timeoutMs, maximumAge: 30_000 },
    );
  });
}

/** メモの「場所」に入れる文字（例：-6.137120,106.823450（±15m）） */
export function formatPosition(p: Position): string {
  return `${p.lat.toFixed(6)},${p.lng.toFixed(6)}（±${Math.round(p.accuracy)}m）`;
}

/** 「場所」に座標が入っていれば地図の URL を返す */
export function mapUrl(location: string | null | undefined): string | null {
  const m = location?.match(/(-?\d{1,2}\.\d+)\s*,\s*(-?\d{1,3}\.\d+)/);
  return m ? `https://www.google.com/maps/search/?api=1&query=${m[1]},${m[2]}` : null;
}
