import { useEffect, useState } from 'react';

export interface Route {
  name: 'today' | 'diary' | 'lists' | 'item' | 'history' | 'day' | 'settings' | 'conflicts' | 'interpret' | 'inbox' | 'share' | 'whatsapp';
  param: string | null;
  query: URLSearchParams;
}

export function parseHash(hash: string): Route {
  const raw = hash.replace(/^#\/?/, '');
  const [path, qs] = raw.split('?');
  const [name, param] = path.split('/');
  const query = new URLSearchParams(qs ?? '');
  const known: Route['name'][] = ['today', 'diary', 'lists', 'item', 'history', 'day', 'settings', 'conflicts', 'interpret', 'inbox', 'share', 'whatsapp'];
  return { name: known.includes(name as Route['name']) ? (name as Route['name']) : 'today', param: param ? decodeURIComponent(param) : null, query };
}

/** 録音中など、画面遷移を止めたいときに true を返す関数を登録する */
let guard: (() => string | null) | null = null;
export function setNavigationGuard(fn: (() => string | null) | null) {
  guard = fn;
}

let lastHash = typeof location !== 'undefined' ? location.hash : '';

export function navigate(to: string, opts: { replace?: boolean } = {}) {
  const msg = guard?.();
  if (msg) {
    window.dispatchEvent(new CustomEvent('itl-toast', { detail: msg }));
    return;
  }
  const h = to.startsWith('#') ? to : '#/' + to.replace(/^\//, '');
  if (opts.replace) history.replaceState(null, '', h);
  else history.pushState(null, '', h);
  lastHash = location.hash;
  window.dispatchEvent(new HashChangeEvent('hashchange'));
}

export function useRoute(): Route {
  const [route, setRoute] = useState(() => parseHash(location.hash));
  useEffect(() => {
    const on = () => {
      const msg = guard?.();
      if (msg && location.hash !== lastHash) {
        // 戻るボタンなどでの遷移を取り消す
        history.pushState(null, '', lastHash || '#/today');
        window.dispatchEvent(new CustomEvent('itl-toast', { detail: msg }));
        return;
      }
      lastHash = location.hash;
      setRoute(parseHash(location.hash));
    };
    window.addEventListener('hashchange', on);
    window.addEventListener('popstate', on);
    return () => {
      window.removeEventListener('hashchange', on);
      window.removeEventListener('popstate', on);
    };
  }, []);
  return route;
}
