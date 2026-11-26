import { downloadBlob } from '../lib/download';

/**
 * 作った ZIP の保存ボタン。
 * Android の Chrome の共有シートは ZIP を送れないため、ダウンロードしてから Files アプリでドライブへ送る手順を出す。
 */
export function SaveZipActions(props: { blob: Blob; name: string }) {
  return (
    <>
      <button className="btn primary" onClick={() => downloadBlob(props.blob, props.name)}>
        ダウンロード
      </button>
      <ol className="small steps">
        <li>「ダウンロード」を押します。</li>
        <li>「Files」（ファイル）アプリで「ダウンロード」フォルダを開きます。</li>
        <li>このファイルを長押しして、「共有」→「ドライブ」で保存します（PC に USB でつないでコピーしてもかまいません）。</li>
      </ol>
    </>
  );
}
