# CI registration for a self-hosted viewer

Give each deployed build an immutable release ID. Use the same project, environment and release when initializing the browser SDK and when registering artifacts. An error frame also needs the deployed asset origin and full path. Two releases can serve different files at the same URL.

## Collector

Run this revision of the micro-server with SQLite storage. Set `MICRO_PROJECTS` to the accepted project IDs, set `MICRO_VIEWER_PASSWORD` for viewer access, and supply a separate random `MICRO_SOURCE_MAP_TOKEN` of 32–256 printable non-space ASCII characters from secret storage. Use `MICRO_DATA_DIR` on a persistent private volume outside the served directory. Use HTTPS at the public origin and set `MICRO_PUBLIC_URL` for the reverse proxy. Loopback HTTP works for a local check. [Server setup](../examples/micro-server/.env.example)

The CI secret `BEL_SOURCE_MAP_TOKEN` must match `MICRO_SOURCE_MAP_TOKEN`. Keep it out of browser environment variables and client bundles. The viewer uses its existing login to read maps. Anyone with access to that viewer can inspect registered source content across its configured projects.

## Run after building the application

Generate regular v3 maps next to their emitted JavaScript. For example, Vite's `build.sourcemap: 'hidden'` emits separate map files. Preserve the original files through registration. Publish the JS to your CDN and exclude private map files from its public upload. Include `sourcesContent` in a map to show the original code. An external map without source text still supports line and column mapping.

Add this step to the application's existing deployment job after bundling. Replace `<commit-sha>` with a revision of this repository that contains the action. The example assumes the SDK release is the workflow commit SHA.

```yaml
- name: Register release source maps
  uses: hyeonse-swing/browser-error-log/.github/actions/register-source-maps@<commit-sha>
  with:
    build-dir: dist/assets
    asset-base-url: https://cdn.example.com/assets/
    collector-url: https://errors.example.com
    project: my-web
    environment: production
    release: ${{ github.sha }}
    token: ${{ secrets.BEL_SOURCE_MAP_TOKEN }}
```

For other CI providers, use Node 24 and run the script from a checkout of the same revision. The build directory and URL below correspond to each other, so `dist/assets/chunks/cart.js` registers as `https://cdn.example.com/assets/chunks/cart.js`.

```sh
node /path/to/browser-error-log/scripts/register-source-maps.mjs \
  --build-dir dist/assets --asset-base-url https://cdn.example.com/assets/ \
  --collector-url https://errors.example.com \
  --project my-web --environment production --release "$BUILD_ID"
```

The command discovers .js, .mjs and .cjs bundles with sibling .map files below the build directory and computes both SHA-256 hashes. Identical uploads are safe to repeat, including after a job stops partway. The collector returns 201 for a new map, 200 for a duplicate and 409 if the same key already identifies different bytes. For a changed build, assign a new SDK release and register its artifacts under that release. Registration is per asset. If the collector rejects a later chunk, earlier accepted chunks remain available. Correct the rejected artifact, retain previously accepted files byte-for-byte and rerun the job. If rebuilding changes any accepted files, give the entire build a fresh release ID. Deploy the application only after the job succeeds.

## Inspect an error

Open a live event in the self-hosted timeline or dashboard. The viewer reads maps only from its authenticated collector, checks the scope and map digest, and resolves JavaScript and React component frames separately. Expand **View source** on a mapped frame to inspect the surrounding source and highlighted one-based column. React frames that contain only names retain those names. With missing or oversized embedded source, the viewer can still show the mapped coordinates. For scripts with cache queries, the SDK in this revision preserves positions corroborated by a script URL the browser observed and strips the query. An event already stored without a line or column keeps its unmapped reason. Event JSON exports contain the original event. The hosted archive and imported event files use manual, tab-local map registration.

Each map is limited to 8 MiB. One CI invocation accepts up to 32 map files. A viewer detail considers up to 32 distinct generated asset URLs. The collector rejects a request that exceeds registry capacity with HTTP 507.

The collector keeps registrations in `source-maps.sqlite` in the data directory, with separate limits of 32 entries, 32 MiB of map bytes, one million mapping segments and a 48 MiB SQLite file. Event retention and JSON exports operate on the event store. When retiring a release, stop the collector and back up the registry file. In that database, list the exact scope and remove just the retired release. For example, after checking that the values are correct:

```sql
SELECT project, environment, release, COUNT(*) FROM source_maps GROUP BY project, environment, release;
DELETE FROM source_maps WHERE project = 'my-web' AND environment = 'production' AND release = 'retired-build';
```

Restart the collector and rerun the registration job. Events from the retired build can still be read and manually mapped using its archived artifacts.
