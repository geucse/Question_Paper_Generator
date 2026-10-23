import { Component } from 'react';

// Last line of defence (phase 4a): a rendering error shows a message with a way out instead of a blank screen.
// Details go to the browser console only; the screen never shows a stack trace.
export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    console.error('Screen failed to render:', error, info?.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="alert alert-error" role="alert" style={{ margin: 16 }}>
        <strong>This screen could not be shown.</strong> {this.state.error?.message ? `(${this.state.error.message})` : ''}
        <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
          <button className="btn-ghost btn-sm" onClick={() => this.setState({ error: null })}>Try again</button>
          <button className="btn-primary btn-sm" onClick={() => window.location.reload()}>Reload the page</button>
        </div>
      </div>
    );
  }
}
