import { Component } from 'react';
import { APP_FALLBACK, boundaryLog } from '../lib/boundary';
import { lastRequestId } from '../lib/requestId';

export class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { failed: false };
  }

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error) {
    console.error(boundaryLog(this.props.scope, error));
  }

  render() {
    if (!this.state.failed) return this.props.children;
    if (this.props.fallback) return this.props.fallback;
    const requestId = lastRequestId();
    return (
      <div className="app-error" role="alert">
        <p>{APP_FALLBACK}</p>
        {requestId ? <p className="app-error-id">Request id {requestId}</p> : null}
        <button type="button" onClick={() => window.location.reload()}>
          Reload
        </button>
      </div>
    );
  }
}
