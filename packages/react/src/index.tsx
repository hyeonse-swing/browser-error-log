import * as React from 'react';
import { formatEventReference, type BrowserErrorLogClient, type BrowserErrorLogReferenceClient, type CaptureExtra, type EventReference } from '@ihyeon/browser-error-log';

export interface ErrorBoundaryProps {
  client: BrowserErrorLogClient & Partial<Pick<BrowserErrorLogReferenceClient, 'captureExceptionWithReference'>>;
  /** Called when a reference-aware client admits this render error to its queue. */
  onCapture?: (reference: EventReference) => void;
  children: React.ReactNode;
  fallback?: React.ReactNode | ((error: Error, reset: () => void, reference?: EventReference, referenceText?: string) => React.ReactNode);
}

interface ErrorBoundaryState { error: Error | null; reference?: EventReference }

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
    return { error: normalizeError(error), reference: undefined };
  }

  componentDidCatch(error: unknown, info: React.ErrorInfo): void {
    try {
      const { client, onCapture } = this.props;
      const extra: CaptureExtra = {
        type: 'react',
        componentStack: info.componentStack ?? undefined,
      };
      if ((onCapture || typeof this.props.fallback === 'function') && client.captureExceptionWithReference) {
        const reference = client.captureExceptionWithReference(error, extra);
        if (reference) {
          this.setState({ reference });
          onCapture?.(reference);
        }
      } else {
        client.captureException(error, extra);
      }
    } catch { /* a diagnostics hook must not replace the render error */ }
  }

  private readonly reset = (): void => { this.setState({ error: null, reference: undefined }); };

  render(): React.ReactNode {
    const error = this.state.error;
    if (!error) return this.props.children;
    return typeof this.props.fallback === 'function'
      ? this.props.fallback(error, this.reset, this.state.reference, formatEventReference(this.state.reference))
      : (this.props.fallback ?? null);
  }
}
