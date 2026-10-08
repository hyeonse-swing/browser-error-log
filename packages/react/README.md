# @browser-error-log/react

A React Error Boundary for Browser Error Log. It forwards render errors and React component stacks to an existing browser SDK client, so React errors use the same collector and collection policies as the rest of your app.

**Release status:** unpublished source preview. Packages remain private and the open-source license is pending. The declared React peer range is `>=18 <20`; this range is not a claim of verification against every React version or framework.

## Install

In the source checkout, run `npm ci` and `npm run check:package` with Node.js 24. In your React app, install all three generated tarballs together, replacing the checkout path:

```sh
npm install /path/to/browser-error-log/output/packages/browser-error-log-protocol-0.1.0.tgz /path/to/browser-error-log/output/packages/browser-error-log-browser-0.1.0.tgz /path/to/browser-error-log/output/packages/browser-error-log-react-0.1.0.tgz
```

React must already be installed in your app. The adapter does not bundle React. After publication under these names, the equivalent registry command will be `npm install @browser-error-log/browser @browser-error-log/react`; it is not available for this preview.

## Use in your browser entry point

Start the repository's self-hosted collector with your app origin allowed:

```sh
MICRO_PROJECTS=my-web MICRO_ALLOWED_ORIGINS=http://localhost:5173 npm run micro
```

Initialize a client once in browser code, then wrap the part of the UI you want to protect:

```tsx
import { init } from '@browser-error-log/browser';
import { ErrorBoundary } from '@browser-error-log/react';

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

Open `http://127.0.0.1:4319/` to inspect collected events. For an externally accessible deployment, use your own HTTPS collector and the repository's `docs/micro-server.md` instructions. Never put the viewer password in browser code.

## Hosting and costs

There is no bundled hosted service. Each operator selects and pays for servers, databases, storage, bandwidth, domains, backups, and any other infrastructure or third-party services. Charges are billed independently by those providers, not by this project or its maintainers.
