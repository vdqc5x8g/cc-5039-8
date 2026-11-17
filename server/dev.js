// Start both servers for local development / manual testing.
import { createOriginServer, ORIGIN_PORT } from './origin.js';
import { createAppServer, APP_PORT } from './app.js';

createOriginServer().listen(ORIGIN_PORT, () => {
  console.log(`[origin] media origin on http://localhost:${ORIGIN_PORT}`);
});
createAppServer().listen(APP_PORT, () => {
  console.log(`[app] manager UI on http://localhost:${APP_PORT}`);
});
