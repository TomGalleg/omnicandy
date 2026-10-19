import { Component, type ReactNode } from 'react';

interface State { error: Error | null }

/** Keeps a render error from blanking the whole window: shows what happened and lets the user reload the view. */
export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: unknown): State {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  componentDidCatch(error: unknown) {
    console.error('CreateCraft view crashed:', error);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="notice" role="alert" style={{ margin: 24 }}>
        <strong>Something went wrong in this view.</strong>
        <p>{this.state.error.message}</p>
        <p>Your projects and files are safe. Reload the view to continue.</p>
        <button className="btn primary" onClick={() => window.location.reload()}>Reload this view</button>
      </div>
    );
  }
}
