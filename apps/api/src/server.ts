import { createApp } from "./app";
import { loadConfig } from "./config";

const config = loadConfig();
const app = createApp({ config });

export default {
  port: config.PORT,
  fetch: app.fetch
};
