import { Component, type ReactNode } from 'react';

/** 画面の描画エラーでアプリ全体が真っ白にならないようにする。記録本文はログに出さない */
export class ErrorBoundary extends Component<{ children: ReactNode; resetKey: string }, { error: Error | null; key: string }> {
  state = { error: null as Error | null, key: this.props.resetKey };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  static getDerivedStateFromProps(props: { resetKey: string }, state: { error: Error | null; key: string }) {
    return props.resetKey !== state.key ? { error: null, key: props.resetKey } : null;
  }

  render() {
    if (this.state.error) {
      return (
        <div className="card warn-card">
          <h2>この画面を表示できませんでした</h2>
          <p className="small">保存済みの記録には影響ありません。別のタブに移るか、再読み込みしてください。</p>
          <p className="small muted">{this.state.error.name}</p>
          <div className="actions">
            <button className="btn" onClick={() => (location.hash = '#/today')}>今日へ</button>
            <button className="btn ghost" onClick={() => location.reload()}>再読み込み</button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
