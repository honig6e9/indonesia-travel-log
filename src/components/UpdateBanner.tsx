import { useEffect, useState } from 'react';
import { useRegisterSW } from 'virtual:pwa-register/react';
import { useApp } from '../app/context';

/** Service Worker の登録・更新通知。録音中は更新を適用しない */
export function UpdateBanner() {
  const { recordingRef } = useApp();
  const [recording, setRecording] = useState(false);
  const {
    offlineReady: [offlineReady, setOfflineReady],
    needRefresh: [needRefresh],
    updateServiceWorker,
  } = useRegisterSW();

  useEffect(() => {
    const t = window.setInterval(() => setRecording(recordingRef.current), 1000);
    return () => window.clearInterval(t);
  }, [recordingRef]);

  if (offlineReady) {
    return (
      <div className="banner ok">
        オフラインで起動する準備ができました（アプリ本体をキャッシュしました）
        <button className="link" onClick={() => setOfflineReady(false)}>閉じる</button>
      </div>
    );
  }
  if (needRefresh) {
    return (
      <div className="banner">
        新しい版があります。
        {recording ? (
          <span>録音が終わってから更新できます</span>
        ) : (
          <button className="link" onClick={() => void updateServiceWorker(true)}>更新して再読み込み</button>
        )}
      </div>
    );
  }
  return null;
}
