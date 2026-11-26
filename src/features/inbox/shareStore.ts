// 共有メニューから受け取った内容の一時保管（public/share-target.js と同じ IndexedDB を読む）。
// アカウントの領域とは別なので、ログイン前やログインが切れていても失わない。登録したら消す。

export interface SharedFile {
  name: string;
  type: string;
  blob: Blob;
}

export interface PendingShare {
  id: string;
  receivedAt: string;
  title: string;
  text: string;
  url: string;
  files: SharedFile[];
}

const DB_NAME = 'itl-share';
const STORE = 'shares';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE, { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function run<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDb();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const req = fn(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(req.result);
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

export async function listShares(): Promise<PendingShare[]> {
  if (typeof indexedDB === 'undefined') return [];
  const all = await run<PendingShare[]>('readonly', (s) => s.getAll() as IDBRequest<PendingShare[]>);
  return all.sort((a, b) => a.receivedAt.localeCompare(b.receivedAt));
}

export async function getShare(id: string): Promise<PendingShare | undefined> {
  return run<PendingShare | undefined>('readonly', (s) => s.get(id) as IDBRequest<PendingShare | undefined>);
}

export async function putShare(rec: PendingShare): Promise<void> {
  await run('readwrite', (s) => s.put(rec));
}

export async function deleteShare(id: string): Promise<void> {
  await run('readwrite', (s) => s.delete(id));
  window.dispatchEvent(new Event('itl-shares-changed'));
}
