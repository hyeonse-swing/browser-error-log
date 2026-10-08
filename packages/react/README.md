# browser-error-log-react

A React Error Boundary for Browser Error Log. It forwards render errors and React component stacks to an existing browser SDK client, so React errors use the same collector and collection policies as the rest of your app.

The declared React peer range is `>=18 <20`; this range is not a claim of verification against every React version or framework.

## Install

In a React app, install the browser SDK and adapter:

```sh
npm install browser-error-log browser-error-log-react
```

React must already be installed in your app. The adapter does not bundle React. For local source-checkout tarballs before publication, follow the [SDK guide](https://github.com/hyeonse-swing/browser-error-log/blob/main/docs/personal-sdk.md) to install protocol, browser, and React tarballs together.

## Use in your browser entry point

Start the repository's self-hosted collector with your app origin allowed:

```sh
MICRO_PROJECTS=my-web MICRO_ALLOWED_ORIGINS=http://localhost:5173 npm run micro
```

Initialize a client once in browser code, then wrap the part of the UI you want to protect:

```tsx
import { init } from 'browser-error-log';
import { ErrorBoundary } from 'browser-error-log-react';

const errorLog = init({
  project: 'my-web',
  endpoint: 'http://127.0.0.1:4319/api/events',
  environment: 'development',
  release: 'my-release',
});

export function Root() {
  return (
    <ErrorBoundary
      client={errorLog}
      fallback={(_error, reset) => (
        <section>
          <p>This view could not be displayed.</p>
          <button onClick={reset}>Try again</button>
        </section>
      )}
    >
      <App />
    </ErrorBoundary>
  );
}
```

`App` above is your application component. The fallback can be a React node or a function receiving the error and a reset callback. Reset clears the boundary's error state and retries rendering its children; fix the underlying state if rendering would fail again. With no fallback, a failed boundary renders nothing.

Use a client entry point in SSR frameworks. Importing the SDK on the server is safe but does not collect server errors. This boundary handles errors React passes to `componentDidCatch`; use `captureException` for handled errors and the base SDK for global JavaScript, promise, and network error capture. It is not native crash monitoring or a server-side error handler.

Open `http://127.0.0.1:4319/` to inspect collected events. For an externally accessible deployment, use your own HTTPS collector and the [self-hosting guide](https://github.com/hyeonse-swing/browser-error-log/blob/main/docs/micro-server.md). Never put the viewer password in browser code.

## Hosting and costs

Infrastructure is not included. Hosting, servers, databases, storage, bandwidth, domains, backups, and third-party services are selected and paid for by each operator. Any charges are billed independently by their providers, not by this project or its maintainers.
