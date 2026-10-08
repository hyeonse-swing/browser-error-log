import * as React from 'react';
import type { BrowserErrorLogClient } from 'browser-error-log';

export interface ErrorBoundaryProps {
  client: BrowserErrorLogClient;
  children: React.ReactNode;
  fallback?: React.ReactNode | ((error: Error, reset: () => void) => React.ReactNode);
}

interface ErrorBoundaryState { error: Error | null }

export class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    try {
      this.props.client.captureException(error, {
        type: 'react',
        componentStack: info.componentStack ?? undefined,
      });
    } catch { /* a diagnostics hook must not replace the render error */ }
  }

  private readonly reset = (): void => { this.setState({ error: null }); };

  render(): React.ReactNode {
    const error = this.state.error;
    if (!error) return this.props.children;
    return typeof this.props.fallback === 'function'
      ? this.props.fallback(error, this.reset)
      : (this.props.fallback ?? null);
  }
}
