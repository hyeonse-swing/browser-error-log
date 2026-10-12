import * as React from 'react';
import type { BrowserErrorLogClient } from 'browser-error-log';

export interface ErrorBoundaryProps {
  client: BrowserErrorLogClient;
  children: React.ReactNode;
  fallback?: React.ReactNode | ((error: Error, reset: () => void) => React.ReactNode);
}

interface ErrorBoundaryState { error: Error | null }

function normalizeError(error: unknown): Error {
  try {
    return error instanceof Error ? error : new Error(String(error));
  } catch {
    return new Error('Unknown render error');
  }
}

export class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: unknown): ErrorBoundaryState {
    return { error: normalizeError(error) };
  }

  componentDidCatch(error: unknown, info: React.ErrorInfo): void {
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
